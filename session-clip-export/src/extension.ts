// Session Clip Export — renders Session View audio clips to WAV files,
// preserving each clip's loop length at the current song tempo, peak-normalizing
// to -1 dBFS, and writing 24-bit WAVs named after the clips (duplicates numbered).
// Optionally also separates each exported clip into stems (drums/bass/vocals/other)
// via a locally installed demucs.
//
// How the render works: renderPreFxAudio only renders the *arrangement*, so for
// each session clip we recreate it briefly on its own track's arrangement (past
// any existing content), render exactly one loop's worth of beats pre-FX, then
// delete the temporary clip again — the set is left exactly as it was.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import decodeAudio from "audio-decode";
import {
  initialize,
  type ActivationContext,
  type ClipLoopSettings,
  type ClipSlotSelection,
  type Handle,
  AudioClip,
  AudioTrack,
  ClipSlot,
} from "@ableton-extensions/sdk";

import { copyAnywhere, ensureDir, scratchBase, setTempBase, writeFileAnywhere } from "./fsx.js";
import { decodePcm } from "./pcm.js";
import { encodeWav24, normalize } from "./wav.js";

const execFileAsync = promisify(execFile);

const STEM_NAMES = ["drums", "bass", "vocals", "other"];
const DEMUCS_TIMEOUT_MS = 10 * 60 * 1000;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  setTempBase(context.environment.tempDirectory);
  type Ctx = typeof context;

  const register = (id: string, run: (ctx: Ctx, arg: unknown) => Promise<void>) => {
    context.commands.registerCommand(id, (arg: unknown) => {
      void run(context, arg).catch((err) => {
        console.error(`[session-clip-export] ${id} failed: ${String(err)}`);
      });
    });
  };

  register("session-clip-export.export-all", (ctx) =>
    exportJobs(ctx, collectAllJobs(ctx), { stems: false }));
  register("session-clip-export.export-all-stems", (ctx) =>
    exportJobs(ctx, collectAllJobs(ctx), { stems: true }));
  register("session-clip-export.export-selected", (ctx, arg) =>
    exportJobs(ctx, collectSelectedJobs(ctx, arg), { stems: false }));
  register("session-clip-export.export-selected-stems", (ctx, arg) =>
    exportJobs(ctx, collectSelectedJobs(ctx, arg), { stems: true }));

  // Scene header → whole session grid; selected slots → just the selection.
  void context.ui.registerContextMenuAction(
    "Scene", "Export Session Clips to WAV", "session-clip-export.export-all");
  void context.ui.registerContextMenuAction(
    "Scene", "Export Session Clips + Stems", "session-clip-export.export-all-stems");
  void context.ui.registerContextMenuAction(
    "ClipSlotSelection", "Export Selected Clips to WAV", "session-clip-export.export-selected");
  void context.ui.registerContextMenuAction(
    "ClipSlotSelection", "Export Selected Clips + Stems", "session-clip-export.export-selected-stems");
}

type ExportContext = ReturnType<typeof initialize<"1.0.0">>;

interface Job {
  track: AudioTrack<"1.0.0">;
  clip: AudioClip<"1.0.0">;
}

interface Collected {
  jobs: Job[];
  skipped: number; // clips we can't render (MIDI, or slot on a non-audio track)
}

/** Every session-view audio clip, in track order then scene order. */
function collectAllJobs(context: ExportContext): Collected {
  const jobs: Job[] = [];
  let skipped = 0;
  for (const track of context.application.song.tracks) {
    for (const slot of track.clipSlots) {
      const clip = slot.clip;
      if (clip === null) continue;
      if (track instanceof AudioTrack && clip instanceof AudioClip) {
        jobs.push({ track, clip });
      } else {
        skipped++;
      }
    }
  }
  return { jobs, skipped };
}

/** The audio clips inside a ClipSlotSelection (multi-select + right-click). */
function collectSelectedJobs(context: ExportContext, arg: unknown): Collected {
  const selection = arg as ClipSlotSelection;
  const handles: Handle[] = selection?.selected_clip_slots ?? [];
  const jobs: Job[] = [];
  let skipped = 0;
  for (const handle of handles) {
    try {
      const slot = context.getObjectFromHandle(handle, ClipSlot);
      const clip = slot.clip;
      if (clip === null) continue; // empty slots in the selection are fine
      const track = slot.parent;
      if (track instanceof AudioTrack && clip instanceof AudioClip) {
        jobs.push({ track, clip });
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[session-clip-export] could not resolve a selected slot: ${String(err)}`);
      skipped++;
    }
  }
  return { jobs, skipped };
}

async function exportJobs(
  context: ExportContext,
  { jobs, skipped }: Collected,
  options: { stems: boolean },
) {
  if (jobs.length === 0) {
    console.info("[session-clip-export] no session audio clips to export"
      + (skipped > 0 ? ` (${skipped} non-audio clip(s) in scope)` : ""));
    return;
  }

  const demucs = options.stems ? await findDemucs() : null;
  if (options.stems && demucs === null) {
    console.error(
      "[session-clip-export] stems requested but demucs was not found — " +
      "install it with `pipx install demucs` (or `pip3 install demucs`) and retry. " +
      "Exporting clips without stems.");
  }

  // Let the user pick the destination with the native macOS folder chooser
  // (osascript). Cancel aborts the export; the last choice is remembered.
  const baseDir = await chooseOutputDir(context);
  if (baseDir === null) {
    console.info("[session-clip-export] export canceled (no folder chosen)");
    return;
  }

  const exportOpts = await optionsDialog(context);
  if (exportOpts === null) {
    console.info("[session-clip-export] export canceled (options dialog)");
    return;
  }

  const tempo = context.application.song.tempo;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
  const outDir = path.join(baseDir, `Session Clips ${Math.round(tempo)}bpm ${stamp}`);
  await ensureDir(outDir);

  const nameCounts = new Map<string, number>();
  let exported = 0;

  // Render on a dedicated temporary audio track: a fresh track can't be
  // frozen, session-overridden, or carry any other state that might make Live
  // refuse arrangement rendering on the clip's own track. Deleted afterwards.
  const song = context.application.song;
  const renderTrack = await song.createAudioTrack();
  renderTrack.name = "· clip export (temp)";
  try {
    await context.ui.withinProgressDialog(
      `Exporting ${jobs.length} session clip(s)…`,
      { progress: 0 },
      async (update, abortSignal) => {
        for (const [i, job] of jobs.entries()) {
          abortSignal.throwIfAborted();
          const label = job.clip.name.trim() || "Untitled";
          const pct = (i / jobs.length) * 100;
          await update(`Exporting "${label}" (${i + 1}/${jobs.length})`, pct);
          try {
            const wavPath = await renderOneLoop(context, job, renderTrack);
            const base = numberedBase(nameCounts, label);
            const clipOut = path.join(outDir, `${base}.wav`);
            await normalizeAndWrite(wavPath, clipOut, exportOpts.normalize);
            if (demucs !== null) {
              abortSignal.throwIfAborted();
              await update(`Separating stems for "${label}" (${i + 1}/${jobs.length})`, pct);
              try {
                await separateStems(demucs, clipOut, outDir, base);
              } catch (err) {
                // The clip itself exported fine — report the stems failure separately.
                console.error(
                  `[session-clip-export] stems failed for "${label}": ${describeErr(err)}`);
              }
            }
            exported++;
          } catch (err) {
            console.error(
              `[session-clip-export] failed on "${label}" (${job.track.name}): ${String(err)}`);
          }
        }
        await update("Done", 100);
      },
    );
  } finally {
    await song.deleteTrack(renderTrack).catch(() => undefined);
  }

  console.info(
    `[session-clip-export] exported ${exported}/${jobs.length} clip(s) to ${outDir}` +
      (skipped > 0 ? ` (${skipped} non-audio clip(s) skipped)` : ""));
  if (exported < jobs.length) {
    await alert(context, "Session Clip Export",
      `Exported ${exported} of ${jobs.length} clip(s). ` +
      `${jobs.length - exported} failed — details in the Extension Host log. ` +
      `If Live's transport was playing, stop playback and export again.`,
    ).catch(() => undefined);
  }
}

interface ExportOptions {
  normalize: boolean;
}

/** Export options via a native dialog (webview modals render blank in installed mode). */
async function optionsDialog(context: ExportContext): Promise<ExportOptions | null> {
  let lastNormalize = true;
  const memoryFile = configPath(context);
  if (memoryFile !== null) {
    try {
      const cfg = JSON.parse(await fs.readFile(memoryFile, "utf8"));
      if (typeof cfg.normalize === "boolean") lastNormalize = cfg.normalize;
    } catch {
      // defaults
    }
  }
  if (process.platform !== "darwin") return { normalize: lastNormalize };

  const btnNorm = "Normalize to -1 dB";
  const btnPlain = "Keep levels";
  const script =
    `button returned of (display dialog "Export the clips:" ` +
    `buttons {"Cancel", ${JSON.stringify(btnPlain)}, ${JSON.stringify(btnNorm)}} ` +
    `default button ${JSON.stringify(lastNormalize ? btnNorm : btnPlain)} ` +
    `with title "Session Clip Export")`;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 5 * 60 * 1000,
    });
    const chosen = stdout.trim();
    if (chosen !== btnNorm && chosen !== btnPlain) return null;
    const normalize = chosen === btnNorm;
    if (memoryFile !== null) {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await fs.readFile(memoryFile, "utf8"));
      } catch { /* fresh config */ }
      cfg["normalize"] = normalize;
      await fs.mkdir(path.dirname(memoryFile), { recursive: true }).catch(() => undefined);
      await fs.writeFile(memoryFile, JSON.stringify(cfg)).catch(() => undefined);
    }
    return { normalize };
  } catch {
    return null; // Cancel exits non-zero
  }
}

/** Blocking OK dialog inside Live (modal webview with inline HTML). */
async function alert(context: ExportContext, title: string, message: string): Promise<void> {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>
    function send() {
      const m = { method: "close_and_send", params: ["ok"] };
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live)
        window.webkit.messageHandlers.live.postMessage(m);
      else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(m);
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") send();
    });
  </script><style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 18px;
           display: flex; flex-direction: column; gap: 12px; }
    h3 { margin: 0; font-size: 15px; }
    p { margin: 0; font-size: 13px; line-height: 1.45; }
    button { align-self: flex-end; padding: 6px 22px; font-size: 13px; }
  </style></head><body>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(message)}</p>
    <button onclick="send()" autofocus>OK</button>
  </body></html>`;
  await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 440, 220);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
}

/**
 * Recreate the session clip on its track's arrangement, render exactly one
 * loop length at the song tempo, then delete the temporary clip.
 */
async function renderOneLoop(
  context: ExportContext,
  { clip }: Job,
  track: AudioTrack<"1.0.0">,
): Promise<string> {
  // One loop's worth of beats: the loop region for looping clips, otherwise the
  // start->end marker region.
  const start = clip.looping ? clip.loopStart : clip.startMarker;
  const end = clip.looping ? clip.loopEnd : clip.endMarker;
  const lengthBeats = Math.max(end - start, 0.25);

  // Place the temp clip after all existing arrangement content on this track.
  let renderStart = 0;
  for (const existing of track.arrangementClips) {
    renderStart = Math.max(renderStart, existing.endTime);
  }
  renderStart = Math.ceil(renderStart) + 8;

  // Start playback at the loop start so the render is exactly the loop region.
  const loopSettings: ClipLoopSettings = {
    looping: clip.looping,
    startMarker: start,
    endMarker: end,
    loopStart: start,
    loopEnd: end,
  };

  let tempClip;
  try {
    tempClip = await track.createAudioClip({
      filePath: clip.filePath,
      startTime: renderStart,
      duration: lengthBeats,
      isWarped: clip.warping,
      loopSettings,
    });
  } catch (err) {
    throw new Error(
      `could not create temp arrangement clip at beat ${renderStart} ` +
      `(len ${lengthBeats}, warped=${clip.warping}, file=${path.basename(clip.filePath)}): ` +
      describeErr(err));
  }
  try {
    return await context.resources.renderPreFxAudio(
      track, renderStart, renderStart + lengthBeats);
  } catch (err) {
    throw new Error(`render failed: ${describeErr(err)}`);
  } finally {
    await track.deleteClip(tempClip).catch(() => undefined);
  }
}

/** Live's host often rejects with no detail at all — say so instead of "undefined". */
function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === undefined || err === null) return "no error detail from Live";
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Decode, peak-normalize to -1 dBFS, and write as 24-bit WAV. */
async function normalizeAndWrite(srcWav: string, dst: string, doNormalize = true) {
  const raw = await fs.readFile(srcWav);
  // Live's renders are AIFF (despite the docs saying WAV) — decode PCM
  // WAV/AIFF natively; audio-decode handles anything else.
  let channels: Float32Array[];
  let sampleRate: number;
  const pcm = decodePcm(raw);
  if (pcm !== null) {
    channels = pcm.channels;
    sampleRate = pcm.sampleRate;
  } else {
    const decoded = await decodeAudio(raw);
    channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, c) => decoded.getChannelData(c),
    );
    sampleRate = decoded.sampleRate;
  }
  const gainDb = doNormalize ? normalize(channels, -1) : 0;
  await writeFileAnywhere(dst, encodeWav24(channels, sampleRate));
  console.info(
    `[session-clip-export] wrote ${path.basename(dst)} ` +
    (doNormalize
      ? `(gain ${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB)`
      : `(no normalization)`));
}

/**
 * Run demucs on an exported clip and place its stems next to it as
 * "<base> - drums.wav", "<base> - bass.wav", "<base> - vocals.wav", "<base> - other.wav".
 * Stems are separated from the normalized clip so they sum back to it.
 */
async function separateStems(demucs: string, clipWav: string, outDir: string, base: string) {
  const tmp = await fs.mkdtemp(path.join(scratchBase(), "scx-stems-"));
  try {
    await execFileAsync(demucs, ["--int24", "-o", tmp, clipWav], {
      timeout: DEMUCS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    // Output layout is <tmp>/<model>/<clip basename>/<stem>.wav — search for the stems.
    const found = new Map<string, string>();
    await walkForStems(tmp, found);
    if (found.size === 0) {
      throw new Error("demucs produced no stem files");
    }
    for (const stem of STEM_NAMES) {
      const src = found.get(stem);
      if (src === undefined) continue;
      await copyAnywhere(src, path.join(outDir, `${base} - ${stem}.wav`));
    }
    console.info(`[session-clip-export] wrote ${found.size} stem(s) for ${base}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function walkForStems(dir: string, found: Map<string, string>) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForStems(full, found);
    } else {
      const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
      if (STEM_NAMES.includes(stem)) found.set(stem, full);
    }
  }
}

/**
 * Native macOS folder chooser via osascript. Returns the chosen POSIX path,
 * or null if the user canceled (or the dialog is unavailable, e.g. non-macOS —
 * then falls back to the Desktop). Remembers the last choice in the
 * extension's storage directory as the next default.
 */
async function chooseOutputDir(context: ExportContext): Promise<string | null> {
  if (process.platform !== "darwin") {
    return path.join(os.homedir(), "Desktop"); // picker is macOS-only; keep old behavior
  }
  let defaultLoc = path.join(os.homedir(), "Desktop");
  const memoryFile = configPath(context);
  if (memoryFile !== null) {
    try {
      const remembered = JSON.parse(await fs.readFile(memoryFile, "utf8")).outputDir;
      if (typeof remembered === "string") {
        await execFileAsync("/bin/test", ["-d", remembered]);
        defaultLoc = remembered;
      }
    } catch {
      // no remembered folder yet
    }
  }
  const script =
    `POSIX path of (choose folder with prompt ` +
    `"Save exported session clips to:" default location POSIX file ${JSON.stringify(defaultLoc)})`;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 5 * 60 * 1000,
    });
    const dir = stdout.trim();
    if (dir === "") return null;
    if (memoryFile !== null) {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await fs.readFile(memoryFile, "utf8"));
      } catch { /* fresh config */ }
      cfg["outputDir"] = dir;
      await fs.mkdir(path.dirname(memoryFile), { recursive: true }).catch(() => undefined);
      await fs.writeFile(memoryFile, JSON.stringify(cfg)).catch(() => undefined);
    }
    return dir;
  } catch {
    return null; // "User canceled" exits non-zero
  }
}

function configPath(context: ExportContext): string | null {
  const storage = context.environment.storageDirectory;
  return storage === undefined ? null : path.join(storage, "session-clip-export.json");
}

/**
 * Locate demucs. The Extension Host may run with a minimal PATH (when launched
 * by Live), so also check the usual install locations directly.
 */
async function findDemucs(): Promise<string | null> {
  const candidates = [
    ...(process.env["PATH"] ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
  ].filter((d) => d.length > 0).map((d) => path.join(d, "demucs"));
  for (const candidate of candidates) {
    try {
      // fs.access is blocked by the installed-mode sandbox; /bin/test is not.
      await execFileAsync("/bin/test", ["-x", candidate]);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** "Name" for the first clip with a name, "Name 2", "Name 3"… after. */
function numberedBase(counts: Map<string, number>, rawName: string): string {
  const base = rawName.replace(/[\\/:*?"<>|]/g, "_");
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base} ${n}`;
}

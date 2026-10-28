// Arrangement to Session — consolidates the arrangement into fixed-length
// session clips for remixing. Pick a bar length (e.g. 4): the arrangement is
// cut into consecutive windows of that many bars, each window becomes a new
// scene, and every track gets one clip per window — audio tracks are rendered
// pre-FX and imported, MIDI tracks have their notes copied (loops unrolled).
// Launching the scenes top to bottom replays the arrangement; launching them
// in any other order is the remix.
//
// No in-process file IO on Live's files: renders go straight into
// importIntoProject and the session clips are created from the imported path,
// so the installed-mode permission sandbox never gets in the way.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  initialize,
  type ActivationContext,
  type ClipLoopSettings,
  type NoteDescription,
  AudioTrack,
  MidiClip,
  MidiTrack,
  Track,
} from "@ableton-extensions/sdk";

import { readFileAnywhere, setTempBase } from "./fsx.js";
import { decodePcm } from "./pcm.js";

const execFileAsync = promisify(execFile);

/** Rendered windows whose peak stays below this are skipped entirely. */
const SILENCE_DB = -48;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  setTempBase(context.environment.tempDirectory);

  context.commands.registerCommand("arrangement-to-session.consolidate", () => {
    void consolidate(context).catch(async (err) => {
      if (err === undefined || err === null) return; // progress-dialog cancel
      const name = (err as { name?: string })?.name;
      if (name === "AbortError") return;
      console.error(`[arrangement-to-session] failed: ${String(err)}`);
      await alert(context, "Arrangement to Session",
        `Consolidation failed: ${describeErr(err)}`).catch(() => undefined);
    });
  });

  void context.ui.registerContextMenuAction(
    "Scene", "Consolidate Arrangement to Scenes…", "arrangement-to-session.consolidate");
}

type Ctx = ReturnType<typeof initialize<"1.0.0">>;

/** One session clip to create: a window of one track. */
interface Cell {
  track: Track<"1.0.0">;
  window: number; // 0-based window index
  kind: "audio" | "midi";
  notes?: NoteDescription[]; // midi only, already window-relative
}

async function consolidate(context: Ctx) {
  const song = context.application.song;

  const bars = await askBars(context);
  if (bars === null) {
    console.info("[arrangement-to-session] canceled (bars dialog)");
    return;
  }

  const windowBeats = bars * beatsPerBar(context);

  // Skip group tracks: their children are rendered individually, and rendering
  // the group as well would duplicate the material.
  const groupIds = new Set<bigint>();
  for (const track of song.tracks) {
    const group = track.groupTrack;
    if (group !== null) groupIds.add(group.handle.id);
  }
  const tracks = song.tracks.filter((t) => !groupIds.has(t.handle.id));

  // Arrangement extent: the end of the last (unmuted) arrangement clip.
  let arrangementEnd = 0;
  for (const track of tracks) {
    for (const clip of track.arrangementClips) {
      if (!clip.muted) arrangementEnd = Math.max(arrangementEnd, clip.endTime);
    }
  }
  if (arrangementEnd <= 0) {
    await alert(context, "Arrangement to Session",
      "The arrangement is empty — nothing to consolidate.");
    return;
  }

  const numWindows = Math.max(1, Math.ceil(arrangementEnd / windowBeats - 1e-9));

  // Work out up front which track/window cells actually have content, so the
  // progress bar is honest and silent windows don't produce clips.
  const cells: Cell[] = [];
  for (const track of tracks) {
    for (let k = 0; k < numWindows; k++) {
      const winStart = k * windowBeats;
      const winEnd = winStart + windowBeats;
      if (track instanceof AudioTrack) {
        const hasAudio = track.arrangementClips.some((c) =>
          !c.muted && c.startTime < winEnd && c.endTime > winStart);
        if (hasAudio) cells.push({ track, window: k, kind: "audio" });
      } else if (track instanceof MidiTrack) {
        const notes: NoteDescription[] = [];
        for (const clip of track.arrangementClips) {
          if (clip.muted || !(clip instanceof MidiClip)) continue;
          notes.push(...windowNotes(clip, winStart, winEnd));
        }
        if (notes.length > 0) {
          notes.sort((a, b) => a.startTime - b.startTime);
          cells.push({ track, window: k, kind: "midi", notes });
        }
      }
      // Other track types (e.g. groups that slipped through) are skipped.
    }
  }
  if (cells.length === 0) {
    await alert(context, "Arrangement to Session",
      "No audio or MIDI arrangement clips found on renderable tracks.");
    return;
  }

  // Append one scene per window below the existing ones, as a single undo step.
  const sceneBase = song.scenes.length;
  await context.withinTransaction(() =>
    Promise.all(Array.from({ length: numWindows }, () => song.createScene(-1))));
  for (let k = 0; k < numWindows; k++) {
    const scene = song.scenes[sceneBase + k];
    if (scene !== undefined) scene.name = `Arr ${barLabel(k, bars)}`;
  }

  let created = 0;
  let failed = 0;
  let skippedSilent = 0;
  await context.ui.withinProgressDialog(
    `Consolidating ${numWindows} × ${bars} bars…`,
    { progress: 0 },
    async (update, abortSignal) => {
      for (const [i, cell] of cells.entries()) {
        abortSignal.throwIfAborted();
        const winStart = cell.window * windowBeats;
        const label = `${cell.track.name} ${barLabel(cell.window, bars)}`;
        await update(`Consolidating "${label}" (${i + 1}/${cells.length})`, (i / cells.length) * 100);
        try {
          const slot = cell.track.clipSlots[sceneBase + cell.window];
          if (slot === undefined) throw new Error("clip slot missing for new scene");
          if (cell.kind === "audio" && cell.track instanceof AudioTrack) {
            const rendered = await context.resources.renderPreFxAudio(
              cell.track, winStart, winStart + windowBeats);
            // A long arrangement clip can span quiet stretches: windows that
            // rendered to silence get no session clip.
            if (await renderIsSilent(rendered)) {
              skippedSilent++;
              console.info(`[arrangement-to-session] "${label}" is silent — skipped`);
              continue;
            }
            const imported = await context.resources.importIntoProject(rendered);
            const loopSettings: ClipLoopSettings = {
              looping: true,
              startMarker: 0,
              endMarker: windowBeats,
              loopStart: 0,
              loopEnd: windowBeats,
            };
            const clip = await slot.createAudioClip({
              filePath: imported, isWarped: true, loopSettings,
            });
            clip.name = label;
          } else if (cell.kind === "midi" && cell.notes !== undefined) {
            const clip = await slot.createMidiClip(windowBeats);
            clip.notes = cell.notes;
            clip.name = label;
          }
          created++;
        } catch (err) {
          failed++;
          console.error(
            `[arrangement-to-session] failed on "${label}": ${describeErr(err)}`);
        }
      }
      await update("Done", 100);
    },
  );

  const silentNote = skippedSilent > 0 ? `, ${skippedSilent} silent window(s) skipped` : "";
  console.info(
    `[arrangement-to-session] created ${created} clip(s) in ${numWindows} scene(s)` +
    silentNote + (failed > 0 ? ` (${failed} failed)` : ""));
  if (failed > 0) {
    await alert(context, "Arrangement to Session",
      `Created ${created} of ${cells.length} clip(s) in ${numWindows} new scene(s)${silentNote}. ` +
      `${failed} failed — details in the Extension Host log. ` +
      `If Live's transport was playing, stop playback and try again.`,
    ).catch(() => undefined);
  } else {
    await alert(context, "Arrangement to Session",
      `Created ${numWindows} scene(s) of ${bars} bars (${created} clip(s)${silentNote}). ` +
      `Launch them in order to replay the arrangement — or in any order to remix it.`,
    ).catch(() => undefined);
  }
}

/** Peak-scan a rendered window; true when everything stays below SILENCE_DB. */
async function renderIsSilent(renderedPath: string): Promise<boolean> {
  try {
    const pcm = decodePcm(await readFileAnywhere(renderedPath));
    if (pcm === null) return false; // unknown format — keep the clip
    const threshold = Math.pow(10, SILENCE_DB / 20);
    for (const ch of pcm.channels) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        if (v !== undefined && Math.abs(v) > threshold) return false;
      }
    }
    return true;
  } catch (err) {
    console.error(`[arrangement-to-session] silence check failed: ${describeErr(err)}`);
    return false; // when in doubt, keep the clip
  }
}

/**
 * The notes of one arrangement MIDI clip that sound inside [winStart, winEnd),
 * in window-relative time. Looped clips are unrolled: the lead-in from the
 * start marker plays once, then the loop region repeats until the clip ends.
 * Notes that start before the window are dropped (they belong to the previous
 * scene); notes are truncated at the window, loop, and clip boundaries.
 */
function windowNotes(
  clip: MidiClip<"1.0.0">, winStart: number, winEnd: number,
): NoteDescription[] {
  const clipStart = clip.startTime;
  const clipEnd = clip.endTime;
  const lo = Math.max(winStart, clipStart);
  const hi = Math.min(winEnd, clipEnd);
  if (hi <= lo) return [];

  // Content segments laid onto the arrangement timeline.
  interface Seg { contentStart: number; contentEnd: number; arrStart: number }
  const segs: Seg[] = [];
  if (!clip.looping) {
    segs.push({ contentStart: clip.startMarker, contentEnd: clip.endMarker, arrStart: clipStart });
  } else {
    const loopLen = clip.loopEnd - clip.loopStart;
    if (loopLen <= 0) return [];
    let arrT = clipStart;
    const lead = clip.loopEnd - clip.startMarker;
    if (lead > 0) {
      segs.push({ contentStart: clip.startMarker, contentEnd: clip.loopEnd, arrStart: arrT });
      arrT += lead;
    }
    while (arrT < hi) {
      segs.push({ contentStart: clip.loopStart, contentEnd: clip.loopEnd, arrStart: arrT });
      arrT += loopLen;
    }
  }

  const out: NoteDescription[] = [];
  for (const seg of segs) {
    const segArrEnd = seg.arrStart + (seg.contentEnd - seg.contentStart);
    if (segArrEnd <= lo || seg.arrStart >= hi) continue;
    for (const n of clip.notes) {
      if (n.startTime < seg.contentStart || n.startTime >= seg.contentEnd) continue;
      const arrNoteStart = seg.arrStart + (n.startTime - seg.contentStart);
      if (arrNoteStart < lo || arrNoteStart >= hi) continue;
      const duration = Math.min(
        n.duration,
        seg.contentEnd - n.startTime, // cut at loop/region end
        hi - arrNoteStart,            // cut at window / clip end
      );
      if (duration <= 1e-6) continue;
      const copy: NoteDescription = {
        pitch: n.pitch,
        startTime: arrNoteStart - winStart,
        duration,
      };
      if (n.velocity !== undefined) copy.velocity = n.velocity;
      if (n.muted !== undefined) copy.muted = n.muted;
      if (n.probability !== undefined) copy.probability = n.probability;
      if (n.velocityDeviation !== undefined) copy.velocityDeviation = n.velocityDeviation;
      if (n.releaseVelocity !== undefined) copy.releaseVelocity = n.releaseVelocity;
      out.push(copy);
    }
  }
  return out;
}

/** "1–4" for window 0 at 4 bars, "5–8" for window 1, … (1-based bar numbers). */
function barLabel(window: number, bars: number): string {
  const first = window * bars + 1;
  const last = (window + 1) * bars;
  return bars === 1 ? `${first}` : `${first}–${last}`;
}

/** Quarter-note beats per bar from the set's time signature (scenes carry it). */
function beatsPerBar(context: Ctx): number {
  try {
    const scene = context.application.song.scenes[0];
    if (scene !== undefined) {
      const num = scene.signatureNumerator;
      const den = scene.signatureDenominator;
      if (num > 0 && den > 0) return num * (4 / den);
    }
  } catch {
    // fall through to 4/4
  }
  return 4;
}

/** Native prompt for the bar length (webview dialogs render blank when installed). */
async function askBars(context: Ctx): Promise<number | null> {
  let lastBars = 4;
  const memoryFile = configPath(context);
  if (memoryFile !== null) {
    try {
      const cfg = JSON.parse(await fs.readFile(memoryFile, "utf8"));
      if (Number.isInteger(cfg.bars) && cfg.bars > 0) lastBars = cfg.bars;
    } catch {
      // defaults
    }
  }
  if (process.platform !== "darwin") return lastBars;

  // The SDK has no freeze/flatten or automation API, so arrangement automation
  // can't be captured — remind the user to print it manually where needed.
  const script =
    `text returned of (display dialog "Cut the arrangement into scenes every … bars:` +
    `\\n\\nTrack automation (volume, device on/off, sends) is not captured — ` +
    `freeze + flatten those tracks first." ` +
    `default answer ${JSON.stringify(String(lastBars))} ` +
    `buttons {"Cancel", "OK"} default button "OK" ` +
    `with title "Arrangement to Session")`;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 5 * 60 * 1000,
    });
    const bars = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(bars) || bars < 1 || bars > 512) {
      await alert(context, "Arrangement to Session",
        `"${stdout.trim()}" is not a valid bar count — enter a whole number like 4.`);
      return null;
    }
    if (memoryFile !== null) {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await fs.readFile(memoryFile, "utf8"));
      } catch { /* fresh config */ }
      cfg["bars"] = bars;
      await fs.mkdir(path.dirname(memoryFile), { recursive: true }).catch(() => undefined);
      await fs.writeFile(memoryFile, JSON.stringify(cfg)).catch(() => undefined);
    }
    return bars;
  } catch {
    return null; // Cancel exits non-zero
  }
}

function configPath(context: Ctx): string | null {
  const dir = context.environment.storageDirectory;
  return dir === undefined ? null : path.join(dir, "config.json");
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

/** Blocking OK dialog inside Live (modal webview with inline HTML). */
async function alert(context: Ctx, title: string, message: string): Promise<void> {
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

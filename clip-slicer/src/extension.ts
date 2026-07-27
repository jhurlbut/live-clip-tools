// Clip Slicer — right-click a Session View audio clip to cut it into separate
// 4-bar clips, starting at the clip's "1" and covering the audio up to where
// trailing silence begins (the active loop brace is ignored).
//
// Default mode BOUNCES: each 4-bar window is rendered through the clip's
// warping via a temporary arrangement clip (renderPreFxAudio), imported into
// the project, and the slice clip plays that rendered file — timing is baked
// in, so slices need no warp markers. A "(by reference)" variant skips
// rendering and windows the original file with loop markers.
//
// Warp fidelity: new clips take their warp from the audio file's saved .asd,
// and Live serves a CACHED analysis for files it has already loaded — so the
// bounce sources a fresh temp COPY of the audio + .asd (never seen by Live,
// always read from disk). A probe clip verifies the saved warp matches the
// session clip before anything is created; problems surface as a popup.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  initialize,
  type ActivationContext,
  type Handle,
  type WarpMarker,
  AudioClip,
  AudioTrack,
  ClipSlot,
} from "@ableton-extensions/sdk";

import { audioFileDurationSeconds, lastNonSilentSeconds } from "./audiolen.js";
import { copyAnywhere, scratchBase, setTempBase } from "./fsx.js";

const BEATS_PER_SLICE = 16; // 4 bars in 4/4 (the SDK does not expose time signature)
const MIN_SLICE_BEATS = 0.25; // Live's minimum loop length

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  setTempBase(context.environment.tempDirectory);

  context.commands.registerCommand("clip-slicer.slice-4bars", (arg: unknown) => {
    void runSlice(context, arg as Handle, { bounce: true });
  });
  context.commands.registerCommand("clip-slicer.slice-4bars-ref", (arg: unknown) => {
    void runSlice(context, arg as Handle, { bounce: false });
  });

  void context.ui.registerContextMenuAction(
    "AudioClip", "Slice into 4-Bar Clips", "clip-slicer.slice-4bars");
  void context.ui.registerContextMenuAction(
    "AudioClip", "Slice into 4-Bar Clips (by reference)", "clip-slicer.slice-4bars-ref");
}

type Ctx = ReturnType<typeof initialize<"1.0.0">>;

async function runSlice(context: Ctx, handle: Handle, options: { bounce: boolean }) {
  try {
    await slice(context, handle, options);
  } catch (err) {
    // Canceling the progress dialog surfaces as an undefined rejection (or an
    // AbortError) — that's a user choice, not a failure. No popup for it.
    if (err === undefined || err === null ||
        (err instanceof Error && err.name === "AbortError")) {
      console.info("[clip-slicer] canceled");
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[clip-slicer] slice failed: ${msg}`);
    await alert(context, "Clip Slicer — failed", msg).catch(() => undefined);
  }
}

async function slice(context: Ctx, handle: Handle, options: { bounce: boolean }) {
  const clip = context.getObjectFromHandle(handle, AudioClip);

  const slot = clip.parent;
  if (!(slot instanceof ClipSlot)) {
    await alert(context, "Clip Slicer",
      "This works on Session View clips only — this clip is in the Arrangement.");
    return;
  }
  const track = slot.parent;
  if (!(track instanceof AudioTrack)) {
    await alert(context, "Clip Slicer", "Could not resolve the clip's audio track.");
    return;
  }
  if (!clip.warping) {
    await alert(context, "Clip Slicer",
      "Enable Warp on the clip first — slicing is beat-based.");
    return;
  }

  // Fresh copy of audio + .asd in the sandbox-writable temp dir. Serves two
  // purposes: (a) Live has never seen this path, so probe/render clips read the
  // .asd from DISK (bypassing Live's cached analysis); (b) in installed mode
  // the host cannot READ arbitrary files directly, but the copy (made via a
  // child process) lands somewhere we can read for analysis.
  const src = await makeFreshCopy(clip.filePath);
  try {
  // Region: from the clip's "1" to the end of the audio file. The active loop
  // brace is ignored. File length in beats = real duration (container header)
  // mapped through the clip's warp markers.
  const origin = clip.looping ? clip.loopStart : clip.startMarker;
  const audioSeconds = await audioFileDurationSeconds(src.path);
  const markerEnd = Math.max(clip.endMarker, clip.loopEnd);
  const audioEndBeats = audioSeconds !== null
    ? secondsToBeats(audioSeconds, clip.warpMarkers, context.application.song.tempo)
    : null;
  const regionEnd = Math.max(markerEnd, audioEndBeats ?? 0);

  const bars = (regionEnd - origin) / (BEATS_PER_SLICE / 4);
  console.info(
    `[clip-slicer] region ${origin}→${round2(regionEnd)} beats (${bars.toFixed(1)} bars) ` +
    `[audio ${audioSeconds === null ? "unknown len" : round2(audioSeconds) + "s"} -> ` +
    `${audioEndBeats === null ? "?" : round2(audioEndBeats)} beats, ` +
    `markers ${clip.startMarker}→${round2(clip.endMarker)}, loop ${clip.loopStart}→${clip.loopEnd}, ` +
    `${clip.warpMarkers.length} warp marker(s), mode=${options.bounce ? "bounce" : "reference"}]`);

  // Trailing-silence trim: keep only FULL 4-bar windows that end before the
  // audio's last non-silent moment (half-beat tolerance).
  let effectiveEnd = regionEnd;
  let fullOnly = false;
  const lastSound = await lastNonSilentSeconds(src.path);
  if (lastSound !== null && lastSound > 0) {
    const lastSoundBeats = secondsToBeats(
      lastSound, clip.warpMarkers, context.application.song.tempo);
    const fullWindows = Math.floor((lastSoundBeats - origin + 0.5) / BEATS_PER_SLICE);
    effectiveEnd = Math.min(regionEnd, origin + fullWindows * BEATS_PER_SLICE);
    fullOnly = true;
    console.info(
      `[clip-slicer] audio ends at ${round2(lastSound)}s (beat ${round2(lastSoundBeats)}) — ` +
      `${fullWindows} full 4-bar loop(s) before trailing silence`);
  } else if (lastSound === null) {
    console.warn("[clip-slicer] could not scan for trailing silence — keeping full region");
  }

  const windows: Array<[number, number]> = [];
  for (let s = origin; s < effectiveEnd - 1e-9; s += BEATS_PER_SLICE) {
    const e = Math.min(s + BEATS_PER_SLICE, effectiveEnd);
    if (fullOnly && e - s < BEATS_PER_SLICE - 1e-6) break;
    if (e - s >= MIN_SLICE_BEATS) windows.push([s, e]);
  }
  if (windows.length < 2) {
    await alert(context, "Clip Slicer",
      "Fewer than two full 4-bar loops of audio — nothing to slice.");
    return;
  }

  const label = clip.name.trim() || "Clip";

    const fileMs = await probeMarkers(context, track, src.path);
    console.info(
      `[clip-slicer] warp check: clip ${clip.warpMarkers.length} marker(s) ` +
      `${fmtMarkers(clip.warpMarkers)}; saved file ${fileMs.length} ${fmtMarkers(fileMs)}`);
    if (!markersMatchClip(clip.warpMarkers, fileMs)) {
      await alert(context, "Clip Slicer — unsaved warp",
        `"${label}" has warp edits that are not saved to the audio file, so the slices ` +
        `would not match its timing. Click the clip's Save button (Clip view), then run ` +
        `again. (The SDK cannot save it automatically.)`);
      return;
    }

    if (options.bounce) {
      const targets = await collectTargets(context, track, slot, windows.length);
      await sliceByBounce(context, track, clip, src.path, windows, targets, label);
    } else {
      // Reference slices must point at the ORIGINAL file (a temp copy would
      // leave the set with missing media). But Live's cache means new clips of
      // the original path may still carry a stale analysis — verify first.
      const origMs = await probeMarkers(context, track, clip.filePath);
      if (!markersMatchClip(clip.warpMarkers, origMs)) {
        await alert(context, "Clip Slicer — stale cache",
          `Your warp is saved, but Live is still using its cached analysis of this file ` +
          `for new clips. Use the regular "Slice into 4-Bar Clips" (bounce) instead — it ` +
          `works right now — or save the set and reopen it to refresh the cache.`);
        return;
      }
      const targets = await collectTargets(context, track, slot, windows.length);
      await sliceByReference(context, clip, windows, targets, label);
    }
  } finally {
    await src.cleanup();
  }
}

// ---------------------------------------------------------------- helpers

/** Copy the audio file and its .asd (if any) to a fresh temp path. */
async function makeFreshCopy(filePath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(scratchBase(), "clip-slicer-"));
  const dst = path.join(dir, path.basename(filePath));
  await copyAnywhere(filePath, dst);
  try {
    await copyAnywhere(filePath + ".asd", dst + ".asd");
  } catch {
    // no .asd yet — the probe will report default analysis, which is fine
  }
  return {
    path: dst,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Warp markers a freshly created clip of `filePath` would get (throwaway probe clip). */
async function probeMarkers(
  context: Ctx,
  track: AudioTrack<"1.0.0">,
  filePath: string,
): Promise<WarpMarker[]> {
  const probeStart = freeArrangementStart(track);
  const probe = await track.createAudioClip({
    filePath,
    startTime: probeStart,
    duration: 1,
    isWarped: true,
    loopSettings: { looping: true, startMarker: 0, endMarker: 1, loopStart: 0, loopEnd: 1 },
  });
  try {
    return [...probe.warpMarkers].sort((a, b) => a.sampleTime - b.sampleTime);
  } finally {
    await track.deleteClip(probe);
  }
}

/**
 * Drop synthetic trailing markers before comparing: Live appends a terminator
 * (glued right after the last real marker) or an end-of-region marker that is
 * exactly collinear with the previous segment — neither carries timing info,
 * and each clip instance grows its own in a different place.
 */
function normalizeMarkers(markers: WarpMarker[]): WarpMarker[] {
  const out = [...markers].sort((a, b) => a.sampleTime - b.sampleTime);
  for (let pass = 0; pass < 2 && out.length >= 2; pass++) {
    const last = out[out.length - 1]!;
    const prev = out[out.length - 2]!;
    const dt = last.sampleTime - prev.sampleTime;
    let synthetic = dt >= 0 && dt < 0.05; // terminator glued to the previous marker
    if (!synthetic && out.length >= 3) {
      const p2 = out[out.length - 3]!;
      const r1 = (prev.beatTime - p2.beatTime) / Math.max(prev.sampleTime - p2.sampleTime, 1e-9);
      const r2 = (last.beatTime - prev.beatTime) / Math.max(dt, 1e-9);
      synthetic = Math.abs(r1 - r2) < Math.abs(r1) * 0.002; // collinear extension
    }
    if (synthetic) out.pop();
    else break;
  }
  return out;
}

/** Marker equality on the normalized (real-marker) lists. */
function markersMatchClip(clipMarkers: WarpMarker[], fileMs: WarpMarker[]): boolean {
  const a = normalizeMarkers(clipMarkers);
  const b = normalizeMarkers(fileMs);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]!.beatTime - b[i]!.beatTime) > 1e-4 ||
        Math.abs(a[i]!.sampleTime - b[i]!.sampleTime) > 1) {
      return false;
    }
  }
  return true;
}

function freeArrangementStart(track: AudioTrack<"1.0.0">): number {
  let start = 0;
  for (const existing of track.arrangementClips) {
    start = Math.max(start, existing.endTime);
  }
  return Math.ceil(start) + 8;
}

/** Empty slots below the source clip, then appended scenes for the shortfall. */
async function collectTargets(
  context: Ctx,
  track: AudioTrack<"1.0.0">,
  slot: ClipSlot<"1.0.0">,
  needed: number,
): Promise<ClipSlot<"1.0.0">[]> {
  const song = context.application.song;
  let slots = track.clipSlots;
  let srcIndex = slots.indexOf(slot);
  if (srcIndex < 0) {
    srcIndex = slots.findIndex((s) => s.handle.id === slot.handle.id);
  }
  const targets: ClipSlot<"1.0.0">[] = [];
  for (let i = srcIndex + 1; i < slots.length && targets.length < needed; i++) {
    const candidate = slots[i];
    if (candidate !== undefined && candidate.clip === null) targets.push(candidate);
  }
  while (targets.length < needed) {
    await song.createScene(-1); // appended scenes add an empty slot on every track
    slots = track.clipSlots;
    const fresh = slots[slots.length - 1];
    if (fresh === undefined || fresh.clip !== null) {
      throw new Error("could not obtain an empty slot from a new scene");
    }
    targets.push(fresh);
  }
  return targets;
}

/**
 * Bounce mode: render each window through the clip's warping (temp arrangement
 * clip from the fresh copy + renderPreFxAudio), import the rendered audio, and
 * create the slice from it. Slices carry baked timing — no warp markers needed.
 */
async function sliceByBounce(
  context: Ctx,
  track: AudioTrack<"1.0.0">,
  clip: AudioClip<"1.0.0">,
  srcPath: string,
  windows: Array<[number, number]>,
  targets: ClipSlot<"1.0.0">[],
  label: string,
) {
  const renderStart = freeArrangementStart(track);
  const color = clip.color;
  let made = 0;

  await context.ui.withinProgressDialog(
    `Bouncing ${windows.length} slice(s)…`,
    { progress: 0 },
    async (update, abortSignal) => {
      for (const [k, [s, e]] of windows.entries()) {
        abortSignal.throwIfAborted();
        await update(`Bouncing slice ${k + 1}/${windows.length}`, (k / windows.length) * 100);
        const len = e - s;

        const temp = await track.createAudioClip({
          filePath: srcPath,
          startTime: renderStart,
          duration: len,
          isWarped: true,
          loopSettings: { looping: true, startMarker: s, endMarker: e, loopStart: s, loopEnd: e },
        });
        try {
          const wav = await context.resources.renderPreFxAudio(
            track, renderStart, renderStart + len);
          const imported = await context.resources.importIntoProject(wav);

          const target = targets[k];
          if (target === undefined) throw new Error("missing target slot");
          const sliceClip = await target.createAudioClip({
            filePath: imported,
            isWarped: true,
            loopSettings: { looping: true, startMarker: 0, endMarker: len, loopStart: 0, loopEnd: len },
          });
          sliceClip.name = `${label} ${k + 1}`;
          sliceClip.color = color;
          made++;
        } finally {
          await track.deleteClip(temp);
        }
      }
      await update("Done", 100);
    },
  );

  console.info(`[clip-slicer] bounced "${label}" into ${made} x 4-bar clip(s) below it`);
}

/** Reference mode: window the original file via loop markers (no rendering). */
async function sliceByReference(
  context: Ctx,
  clip: AudioClip<"1.0.0">,
  windows: Array<[number, number]>,
  targets: ClipSlot<"1.0.0">[],
  label: string,
) {
  const filePath = clip.filePath;
  const color = clip.color;

  // All slice creations start synchronously inside one transaction -> one undo step.
  const created = await context.withinTransaction(() =>
    Promise.all(
      windows.map(([s, e], k) => {
        const target = targets[k];
        if (target === undefined) throw new Error("missing target slot");
        return target.createAudioClip({
          filePath,
          isWarped: true,
          loopSettings: { looping: true, startMarker: s, endMarker: e, loopStart: s, loopEnd: e },
        });
      }),
    ),
  );
  created.forEach((c, k) => {
    c.name = `${label} ${k + 1}`;
    c.color = color;
  });

  console.info(`[clip-slicer] sliced "${label}" into ${created.length} x 4-bar clip(s) below it`);
}

// ---------------------------------------------------------------- ui / math

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
  await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(html)}`, 440, 240);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
}

/**
 * Map a position in the audio file (seconds) to the clip's beat axis using its
 * warp markers; piecewise-linear between markers, extrapolated with the last
 * segment's rate beyond them, song tempo when markers are too few.
 * Tolerates sampleTime being reported in sample frames instead of seconds.
 */
function secondsToBeats(seconds: number, markers: WarpMarker[], songTempo: number): number {
  const fallbackRate = songTempo / 60; // beats per second
  const ms = [...markers].sort((a, b) => a.sampleTime - b.sampleTime);
  if (ms.length === 0) return seconds * fallbackRate;

  // Heuristic unit fix: if marker times vastly exceed the file length in
  // seconds, they're sample frames — rescale against a plausible 44.1k rate.
  let scale = 1;
  const last = ms[ms.length - 1]!;
  if (last.sampleTime > seconds * 100) scale = 1 / 44100;

  const at = (m: WarpMarker) => m.sampleTime * scale;
  if (ms.length === 1) {
    return ms[0]!.beatTime + (seconds - at(ms[0]!)) * fallbackRate;
  }
  let a = ms[0]!;
  let b = ms[1]!;
  for (let i = 1; i < ms.length; i++) {
    if (at(ms[i]!) >= seconds || i === ms.length - 1) {
      a = ms[i - 1]!;
      b = ms[i]!;
      break;
    }
  }
  const dt = at(b) - at(a);
  const rate = dt > 1e-9 ? (b.beatTime - a.beatTime) / dt : fallbackRate;
  return a.beatTime + (seconds - at(a)) * rate;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function fmtMarkers(ms: WarpMarker[]): string {
  const shown = ms.slice(0, 5)
    .map((m) => `${round2(m.beatTime)}b@${round2(m.sampleTime)}`)
    .join(", ");
  return `[${shown}${ms.length > 5 ? ", …" : ""}]`;
}

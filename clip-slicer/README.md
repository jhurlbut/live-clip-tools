# Clip Slicer

Right-click a Session View audio clip → **Slice into 4-Bar Clips** — the clip's audio is cut
into separate 4-bar session clips, starting at the clip's "1" (its loop start) and covering
the **entire audio file** up to where trailing silence begins. The active loop brace is
ignored; a 1-bar brace on a 3-minute recording still slices the whole recording.

Two menu entries on audio clips:

| Entry | How it slices |
| --- | --- |
| **Slice into 4-Bar Clips** | **Bounce (default):** each 4-bar window is rendered through the clip's warping (`renderPreFxAudio` via a temp arrangement clip), imported into the project, and the slice plays that rendered file. Timing is baked in — slices need no warp markers. |
| **Slice into 4-Bar Clips (by reference)** | Instant: each slice is a new clip windowing the original file via loop markers. Requires the file's saved warp to match the clip (checked). |

Slices fill the empty slots below the original (appending scenes as needed), inherit its name
and color (`Groove 1`, `Groove 2`, …). Reference-mode slices are created in one undo step.

## Details & guards

- **Region**: from the clip's loop start ("the 1") to the end of the audio file. File length is
  read from the container header (WAV/AIFF) and mapped through the clip's warp markers.
- **Trailing-silence trim**: the file is scanned backwards for the last audio above −48 dBFS
  (header-based PCM scan; `audio-decode` fallback for other formats), and only **full** 4-bar
  loops before that point are emitted — no partial or silent tail slices.
- **Unsaved-warp guard**: new clips (and bounce renders) take their warp from the audio file's
  saved `.asd`. Before creating anything, a throwaway probe clip checks that the file's saved
  warp matches the session clip — comparing **real** markers only (Live's synthetic trailing
  end/terminator markers are normalized away). On mismatch a **popup** explains the one-click
  fix: press the clip's **Save** button, run again. The SDK cannot save it automatically.
- **Errors are popups**: refusals and failures show a modal dialog in Live, plus detail in the
  Extension Host log (region/bars, detected audio end, both warp-marker lists).
- The clip must be **warped**; 4 bars = 16 beats (4/4 assumed — the SDK has no time-signature
  API); Session View clips only.

## Install in Live

```sh
npm install
npm run package        # → Clip-Slicer-0.0.1.ablx
```

Live → **Settings → Extensions** → drop the `.ablx` onto the Extensions page. Note: installed
extensions only load when **Developer Mode is off**. For development, turn Developer Mode on
and run `npm start` (one extension per host — dev mode runs a single extension at a time).
Logs: `~/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt`.

## Verify

1. Long warped clip (e.g. 110 bars) with a short active loop → default slice → warp-check log
   line, progress dialog, N full 4-bar slices below (silent tail excluded), first slice starting
   exactly on the clip's 1.
2. Clip with hand-warp edits **not** saved → popup asks for Save; nothing is created. Press
   Save → run again → proceeds.
3. Reference mode on a saved clip → instant slices, single undo step.
4. ≤ 2 full loops of audio → popup "nothing to slice".

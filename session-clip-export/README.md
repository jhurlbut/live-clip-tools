# Session Clip Export

Exports Session View audio clips to WAV files — each rendered at the current song tempo for
exactly one loop length, peak-normalized to −1 dBFS, written as 24-bit PCM. Works on the whole
session grid or just the clips you have selected, and can optionally split each exported clip
into stems.

## Menu entries

| Right-click on… | Entry | Does |
| --- | --- | --- |
| a scene header | **Export Session Clips to WAV** | every session audio clip in the set |
| a scene header | **Export Session Clips + Stems** | same, plus demucs stems per clip |
| selected clip slot(s) | **Export Selected Clips to WAV** | just the selected clips |
| selected clip slot(s) | **Export Selected Clips + Stems** | same, plus stems |

Multi-select works the way you'd expect: click/shift-click/cmd-click slots in the session grid,
right-click the selection, pick an Export entry.

Output lands on the Desktop in `Session Clips <tempo>bpm <timestamp>/`.

**File naming:** the clip's name, numbered on duplicates — `Bass.wav`, `Bass 2.wav`, … Stems sit
alongside as `Bass - drums.wav`, `Bass - bass.wav`, `Bass - vocals.wav`, `Bass - other.wav`.
Unnamed clips become `Untitled.wav`, …

## How it works

`renderPreFxAudio` only renders the arrangement, so for each clip the extension:

1. Recreates the clip briefly on its own track's **arrangement**, 8+ beats past existing
   content, playback starting at the clip's loop start.
2. Renders exactly `loopEnd − loopStart` beats (marker range for non-looping clips) pre-FX —
   warping is applied at the song tempo; the track's device chain is not baked in.
3. Deletes the temporary clip — the set is left exactly as it was.
4. Decodes, peak-normalizes to −1 dBFS, writes 24-bit PCM.
5. (Stems) runs **demucs** on the normalized clip, so the four stems sum back to the exported
   file, and copies them next to it.

**Limits:** audio clips only — MIDI session clips are skipped and counted in the log (the SDK
renders audio tracks only). Unwarped clips render over their marker range at native speed.

## Stems prerequisite

Stem separation shells out to [demucs](https://github.com/adefossez/demucs); install it once
with `pipx install demucs` (or `pip3 install demucs`). First run downloads the model (~80 MB)
and separation runs on CPU — expect tens of seconds per clip. If demucs isn't found, the
export still runs and the log says what to install.

## Install in Live

```sh
npm install
npm run package        # → Session-Clip-Export-0.0.1.ablx
```

Then in Live: **Settings → Extensions** → drop `Session-Clip-Export-0.0.1.ablx` onto the
Extensions page. That's the whole install.

For development instead: enable **Developer Mode** (Settings → Extensions) and run `npm start`.
Logs (per-file gain, stem counts, skips, errors) go to
`~/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt`.

## Verify

1. Small set: 2 audio tracks, looped session clips of different lengths (1/2/4 bars), a
   duplicate clip name, one MIDI clip.
2. Scene-header export → WAV count = audio clip count; MIDI counted as skipped in the log.
3. A 4-bar clip at 120 bpm is exactly 8.000 s (`ffprobe`), peak −1.0 dBFS (`ffmpeg -af astats`).
4. Duplicates arrive as `Name.wav` + `Name 2.wav`.
5. Select 2 of 5 clips → Export Selected → only those 2 exported.
6. With demucs installed, a `+ Stems` export adds 4 stem files per clip.
7. The arrangement is unchanged afterwards (temp clips deleted).

# Live Clip Tools

Two free extensions for **Ableton Live 12** that add super-useful entries to your right-click
menus in Session View:

### 🎛 Session Clip Export
Turn your session clips into perfectly-trimmed WAV files, in bulk.

- Right-click a **scene name** → **Export Session Clips to WAV** exports *every* audio clip in
  your set. Or select just a few clips, right-click → **Export Selected Clips to WAV**.
- A window asks where to save, then whether to normalize the volume.
- Every clip becomes its own 24-bit WAV, exactly one loop long at your song's tempo, named
  after the clip (`Bass.wav`, `Bass 2.wav`, …).
- The **+ Stems** menu entries additionally split each clip into four files — drums, bass,
  vocals, other — using AI stem separation (needs a one-time extra install, see below).

### ✂️ Clip Slicer
Chop a long clip into ready-to-launch 4-bar loops.

- Right-click any audio clip → **Slice into 4-Bar Clips**.
- The whole recording gets cut into 4-bar pieces starting from the clip's "1", each landing in
  the empty slots below the original as its own loop-ready clip — named and colored to match.
- Silence at the end of the recording is detected and skipped automatically.

Both tools show progress while they work and explain any problem in a popup.

---

## How to install (about 2 minutes)

**You need:** a Mac running the **Ableton Live 12 beta** that includes Extensions support
(from Ableton's beta program).

1. **Download the two extension files.** Go to this repo's
   [**Releases page**](../../releases/latest) and download:
   - `Session-Clip-Export-0.0.1.ablx`
   - `Clip-Slicer-0.0.1.ablx`

   (They're also in the [`downloads`](downloads) folder here.)

2. **Open Live**, then open **Settings** (Live menu → Settings, or `Cmd+,`).

3. Click the **Extensions** tab.

4. **Make sure "Developer Mode" is switched OFF** on that page. (If it's on, installed
   extensions are ignored — this is the #1 reason "nothing shows up".)

5. **Drag both downloaded `.ablx` files onto the Extensions page**, then quit and reopen Live.

That's it. Right-click a clip or a scene name in Session View and you'll see the new entries.

---

## Optional: enable AI stem separation

The **+ Stems** export entries use a free AI tool called *demucs*. Without it, exports still
work — you just won't get stems. To set it up, open the **Terminal** app and paste these three
lines one at a time (each finishes before you paste the next):

```
brew install pipx
pipx install demucs
pipx inject demucs numpy
```

The very first stems export downloads the AI model (~80 MB), so it takes a couple of minutes —
after that it's fast.

*(No Homebrew? Get it first at [brew.sh](https://brew.sh) — one paste-and-run line.)*

---

## Tips & troubleshooting

- **The menu entries don't appear** → check Settings → Extensions: Developer Mode must be
  **off**, both extensions listed. Then restart Live.
- **Clip Slicer says the clip has unsaved warp edits** → click the little **Save** button in
  the clip's view (bottom of Live, in the clip's Audio panel). That stores your warping with
  the audio file so the slices match it exactly. Then slice again.
- **A popup says some clips failed** → the details are in Live's extension log:
  `~/Library/Preferences/Ableton/Live [version]/ExtensionHost.txt`. Playing back while
  exporting can cause this — stop playback and try again.
- **Where do exports go?** Wherever you choose in the folder window — inside a new subfolder
  named like `Session Clips 120bpm 2026-07-26`, so repeat exports never overwrite anything.
- Both tools only affect **audio** clips; MIDI clips are skipped (the export counts them in
  the log).

---

## For developers

Each extension is a standalone TypeScript project built with the
**Ableton Live Extensions SDK** (closed beta — its packages are *not* included here):

1. Get the Extensions SDK zip from Ableton's beta program.
2. Copy `ableton-extensions-sdk-*.tgz` and `ableton-extensions-cli-*.tgz` from the zip into
   [`vendor/`](vendor).
3. In `session-clip-export/` or `clip-slicer/`: `npm install`, then `npm start` to build and
   attach to Live (Settings → Extensions → Developer Mode **on**; one extension per host).
   `npm run package` produces the distributable `.ablx`.

Technical details for each tool are in their own READMEs:
[session-clip-export](session-clip-export/README.md) ·
[clip-slicer](clip-slicer/README.md).

Noteworthy engineering bits inside: rendering session clips via temporary arrangement clips,
native AIFF decoding (Live's renders are AIFF despite the docs), warp-marker fidelity checks
against the file's saved `.asd`, and a sandbox-aware fs layer (installed extensions run under
Node's permission model — file I/O outside the extension's own directories is routed through
child processes).

## License

MIT — see [LICENSE](LICENSE).

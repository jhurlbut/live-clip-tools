# Live Clip Tools

Two extensions for Ableton Live 12 Session View: bulk clip export and 4-bar loop slicing.

## ⬇️ Download

**[Get both extension files here → Releases](https://github.com/jhurlbut/live-clip-tools/releases/latest)**

- `Session-Clip-Export-0.0.1.ablx`
- `Clip-Slicer-0.0.1.ablx`

## 🚀 Install

1. Open Live → **Settings → Extensions**
2. Turn **Developer Mode off**
3. Drag both `.ablx` files onto the Extensions page
4. Restart Live

New entries appear in Session View right-click menus.

## ✅ Requirements

- macOS
- Ableton Live 12 beta with Extensions support
- Optional, for stem separation: [demucs](#-stem-separation-optional)

---

## 🎛 Session Clip Export

Right-click a scene name → **Export Session Clips to WAV**, or select clips →
**Export Selected Clips to WAV**.

- Choose a destination folder and whether to normalize to −1 dBFS
- Each clip is written as a 24-bit WAV, one loop long at song tempo, named after the clip
  (duplicates numbered)
- **+ Stems** entries also split each clip into drums / bass / vocals / other

## ✂️ Clip Slicer

Right-click an audio clip → **Slice into 4-Bar Clips**.

- Cuts the entire recording into 4-bar loops starting at the clip's "1"
- Slices fill the slots below the original, named and colored to match
- Trailing silence is detected and excluded
- *(by reference)* variant creates instant slices that point at the original file instead of
  rendering new audio

## 🎚 Stem separation (optional)

In Terminal, run:

```
brew install pipx
pipx install demucs
pipx inject demucs numpy
```

The first stems export downloads the model (~80 MB).

## 🔧 Troubleshooting

- **No menu entries** — Settings → Extensions: Developer Mode must be off. Restart Live.
- **Clip Slicer reports unsaved warp edits** — click the clip's **Save** button (Clip view),
  then slice again.
- **Export failures** — stop playback and retry. Details:
  `~/Library/Preferences/Ableton/Live [version]/ExtensionHost.txt`
- MIDI clips are skipped; both tools are audio-only.

## 🛠 Development

The Extensions SDK is a closed beta and is not included. Copy
`ableton-extensions-sdk-*.tgz` and `ableton-extensions-cli-*.tgz` from the SDK zip into
[`vendor/`](vendor), then in either project directory:

```
npm install
npm start          # build + attach to Live (Developer Mode on, one extension per host)
npm run package    # produce the .ablx
```

Technical docs: [session-clip-export](session-clip-export/README.md) ·
[clip-slicer](clip-slicer/README.md)

## License

[MIT](LICENSE)

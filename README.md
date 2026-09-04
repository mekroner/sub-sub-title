# sub-sub-title

A narrow, opinionated subtitle editor built around one workflow: take an existing
`.srt`, tag every line with a coloured speaker, fine-tune timing on a waveform,
and export something ready to burn into video.

It is not a Subtitle Edit replacement in general — it is faster than Subtitle Edit
for this specific loop only.

## The loop

1. Open a video — via the button, by dragging it onto the window, or as a
   command-line argument. A sibling `.sstproj`, `.captions.json` or `.srt` is
   picked up automatically. The project you had open last reopens on launch.
2. Tag each line with a speaker (`1`–`9`), each speaker having a colour.
3. Fine-tune timing by dragging regions on the waveform.
4. Optionally ask an AI to propose the next line of dialogue.
5. Export `.srt` (plain), `.ass` (coloured), or burn the subtitles into an MP4.

## Requirements

- **Windows** with the WebView2 runtime (present by default on Windows 11).
- **ffmpeg / ffprobe on `PATH`** — used for the waveform, media probing, and
  burn-in. Without them the app still edits text and timecodes, but there is no
  waveform and no rendering.
  If they are installed somewhere off `PATH`, point at them with the
  `SUBSUBTITLE_FFMPEG` and `SUBSUBTITLE_FFPROBE` environment variables.

Video playback uses the system webview, so stick to **MP4 / H.264 + AAC**. An
`.mkv` container or HEVC video will probe and produce a waveform but will not
play in the preview.

## Files

| File | Role |
|---|---|
| `<name>.sstproj` | The project file — cues, speakers, colours, and the path of the video. This is the native save format. |
| `<name>.captions.json` | The legacy sidecar. Still read when opening a bare video; no longer written. |
| `<name>.srt` | Import source, and a plain export with speaker data stripped for portability. |
| `<name>.ass` | Styled export: one `Style` per speaker, `Actor` set per line. This is what renders colour on burn-in. |
| `<name>.subtitled.mp4` | Default burn-in output. |

`Save` (Ctrl+S) writes the project file only. The `.srt` and `.ass` exports are
explicit actions, so an export never silently overwrites your source subtitles.

## Projects

A project holds the cues, the speakers, and a *reference* to the video — the
video itself is never copied, so projects stay tiny and the same footage can back
several of them. Save As suggests `<video>.sstproj` next to the video, but the
file can live anywhere.

- **New** (Ctrl+N), **Open project…** (Ctrl+O), **Save** (Ctrl+S), **Save As…**
  (Ctrl+Shift+S).
- **Recent ▾** lists the last ten projects; pick one to switch.
- The project open when the app closed reopens on the next launch. A file passed
  on the command line wins over it.
- Anything that would discard unsaved edits — New, opening another project or
  video, closing the window — asks first. The window title carries the project
  name and a `•` while there are unsaved changes.
- If the video has moved, the project still opens with its cues and offers
  **Locate video…** to re-point it.

`lastProject` and the recents list live in `state.json` in the app config
directory, beside `settings.json` — they are per-machine, not part of any project.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `1`–`9` | Assign speaker N to the selected cue |
| `0` | Clear the selected cue's speaker |
| `S` | Split the selected cue at the playhead |
| `M` | Merge the selected cue with the next |
| `[` / `]` or `,` / `.` | Nudge cue start earlier / later by one frame |
| `Shift` + those | Nudge cue **end** |
| `Alt` + those | Move the whole cue, keeping its duration |
| `↑` / `↓` | Select previous / next cue |
| `Enter` | Jump video and waveform to the selected cue |
| `N` | New cue at the playhead |
| `Delete` | Delete the selected cue |
| `Ctrl+G` | Generate a continuation for the selected cue |
| `Ctrl+N` | New project |
| `Ctrl+O` | Open a project |
| `Ctrl+S` | Save the project |
| `Ctrl+Shift+S` | Save the project as… |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `+` / `-` | Zoom the waveform |
| `F` | Toggle follow-playhead scrolling |
| `Alt` + scroll | Zoom the waveform, anchored at the pointer |
| scroll on waveform | Pan through time |
| `?` | Show the shortcut list |

Shortcuts are matched on **physical key position**, so `[` and `]` work on a
Norwegian layout (where they need AltGr) by pressing the keys where `[` and `]`
sit on a US board. `,` and `.` are bound to the same nudge actions as an
easier-to-reach alternative. Shortcuts are inert while a text box has focus.

## Navigating the waveform

Scroll over the waveform to pan through time; hold `Alt` and scroll to zoom,
anchored at the pointer so the moment under the cursor stays put. `+` / `-` zoom
from the keyboard, and the toolbar has a zoom slider. Zoom ranges from 5 to 600
pixels per second.

`F` toggles follow-playhead. With it on, playback drags the waveform and the cue
list along; with it off, a pan stays where you put it while the video plays.

## Transport controls

Under the video: play/pause, elapsed/total time, a volume slider with a mute
toggle, and a playback-speed selector (0.25×–2×, with a reset button when it is
not 1×). Slow speeds are the useful ones for catching exact speech onsets.

Volume, mute and speed persist between sessions in the webview's `localStorage`.
They are per-machine UI preferences, not part of the project, so they are
deliberately kept out of the project file.

## Drag and drop

Drop onto the window:

- an **`.sstproj`** — opens that project;
- a **video** — opens it as the project, picking up a sibling project, sidecar
  or `.srt`;
- an **`.srt`** — imports its cues into the video already open.

Dropping several at once prefers the project, then the video. This uses Tauri's own drag-drop events
rather than the HTML5 ones, because only those carry a real filesystem path,
which is what ffmpeg needs.

## Speaker tagging

Fastest path: select a cue and press a number key.

If the transcript already marks speakers inline (`ALEX: line`, `[Alex] line`),
the speaker panel offers **"Detect N from 'NAME:' prefixes"**. That creates the
speakers, assigns every matching cue, and strips the prefix from the text in one
step. It only offers names appearing at least twice, and never runs on its own.

## The continue-feature

Uses **OpenRouter**. The API key is stored in **Windows Credential Manager** and
is read only by the Rust backend — it is never sent to the webview.

Add the key under `Settings → OpenRouter`. Pick a model by typing in the filter
box, which queries OpenRouter's live model list rather than relying on a
hardcoded id that may have been retired.

`Ctrl+G` sends the recent lines plus the target speaker's voice notes and returns
2–3 candidates. Nothing is inserted until you press **Accept**; accepting appends
a cue after the selection with placeholder timing for you to set on the waveform.

## Burn-in

`Burn in…` re-encodes with libx264 (CRF configurable, default 18) and copies the
audio untouched. Progress is parsed from ffmpeg and the render can be cancelled
mid-encode.

The caption overlay in the preview is positioned over the video's real
letterboxed rectangle and scaled from the source resolution, so it previews the
burned-in result rather than approximating it.

## Development

```bash
npm install
npm run tauri dev     # dev server + app window
npm test              # frontend unit tests
npm run typecheck
cd src-tauri && cargo test   # backend unit tests
```

`npm run tauri build` produces the release binary and an NSIS installer under
`src-tauri/target/release/`.

Note that a **debug** build loads the frontend from the Vite dev server
(`localhost:1420`) and opens DevTools on launch. Use a release build for actual
work.

The app also accepts a video path as a command-line argument, so it can be wired
to "Open with" in Explorer:

```bash
sub-sub-title.exe "D:\footage\scene.mp4"
```

## Architecture notes

- **Waveform peaks are extracted in Rust**, not the browser: ffmpeg decodes the
  audio to mono 8 kHz PCM and reduces it to one signed peak per bucket, cached
  per file under the app cache dir. Decoding an hour of audio inside WebView2
  would blow up memory.
- **Waveform regions are windowed.** Only cues within the visible time range
  (plus a margin) become DOM nodes, so a 2000-cue project stays responsive.
- **The cue list is virtualized** for the same reason.
- **SRT parsing is deliberately forgiving** — it anchors on the `-->` line rather
  than assuming rigid blocks, tolerates CRLF, missing blank lines, and repairs
  reversed timecodes. Files are decoded with BOM sniffing and a Windows-1252
  fallback, since subtitles are frequently not UTF-8.
- **The video is served over Tauri's asset protocol**, and each opened file is
  granted to the scope at runtime rather than globbing the whole filesystem.

# sub-sub-title

A narrow, opinionated subtitle editor built around one workflow: take an existing
`.srt`, tag every line with a coloured speaker, fine-tune timing on a waveform,
and export something ready to burn into video.

It is not a Subtitle Edit replacement in general — it is faster than Subtitle Edit
for this specific loop only.

## The loop

1. Open a video — from **File ▸ Open video…**, by dragging it onto the window, or as a
   command-line argument. A sibling `.sstproj`, `.captions.json` or `.srt` is
   picked up automatically. The project you had open last reopens on launch.
2. Tag each line with a speaker (`1`–`9`), each speaker having a colour.
3. Fine-tune timing by dragging regions on the waveform.
4. Optionally have an AI write lines into timed cues, or continue the scene.
5. Export `.srt` (coloured or plain), `.ass` (coloured), or burn the subtitles
   into an MP4.

## Requirements

- **Windows** with the WebView2 runtime (present by default on Windows 11).
- **ffmpeg / ffprobe on `PATH`** — used for the waveform, media probing, and
  burn-in. Without them the app still edits text and timecodes, but there is no
  waveform and no rendering.
  If they are installed somewhere off `PATH`, point at them with the
  `SUBSUBTITLE_FFMPEG` and `SUBSUBTITLE_FFPROBE` environment variables.

Building it needs **Rust 1.98 or newer** — `harper-core`, the offline spellchecker,
does not compile on older toolchains.

Video playback uses the system webview, so stick to **MP4 / H.264 + AAC**. An
`.mkv` container or HEVC video will probe and produce a waveform but will not
play in the preview.

## Files

| File | Role |
|---|---|
| `<name>.sstproj` | The project file — cues, speakers, colours, the brief and story beats, timeline sections with their notes, and the path of the video. This is the native save format. |
| `<name>.captions.json` | The legacy sidecar. Still read when opening a bare video; no longer written. |
| `<name>.srt` | Import source, and an export that carries each speaker as a `<font color>` — or strips speaker data entirely, if you turn that off in Settings. |
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
- **File ▸ Open recent** lists the last ten projects; pick one to switch.
- The project open when the app closed reopens on the next launch. A file passed
  on the command line wins over it.
- Anything that would discard unsaved edits — New, opening another project or
  video, closing the window — asks first. The window title carries the project
  name and a `•` while there are unsaved changes.
- If the video has moved, the project still opens with its cues and offers
  **Locate video…** to re-point it.
- Reopening a project resumes at the playback position it was left at. That
  position is per-machine state, not part of the project file — watching a video
  is not an edit, and writing it there would leave every session with changes to
  save. It is kept for the ten projects in the recents list.

`lastProject` and the recents list live in `state.json` in the app config
directory, beside `settings.json` and `dictionary.json` — all three are
per-machine, not part of any project.

The project file also carries the project's own spellcheck dictionary, so
character names travel with the project rather than with the machine.

## Sections

A lane under the waveform holds named flags — a cut, the start of a scene, a
pickup to reshoot. They are working notes, kept in the project file and never
written to an SRT, an ASS or a burn-in.

A section is a single instant, not a range: it owns the span from its own flag to
the next one, so the lane always tiles the timeline and there are no gaps or
overlaps to keep tidy. Moving one therefore never has to negotiate with its
neighbours.

- `B` drops a flag at the playhead and focuses its name, so the whole gesture is
  one key press and then typing.
- `PgUp` / `PgDn` jump the playhead between flags.
- Drag a flag along the lane to move it; the neighbouring spans re-flow as you
  go, and the whole drag is one undo step.
- Right-click a flag to rename, move it to the playhead, or delete it.
  Right-click empty lane to add one there.
- The **Sections** panel in the side column lists them in time order: click a
  timecode to jump, type in the name field to rename. The timecode of the
  section the playhead is inside is highlighted.
- ✎ on a section opens its **scene note** — what is going on in that stretch.
  Fill reads the notes of every section its passage covers.

The lane is aligned to the waveform by measuring wavesurfer's own scroll content
rather than by multiplying time by the zoom level, because wavesurfer stretches
the waveform to fill the pane whenever the timeline is narrower than the
container — so the requested zoom is not always the real pixels-per-second. The
flags are then placed in percent-of-duration, the same units the cue regions use,
which is what keeps a flag and a cue edge at the same instant on the same pixel
at every zoom level.

## Menu bar

Every command lives in an in-app menu bar — **File**, **Edit**, **View**,
**Help** — rather than a row of buttons. It is drawn in the webview instead of
using Tauri's native menu, so it keeps the app's dark chrome and its items call
the same handlers as the shortcuts; the two can never drift apart. Editor
shortcuts are suspended while a menu is open, so `S` picks an item rather than
splitting a cue.

The bar also keeps the three things worth having permanently visible: the
project/cue-count label, the zoom slider, and the Follow toggle.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `1`–`9` | Assign speaker N to the selected cues |
| `0` | Clear the selected cues' speaker |
| `S` | Split the selected cue at the playhead |
| `M` | Join the selected cues, or merge with the next |
| `[` / `]` or `,` / `.` | Nudge cue start earlier / later by one frame |
| `Shift` + those | Nudge cue **end** |
| `Alt` + those | Move the whole selection, keeping each duration |
| `↑` / `↓` | Select previous / next cue |
| `Enter` | Jump video and waveform to the selected cue |
| `N` | New cue at the playhead |
| `Ctrl+V` | Paste clipboard text as a new cue at the playhead |
| `R` | Fit the selected cues' length to the target reading speed |
| `T` | Mark the selected cues as thinking, or spoken again |
| `B` | Flag a section at the playhead, ready to name |
| `PgUp` / `PgDn` | Jump to the previous / next section |
| `Delete` | Delete the selected cues |
| `Ctrl+A` / `Esc` | Select every cue / clear the selection |
| `Ctrl+D` | Duplicate the selected cue |
| `Ctrl+F` | Find and replace across cues |
| `Ctrl+G` | Fill the selected cues with AI, or continue after them |
| `Tab` / `Ctrl+→` (in a cue) | Accept the grey autocomplete suggestion / its next word |
| `Ctrl+Shift+Space` | Turn cue autocomplete on / off |
| `Ctrl+N` | New project |
| `Ctrl+O` | Open a project |
| `Ctrl+S` | Save the project |
| `Ctrl+Shift+S` | Save the project as… |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `+` / `-` | Zoom the waveform |
| `Z` | Zoom to fit the whole timeline |
| `F` | Toggle follow-playhead scrolling |
| `Alt` + scroll | Zoom the waveform, anchored at the pointer |
| scroll on waveform | Pan through time |
| `?` | Show the shortcut list |

Shortcuts are matched on **physical key position**, so `[` and `]` work on a
Norwegian layout (where they need AltGr) by pressing the keys where `[` and `]`
sit on a US board. `,` and `.` are bound to the same nudge actions as an
easier-to-reach alternative. Shortcuts are inert while a text box has focus —
including `Ctrl+V`, which pastes into a cue's text field as usual rather than
creating a cue.

A new cue is always left selected, so `1`–`9` assign its speaker straight away.
`R` and pasted cues both aim for the **target reading speed** set under
Settings ▸ Timing and readability (17 characters per second by default); a cue
boxed in by its neighbours grows only as far as the minimum gap allows.

## Selecting and editing cues

Click a cue in the list or on the waveform to select it. `Ctrl`+click adds or
removes one, `Shift`+click extends the run, and `Ctrl+A` takes all of them.
Delete, speaker assignment, join, and whole-cue nudges act on the entire
selection in a single undo step; splitting and duplicating act on the last cue
touched, which carries a brighter accent in the list.

Right-click a cue — in the list or on its waveform region — for the same
commands the Edit menu offers, aimed at what is under the pointer. Inside the
text and timecode fields the webview's own Cut/Copy/Paste menu appears instead.

**Cues may not overlap.** Dragging an edge stops at the neighbour, leaving the
minimum gap from Settings (0.04 s by default). Dragging a *whole* cue is freer:
it travels across a neighbour once its midpoint passes, which is how two cues
swap places. A drag with nowhere to land leaves the cue where it was. Material
imported from elsewhere can still arrive overlapped; **Edit ▸ Fix overlapping
cues** pulls it apart in one step, trimming the earlier cue where that leaves it
long enough to read and pushing the later one back otherwise.

The two numbers at the right of each row are the per-line character counts and
the reading speed. A line past the limit (42 characters) turns amber; a cue with
more lines than fit on screen (2) turns the whole column red. Both limits live
in Settings, and neither rewrites anything — they only flag.

`Ctrl+F` opens find and replace across cue text. Stepping through matches
selects each cue and seeks to it; Replace and Replace-all are each one undo step.

## Spelling

Two checkers, both optional, both reporting into the same place — a badge at the
right of the cue row, and the entries at the top of that cue's right-click menu.
Nothing is ever corrected automatically.

**Offline, as you type.** [Harper](https://writewithharper.com/) runs in the Rust
backend: no network, no model, no setup. It flags misspellings (red), and grammar,
agreement, capitalisation and punctuation errors (amber). Only error categories are
reported — Harper's style, readability and word-choice advice is suppressed, because
dialogue is *meant* to be colloquial, repetitive and full of fragments. A handful of
rules that fight subtitling conventions are off for the same reason: sentence
capitalisation (a cue often continues the previous cue's sentence), ellipsis and dash
normalisation, and the advice against contractions, filler words and swearing.
It is **English only**; American or British, chosen in Settings.

**Optional AI pass.** `Edit ▸ Proofread with AI…` sends the cue text to OpenRouter in
batches with a progress bar and a cancel button, and asks for corrections to spelling,
grammar and punctuation only. Its findings land on the cues as blue suggestions
offering the whole rewritten line. Unlike the offline checker it sees a cue's
neighbours, so it catches what a single-cue check cannot — a homophone that is a real
word, a name spelled two ways. It is the only part of spellcheck that sends anything
anywhere.

Two dictionaries hold the words neither checker should touch:

| Where | For | Stored in |
|---|---|---|
| *Ignore in this project* | Character names, invented places, in-world terms | the `.sstproj` |
| *Add to dictionary* | Your own vocabulary, every project | `dictionary.json` in the app config dir |

## Navigating the waveform

Scroll over the waveform to pan through time; hold `Alt` and scroll to zoom,
anchored at the pointer so the moment under the cursor stays put. `+` / `-` zoom
from the keyboard, and the toolbar has a zoom slider (on a log scale). Zoom
ranges from 600 pixels per second down to 0.01 — hours on one screen — and
**Fit** (or `Z`) zooms until the whole timeline fits. The Voiceover and Edit
timelines zoom the same way, and their rulers count in hours once that is
what fits.

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

In the Edit tab, dropped videos and images are added to the edit instead.

Dropping several at once prefers the project, then the video. This uses Tauri's own drag-drop events
rather than the HTML5 ones, because only those carry a real filesystem path,
which is what ffmpeg needs.

## Speaker tagging

Fastest path: select one or more cues and press a number key.

Each speaker's colour opens a small palette — the nine built-in hues, the
colours already used in this project, and the ones picked recently — with the
system colour dialog behind **Custom** for anything else. The colour is the
caption's text colour in both the preview and the burn-in.

If the transcript already marks speakers inline (`ALEX: line`, `[Alex] line`),
the speaker panel offers **"Detect N from 'NAME:' prefixes"**. That creates the
speakers, assigns every matching cue, and strips the prefix from the text in one
step. It only offers names appearing at least twice, and never runs on its own.

An `.srt` that marks speakers by colour instead — `<font color="#ff0000">` around
each cue, the convention most subtitle tools use — is translated on import
without asking: one speaker per colour, named `Speaker 1`, `Speaker 2`… in order
of first appearance, keeping the file's own colours. The tags are stripped from
the cue text, `<i>` and friends are left alone, and a colour already used by a
speaker in the project reuses that speaker rather than duplicating it — so
re-importing a corrected export keeps the names and voice notes you typed.

Exporting `.srt` writes those tags back out. To get a bare `.srt` with no speaker
data, clear **Write speaker colours into exported .srt** under Settings ▸
Subtitle export.

## Fill — writing with AI

Uses **OpenRouter**. The API key is stored in **Windows Credential Manager** and
is read only by the Rust backend — it is never sent to the webview.

Add the key under `Settings → OpenRouter`. Pick a model by typing in the filter
box, which queries OpenRouter's live model list rather than relying on a
hardcoded id that may have been retired.

Fill writes into **slots**, not after them. Timing comes first — you have already
seen where a mouth moves on the waveform — and the words are written to fit it:
each slot's character limit is its time on screen at the target reading speed,
capped by the line limits. `Ctrl+G` (or right-click ▸ **Fill with AI…**) opens the
dialog on the selection, in one of two modes:

- **Fill** — the selected cues are the slots. They keep their timing; empty ones
  are written, and ones that already hold text are either built on or rewritten.
  This is the mode the dialog opens in when the selection holds an empty cue.
- **Continue** — 1–8 new lines after the selection, or after the playhead with
  nothing selected. Their timing follows from their text, laid end to end in the
  gap before the next cue, and the dialog refuses rather than overlap that cue.

### The dialog

The left column, **Context**, is everything the model reads, editable in place:

| Context | Stored in |
|---|---|
| Project brief — premise, tone, world | the `.sstproj` |
| Story beats — written by hand, or generated from the whole script | the `.sstproj` |
| Characters — each speaker's *voice* and *inner voice* | the `.sstproj` |
| Scene notes — one per section covering the passage | the `.sstproj` |
| The transcript around the slots, with how many lines before and after | settings |

Below it, **Exact prompt** shows the full request as it stands, with a Copy button.

The right column, **Direction**, is what you want this time: per slot, who speaks
and whether it is said or thought (either may be left to the model); a free-text
direction, with a list of recent ones; **creative latitude** — *Close*, *Open* or
*Wild*; and how many **takes** to ask for. `Ctrl+Enter` anywhere in the dialog
writes.

Each take fills every slot, and the takes are asked to be different readings of
the moment, not rewordings. Under each slot the lines from every take are listed;
click one to use it, or **Use take B** to switch every slot at once. The chosen
line stays editable, with its speaker, said/thought, and a character count that
turns red past the limit. **Fill cues** / **Add lines** lands everything as one
undo step, re-wrapped to the line limits.

### Speech and thought

The transcript marks every line as `Name says:` or `Name thinks:`, and the prompt
spells out what that means: other characters cannot hear or answer a thought, a
thought may contradict what the same character says aloud, and thoughts run
shorter and more honest than speech. A speaker's **inner voice** notes (Speakers
panel ✎, or the dialog) describe how they think when it differs from how they
talk. A slot set to *Model decides* lets the model choose between the two.

### The prompt

The system prompt has three layers:

1. **Writing guidance** — craft (subtext, specificity, spoken rhythm, no stock
   lines) and speech versus thought. `Settings ▸ Fill` can replace it wholesale,
   starting from the built-in text, with a reset.
2. **Your instructions** from `Settings ▸ Fill` — language, dialect, house rules.
   They follow the guidance and win where the two disagree. The style notes of
   the old continue-feature carry over into this field.
3. **Conventions** — how to read the transcript, the hard limits, and the JSON
   reply format. Always appended and not editable, so a reply can still be read.

The user message carries the brief, beats, characters, scene notes, transcript and
task, with your direction last. The prompt is assembled in the frontend
(`src/lib/fill.ts`) so the dialog can show it exactly; the backend only adds the
key and makes the call.

## Autocomplete — grey text while typing

While you type in a cue, a suggestion for the rest of the line appears in grey
after the caret, the way a code editor completes a line. **Tab** accepts it,
**Ctrl+→** accepts one word, **Esc** dismisses it until you type again. Focusing
an empty cue suggests a whole line. Suggestions only appear with the caret at the
end of the cue. **Ctrl+Shift+Space** (or View ▸ Autocomplete cue text) turns the
feature on and off.

The model sees the cues before and after the one you are typing, the speaker's
voice notes (and inner voice, for a thought), and a character budget worked out
from the cue's time on screen at the target reading speed.

It runs on its own model, set in `Settings ▸ Autocomplete`, because it fires on
every pause in typing: pick something small, fast and non-reasoning
(`google/gemini-2.5-flash-lite` by default). To keep the bill down:

- a request goes out only after a typing pause (350 ms by default);
- typing the characters the suggestion already shows just shortens it — no request;
- suggestions are cached per cue text, so backspacing and retyping is free;
- a newer request aborts the one in flight, and leaving the cue cancels it;
- replies are capped at a few dozen tokens and stop at a blank line;
- the prompt puts what you have typed last, so a provider's prefix cache covers
  the rest while you type in one cue.

A failed request (no key, a retired model id) pauses autocomplete with one error
toast until its settings change. The prompt is built in `src/lib/ghost.ts`.

## Chat — thinking out loud

The Chat panel under Sections is a conversation with a model that already knows
the project: the brief, story beats, speakers with their voice notes, and the
section you are in. Those are rebuilt on every message, so edits show up at once.
Nothing it writes goes into the script — except when you ask it to.

**/continue** hands it the next stretch of the timeline to write itself:
`/continue 45 Ben finally admits it` gives it the 45 seconds from the playhead
(30 when you leave the number out) and your direction. It reads the script
around the window, then adds, edits, moves and deletes lines inside it — never
outside — checking its own reading speed as it goes. Changes land on the
timeline live and the chat lists each one; when it is done the whole run is a
single **Ctrl+Z**. **Stop** ends a run early and keeps what it did. The
conversation remembers a one-line summary, so you can talk about what it wrote.
It needs a chat model that supports tool calling on OpenRouter. The tools and
prompt live in `src/lib/agent.ts`.

Pick a **vision model** under Chat in Settings (the list shows only models that
take images) and a run can also look at the video. It grabs a frame with ffmpeg
and has the vision model describe it: setting, who is in shot, what they are
doing, the mood. It gets up to 6 looks per run. The descriptions are hints: the
run is told they can be wrong and that the script, brief and your direction
always win, and a failed or refused look is skipped rather than retried. Each
look shows as **👁 Looked at…** in the chat; click it to read the description.
Frames go to OpenRouter and the model's provider; only the text reaches the run.
With no vision model set, `/continue` works from the script alone.

When the direction is genuinely open — you gave little of it and the scene
could go very different ways — a run may **ask you** first, at most twice. The
question takes the place of the chat box: pick an option (or press its number),
answer in your own words, or **Skip** (**Esc**) to leave it to the model.
Questions are about where the scene goes, whose beat it is, tone and pace —
never about approving particular lines. **Stop** works there too.

## Story outline — timed beats and /story

Each row on the **Sections** tab of the Story panel opens with **▸**: the section's note, and its
**timed story beats** — what happens, or should happen, at a moment. **+ Beat**
adds one at the playhead (or the section's start); click a beat's time to jump
there and retype it. Beats belong to their moment, not to a flag, so moving or
removing a section never loses one. The note and the beats of the stretch being
written go along with `/continue`, Fill and the chat, so new lines head where the
story is meant to go.

**/story** (or **✦ Story** in the Story panel header, which puts it into the chat
box) lets a story agent work on the outline. It reads the script section by
section, looks at key frames when a vision model is set, and asks you about the
big forks — what the story is about, where it ends, what a character wants —
before it writes section names, notes, timed beats and the overall beats,
looking for an arc that fits what is already on screen. It can ask up to 8
questions and look at up to 12 frames per run. Its beats are marked **✦**; your
own beats are fixed points it builds around and never changes (edit one of its
beats and it becomes yours). It never touches the subtitle lines, its edits show
up live, and one **Ctrl+Z** undoes the whole run. The tools and prompt live in
`src/lib/storyAgent.ts`.

**📎 Last N** attaches the N lines up to and including the selected cue, or up
to the playhead when nothing is selected. The lines appear as a chip over the
prompt box: click it to read them, ✕ to drop them. They are captured when you
attach them, so later edits don't change what you asked about. Set N next to the
button; it is remembered.

**Enter** sends and **Shift+Enter** starts a new line. Replies stream in, and
**Stop** (or **Esc**) ends one early, keeping what it had written so far. Point at one of your messages and click
**✎ Edit** to rewrite it (and drop its attached lines, if you like). Sending the
edit throws away everything after that message and asks again from there, even
while a reply is still streaming. **Reset**
clears the conversation, and so does opening another video. The panel's height
is set by dragging the divider above it. Chat uses the main model and temperature
from Settings, and the conversation is built in `src/lib/chat.ts`.

## Edit — cutting before subtitling

The **Edit** tab (first of the three) cuts one or more videos into a sequence and
bakes the result into a new MP4, which then becomes the project's video. The
Subtitles and Voiceover tabs carry on with that file as if it had been opened, so
nothing downstream knows an edit happened. A project that never opens the tab
behaves as before.

- **Start** from the open video (*Start an edit from this video*), or add videos
  and images with *Add files…* or by dropping them on the window. In this tab a
  dropped video joins the edit instead of opening as a new project.
- **The main track** holds clips end to end; they never overlap, and a gap is
  black and silent. Drag a clip to move it, drag its edges to trim, and drag the
  small handles in its top corners to fade. Drag a file from the *Media* list
  onto the track, or double-click it to add it at the end.
- **Fades** go to and from black, picture and sound together, so a clip that
  fades out followed by one that fades in dips to black between them.
- **Overlays** draw over the main track: images and text on overlay tracks,
  the top lane drawn on top (rename and reorder them in their headers).
  **+ Text** adds a text item at the playhead; double-clicking an image in
  *Media* places it there too, each on the topmost overlay track that is free
  at that moment. Overlay video plays silent.
- **Place and size** every item, the main clip included, in the *Item* tab: X
  and Y are the centre as a percentage of the canvas, and 100% scale fits a
  picture inside the canvas (for text, its drawn size). Drag the selected item
  on the picture to move it.
- **Motion** comes from keys. Select an item, put the playhead where a move
  should start and press **◆ Add key** (on a still item this keys its start
  and end), then go to another moment and change X, Y or Scale — or drag the
  picture — and that moment is keyed too. Between keys the item moves in a
  straight line at a steady rate. Keys show as diamonds on the item: drag one
  to retime it, click it to go there; ◀ ▶ step between them, and *Remove
  motion* keeps the place at the playhead.
- **Text** has a font (any installed family), size, weight, colour, alignment,
  and optional outline, shadow and box. It is drawn to a PNG in the app, and
  the bake overlays that same image, so the preview shows exactly what is
  baked and ffmpeg never needs the font.
- **Templates** keep overlay text and stills to reuse. Select items on overlay
  tracks (Ctrl/Shift+click picks several) and press *Save as template…*: the
  `.sstoverlay` file keeps their layering, places, styles, fades and timing,
  and carries its images inside, so it works anywhere. Templates live in a
  library listed under *Media*; *Insert* drops one at the playhead on free
  overlay tracks (its images written to the project's `<name> assets` folder),
  and *Import…* copies a template file into the library.
- **Teasers:** *Set teaser end* puts a cutoff marker at the playhead (drag
  its flag; right-click removes it). The *Teaser* tab picks a post-teaser
  screen — any template, or black — how long it shows, and a fade at the
  cut. *Export Teaser…* (also in the File menu) renders the finished look up
  to the marker — subtitles burned in, the voiceover mix as sound, as *Burn
  in* makes them — then the screen, in silence. It needs a current bake: the
  marker is in the edit's time, the subtitles in the baked video's.
- **Keys:** `Space` plays, `S` splits at the playhead, `Delete` removes the
  selected items, `←` `→` (or `[` `]`) move one by a frame, and `Z` fits the
  timeline. Every change undoes like any other.
- **Bake…** writes `<project>.cut.mp4` beside the project file (beside the first
  source if the project is unsaved). Re-baking takes the next free name
  (`.cut-2.mp4`, …), switches the project to it, and sends the previous bake to
  the Recycle Bin. The chip beside the button says whether the last bake still
  matches the cut.
- **Re-cutting moves the timing with it.** Each bake records which stretch of
  which source every part of the video came from, so a bake traces cues,
  sections, timed beats, voice clips and gain points back to their footage and
  on to wherever the new cut shows it — subtitles written on the raw video
  follow it into the first cut, too. The bake dialog says beforehand what will
  move. Anything whose footage was cut is not deleted: it is parked after the
  end of the new video, in order, flagged ✂ in the cue list and listed in the
  Edit tab's **Re-cut** panel (click an entry to go to it; *Delete all lost*
  clears them). A cue a cut runs through moves with its larger part and is
  flagged ⋯. A flag goes once the item is moved, and one undo puts back both
  the old video and the old timing.

The preview has its own clock, with a small pool of `<video>` elements slaved to
it; the next clip is loaded and seeked a couple of seconds before its cut. It
plays what the webview can decode (H.264, VP8/9, AV1); other codecs are flagged
in the media list but bake fine. The bake places every layer with the same
functions the preview uses, and the edit's canvas size and frame rate are set
on the *Canvas* tab.

## Burn-in

`Burn in…` re-encodes with libx264 (CRF configurable, default 18) and copies the
audio untouched. Progress is parsed from ffmpeg and the render can be cancelled
mid-encode.

The caption overlay in the preview is positioned over the video's real
letterboxed rectangle and scaled from the source resolution, so it previews the
burned-in result rather than approximating it. Font, size, bold, outline width
and colour, shadow depth and colour, and the bottom margin all come from the
same settings the `.ass` style is written from: the preview draws the outline
with a real text stroke behind the fill, at twice the `.ass` outline width
because libass measures outwards and CSS strokes from the centre. An outline of
0 draws none, in both.

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
- **The Edit tab bakes rather than composes live.** TypeScript resolves the cut
  into a render plan in output pixels and seconds (`src/lib/editPlan.ts`); Rust
  turns the plan into an ffmpeg filter graph (`src-tauri/src/edit.rs`): a black
  base, each clip seeked at the demuxer (`-ss`/`-t` per input, so a clip late in
  a long file does not decode what comes before it), faded in alpha and laid
  over with `overlay` in planar RGB (a 4:2:0 base would snap odd positions to
  even pixels). A moving layer is scaled once to its largest size and placed
  frame by frame with `perspective`, which resamples with sub-pixel
  precision, so a slow push-in glides instead of stepping a whole pixel at a
  time; it is resampled with premultiplied alpha, so its edges move as evenly
  as its middle. The graph holds no paths and goes in a file
  (`-filter_complex_script`), since Windows caps a command line at 32k
  characters.
- **The video is served over Tauri's asset protocol**, and each opened file is
  granted to the scope at runtime rather than globbing the whole filesystem.
- **Voice templates live beside the app, not a project.** A voice built in the
  Cast panel — *From video…* from the project's own cues, or *File…* from
  stretches marked on the waveform of any other video or audio file — can be
  kept as a template: a copy of the reference clip in the app's local data
  folder (`voice-templates/`, indexed by `templates.json`). Both routes run the
  same isolation (Demucs, trimming, cleanest lines first). A speaker using a
  template references its file directly, so switching templates marks their
  lines as changed; deleting one sends its clip to the Recycle Bin.

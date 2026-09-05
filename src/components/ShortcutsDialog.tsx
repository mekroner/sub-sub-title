const SHORTCUTS: Array<[string, string]> = [
  ["Space", "Play / pause"],
  ["Click", "Select a cue — Ctrl+click adds, Shift+click extends"],
  ["Ctrl + A / Esc", "Select every cue / clear the selection"],
  ["Right-click", "Cue commands for the clicked cue or the selection"],
  ["1 – 9", "Assign speaker N to the selected cues"],
  ["0", "Clear the selected cues' speaker"],
  ["S", "Split the selected cue at the playhead"],
  ["M", "Join the selected cues (or merge with the next)"],
  ["Ctrl + D", "Duplicate the selected cue"],
  ["Ctrl + F", "Find and replace across cues"],
  ["[  /  ]", "Nudge cue start earlier / later by one frame"],
  ["Shift + [  /  ]", "Nudge cue end earlier / later by one frame"],
  ["Alt + [  /  ]", "Move the whole selection earlier / later by one frame"],
  ["↑ / ↓", "Select previous / next cue"],
  ["Enter", "Jump video and waveform to the selected cue"],
  ["N", "New cue at the playhead"],
  ["Delete", "Delete the selected cues"],
  ["Ctrl + G", "Generate a continuation for the selected cue"],
  ["Ctrl + N", "New project"],
  ["Ctrl + O", "Open a project"],
  ["Ctrl + S", "Save the project"],
  ["Ctrl + Shift + S", "Save the project as…"],
  ["Ctrl + Z / Ctrl + Y", "Undo / redo"],
  ["+ / −", "Zoom the waveform in / out"],
  ["Alt + scroll", "Zoom the waveform, anchored at the pointer"],
  ["Scroll on waveform", "Pan through time"],
  ["F", "Toggle follow-playhead scrolling"],
  ["?", "Show this list"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal narrow"
        tabIndex={-1}
        // Autofocus, so Escape reaches the dialog rather than the editor.
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
      >
        <header className="modal-header">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <table className="shortcut-table">
            <tbody>
              {SHORTCUTS.map(([key, action]) => (
                <tr key={key}>
                  <td>
                    <kbd>{key}</kbd>
                  </td>
                  <td>{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Shortcuts are inert while a text box has focus, so typing in a cue never
            triggers them.
          </p>
        </div>
      </div>
    </div>
  );
}

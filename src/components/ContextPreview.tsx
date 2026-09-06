import type { Cue, Speaker } from "../types";

/** The dialogue an AI continuation is about to be given, as the panels show it. */
export function ContextPreview({
  context,
  speakers,
}: {
  context: Cue[];
  speakers: Speaker[];
}) {
  return (
    <div className="context-preview">
      {context.length === 0 ? (
        <p className="hint">No preceding lines to use as context.</p>
      ) : (
        context.map((cue) => (
          <div className="context-line" key={cue.id}>
            <span
              className="swatch small"
              style={{
                background:
                  speakers.find((s) => s.id === cue.speakerId)?.color ??
                  "transparent",
              }}
              aria-hidden
            />
            <span className="context-speaker">
              {speakers.find((s) => s.id === cue.speakerId)?.name ?? "—"}
            </span>
            <span className="context-text">{cue.text.replace(/\n/g, " ")}</span>
          </div>
        ))
      )}
    </div>
  );
}

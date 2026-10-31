import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Edit, EditCanvas, EditItem } from "../../types";
import {
  MAX_FPS,
  MIN_FPS,
  itemEnd,
  previewUnsupported,
  sourceName,
  sourceOf,
  type ItemPatch,
} from "../../lib/edit";
import { MAX_DB, MIN_DB } from "../../lib/voiceover";
import { formatDuration, formatShort } from "../../lib/time";

export type EditSideTab = "media" | "item" | "canvas";

const TABS: Array<{ id: EditSideTab; label: string; title: string }> = [
  { id: "media", label: "Media", title: "The files this edit draws from" },
  { id: "item", label: "Item", title: "The selected item's fades, level and gain" },
  { id: "canvas", label: "Canvas", title: "The bake's size and frame rate" },
];

interface Props {
  edit: Edit;
  tab: EditSideTab;
  onTab: (tab: EditSideTab) => void;
  selected: EditItem | null;
  onAddFiles: () => void;
  /** Starts dragging a source towards the timeline. */
  onSourcePointerDown: (e: ReactPointerEvent<HTMLElement>, sourceId: string) => void;
  /** Appends a source to the end of the main track. */
  onAppendSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onPatchItem: (id: string, patch: ItemPatch, field: string) => void;
  onCanvas: (canvas: EditCanvas) => void;
}

export function EditSidePanel(props: Props) {
  const { tab, onTab } = props;
  return (
    <>
      <div className="segmented wide side-tabs" role="tablist" aria-label="Edit side panel">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "small on" : "small"}
            onClick={() => onTab(t.id)}
            title={t.title}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="side-tab-body" hidden={tab !== "media"}>
        <MediaBin {...props} />
      </div>
      <div className="side-tab-body" hidden={tab !== "item"}>
        <Inspector {...props} />
      </div>
      <div className="side-tab-body" hidden={tab !== "canvas"}>
        <CanvasPanel {...props} />
      </div>
    </>
  );
}

function MediaBin({ edit, onAddFiles, onSourcePointerDown, onAppendSource, onRemoveSource }: Props) {
  return (
    <div className="panel edit-bin">
      <div className="panel-header">
        <h2>Media</h2>
        <button type="button" className="small" onClick={onAddFiles}>
          Add files…
        </button>
      </div>
      {edit.sources.length === 0 ? (
        <p className="hint edit-pad">Drop videos or images here, or add them with the button above.</p>
      ) : (
        <ul className="edit-bin-list">
          {edit.sources.map((source) => {
            const used = edit.items.filter((i) => "sourceId" in i && i.sourceId === source.id).length;
            const warn = previewUnsupported(source);
            return (
              <li
                key={source.id}
                className="edit-bin-entry"
                title={`${source.path}\nDrag onto a track, or double-click to add it to the end of the main track.`}
                onPointerDown={(e) => onSourcePointerDown(e, source.id)}
                onDoubleClick={() => onAppendSource(source.id)}
              >
                <span className="edit-bin-kind">{source.kind === "video" ? "▶" : "▣"}</span>
                <span className="edit-bin-text">
                  <span className="edit-bin-name">{sourceName(source)}</span>
                  <span className="edit-bin-facts">
                    {source.width}×{source.height}
                    {source.kind === "video" && ` · ${formatDuration(source.duration)}`}
                    {source.kind === "video" && !source.hasAudio && " · no audio"}
                    {used > 0 && ` · used ${used}×`}
                  </span>
                  {warn && (
                    <span className="edit-bin-warn">
                      ⚠ {source.videoCodec}: the preview may not play this. The bake will.
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="vo-ms"
                  title="Remove from the edit, with every item that uses it"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemoveSource(source.id)}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A number field that commits on every valid change, merged into one undo step per field. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  return (
    <label className="clip-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) {
            onChange(Math.min(max, Math.max(min, n)));
          }
        }}
        onBlur={() => setText(String(round(value)))}
      />
      {unit && <span className="edit-unit">{unit}</span>}
    </label>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function Inspector({ edit, selected, onPatchItem }: Props) {
  if (!selected) {
    return (
      <div className="panel clip-inspector">
        <p className="hint clip-inspector-empty">Select an item on the timeline to see its settings.</p>
      </div>
    );
  }
  const source = sourceOf(edit, selected);
  const patch = (field: string) => (value: number) =>
    onPatchItem(selected.id, { [field]: value } as ItemPatch, field);
  return (
    <div className="panel clip-inspector">
      <div className="clip-inspector-body">
        <div className="clip-facts">
          <span>Item</span>
          <span>{selected.kind === "text" ? selected.text : source ? sourceName(source) : "—"}</span>
          <span>Time</span>
          <span>
            {formatShort(selected.start)} – {formatShort(itemEnd(selected))} ({round(selected.duration)} s)
          </span>
          {selected.kind === "video" && (
            <>
              <span>From</span>
              <span>{formatShort(selected.offset)} into the source</span>
            </>
          )}
          {source && (
            <>
              <span>File</span>
              <span className="clip-path" title={source.path}>
                {source.path}
              </span>
            </>
          )}
        </div>
        <NumberField label="Fade in" value={selected.fadeIn} min={0} max={selected.duration} step={0.1} unit="s" onChange={patch("fadeIn")} />
        <NumberField label="Fade out" value={selected.fadeOut} min={0} max={selected.duration} step={0.1} unit="s" onChange={patch("fadeOut")} />
        <label className="clip-field">
          <span>Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={selected.opacity}
            onChange={(e) => patch("opacity")(Number(e.target.value))}
          />
          <span className="edit-unit">{Math.round(selected.opacity * 100)}%</span>
        </label>
        {selected.kind === "video" && (
          <NumberField label="Gain" value={selected.gainDb} min={MIN_DB} max={MAX_DB} step={0.5} unit="dB" onChange={patch("gainDb")} />
        )}
        <p className="hint">
          Fades go to and from black, picture and sound together. Two clips that fade out and in
          dip to black between them.
        </p>
      </div>
    </div>
  );
}

function CanvasPanel({ edit, onCanvas }: Props) {
  const [draft, setDraft] = useState(edit.canvas);
  useEffect(() => setDraft(edit.canvas), [edit.canvas]);
  const changed =
    draft.width !== edit.canvas.width || draft.height !== edit.canvas.height || draft.fps !== edit.canvas.fps;
  const valid = draft.width >= 16 && draft.height >= 16 && draft.fps >= MIN_FPS && draft.fps <= MAX_FPS;
  return (
    <div className="panel clip-inspector">
      <div className="clip-inspector-body">
        <label className="clip-field">
          <span>Width</span>
          <input type="number" min={16} step={2} value={draft.width} onChange={(e) => setDraft({ ...draft, width: Number(e.target.value) })} />
          <span className="edit-unit">px</span>
        </label>
        <label className="clip-field">
          <span>Height</span>
          <input type="number" min={16} step={2} value={draft.height} onChange={(e) => setDraft({ ...draft, height: Number(e.target.value) })} />
          <span className="edit-unit">px</span>
        </label>
        <label className="clip-field">
          <span>Rate</span>
          <input type="number" min={MIN_FPS} max={MAX_FPS} step={0.001} value={draft.fps} onChange={(e) => setDraft({ ...draft, fps: Number(e.target.value) })} />
          <span className="edit-unit">fps</span>
        </label>
        <div className="clip-actions">
          <button type="button" className="primary" disabled={!changed || !valid} onClick={() => onCanvas(draft)}>
            Apply
          </button>
          <button type="button" disabled={!changed} onClick={() => setDraft(edit.canvas)}>
            Reset
          </button>
        </div>
        <p className="hint">
          Sizes are rounded to even numbers. Positions keep their place on a new size, and text
          scales with the height.
        </p>
      </div>
    </div>
  );
}

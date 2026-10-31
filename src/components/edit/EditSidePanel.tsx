import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { Edit, EditCanvas, EditItem, TextItem, TextStyle, TransformKey } from "../../types";
import {
  MAX_FPS,
  MIN_FPS,
  itemEnd,
  previewUnsupported,
  sourceName,
  sourceOf,
  DEFAULT_TEXT_STYLE,
  MAX_SCALE,
  MIN_SCALE,
  type ItemPatch,
} from "../../lib/edit";
import { ColorPicker } from "../ColorPicker";
import { MAX_DB, MIN_DB } from "../../lib/voiceover";
import { formatDuration, formatShort } from "../../lib/time";

export type EditSideTab = "media" | "item" | "canvas";

const TABS: Array<{ id: EditSideTab; label: string; title: string }> = [
  { id: "media", label: "Media", title: "The files this edit draws from" },
  { id: "item", label: "Item", title: "The selected item: place, size, fades, text" },
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
  /** Adds a source to the timeline: a video at the end of the main track, an image at the playhead. */
  onAppendSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onPatchItem: (id: string, patch: ItemPatch, field: string) => void;
  /** Changes a static item's place or size; `field` keys the undo step. */
  onTransform: (id: string, patch: Partial<Omit<TransformKey, "time">>, field: string) => void;
  onText: (id: string, text: string) => void;
  onTextStyle: (id: string, patch: TextStylePatch, field: string) => void;
  onCanvas: (canvas: EditCanvas) => void;
}

/** A change to a text style; `null` takes an effect away. */
export type TextStylePatch = Partial<Omit<TextStyle, "outline" | "shadow" | "background">> & {
  outline?: TextStyle["outline"] | null;
  shadow?: TextStyle["shadow"] | null;
  background?: TextStyle["background"] | null;
};

/** Offered in the font field; any installed family can be typed in. */
const FONT_SUGGESTIONS = [
  "Arial",
  "Helvetica",
  "Segoe UI",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Impact",
  "Trebuchet MS",
];

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
                title={`${source.path}\nDrag onto a track, or double-click to add it ${
                  source.kind === "video" ? "to the end of the main track" : "at the playhead"
                }.`}
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

function Inspector({ edit, selected, onPatchItem, onTransform, onText, onTextStyle }: Props) {
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
  const animated = selected.transform.length > 1;
  const key = selected.transform[0];
  return (
    <div className="panel clip-inspector">
      <div className="clip-inspector-body">
        <div className="clip-facts">
          <span>Item</span>
          <span>{selected.kind === "text" ? "Text" : source ? sourceName(source) : "—"}</span>
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

        {selected.kind === "text" && (
          <TextFields item={selected} onText={onText} onTextStyle={onTextStyle} />
        )}

        <h3 className="edit-section">Place</h3>
        {animated ? (
          <p className="hint">This item moves over time; its keys are edited one by one.</p>
        ) : (
          <>
            <NumberField
              label="X"
              value={key.x * 100}
              min={-100}
              max={200}
              step={1}
              unit="%"
              onChange={(v) => onTransform(selected.id, { x: v / 100 }, "x")}
            />
            <NumberField
              label="Y"
              value={key.y * 100}
              min={-100}
              max={200}
              step={1}
              unit="%"
              onChange={(v) => onTransform(selected.id, { y: v / 100 }, "y")}
            />
            <NumberField
              label="Scale"
              value={key.scale * 100}
              min={MIN_SCALE * 100}
              max={MAX_SCALE * 100}
              step={5}
              unit="%"
              onChange={(v) => onTransform(selected.id, { scale: v / 100 }, "scale")}
            />
            <div className="clip-actions">
              <button
                type="button"
                className="small"
                disabled={key.x === 0.5 && key.y === 0.5 && key.scale === 1}
                onClick={() => onTransform(selected.id, { x: 0.5, y: 0.5, scale: 1 }, "reset")}
              >
                Centre at 100%
              </button>
            </div>
            <p className="hint">
              {selected.kind === "text"
                ? "100% is the text at its font size. Drag it on the picture to move it."
                : "100% fits the picture inside the canvas. Drag it on the picture to move it."}
            </p>
          </>
        )}

        <h3 className="edit-section">Fades and level</h3>
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

/** The words and look of a text item. */
function TextFields({
  item,
  onText,
  onTextStyle,
}: {
  item: TextItem;
  onText: Props["onText"];
  onTextStyle: Props["onTextStyle"];
}) {
  const { style } = item;
  const set = (field: string, value: TextStylePatch) => onTextStyle(item.id, value, field);
  return (
    <>
      <h3 className="edit-section">Text</h3>
      <textarea
        className="edit-text-input"
        rows={3}
        value={item.text}
        aria-label="Text"
        onChange={(e) => onText(item.id, e.target.value)}
      />
      <label className="clip-field">
        <span>Font</span>
        <input
          list="edit-font-suggestions"
          value={style.fontFamily}
          onChange={(e) => e.target.value.trim() && set("fontFamily", { fontFamily: e.target.value })}
        />
        <datalist id="edit-font-suggestions">
          {FONT_SUGGESTIONS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <NumberField label="Size" value={style.fontSize} min={1} max={2000} step={1} unit="px" onChange={(v) => set("fontSize", { fontSize: v })} />
      <label className="clip-field">
        <span>Weight</span>
        <select value={style.weight} onChange={(e) => set("weight", { weight: Number(e.target.value) })}>
          <option value={400}>Regular</option>
          <option value={600}>Semibold</option>
          <option value={700}>Bold</option>
          <option value={900}>Black</option>
        </select>
      </label>
      <div className="clip-field">
        <span>Colour</span>
        <ColorPicker value={style.color} onChange={(color) => set("color", { color })} title="Text colour" />
        <div className="segmented edit-align" role="group" aria-label="Alignment">
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              type="button"
              className={style.align === align ? "small on" : "small"}
              aria-pressed={style.align === align}
              onClick={() => set("align", { align })}
            >
              {align === "left" ? "Left" : align === "center" ? "Centre" : "Right"}
            </button>
          ))}
        </div>
      </div>

      <Effect
        label="Outline"
        on={Boolean(style.outline)}
        onToggle={(on) => set("outline", { outline: on ? DEFAULT_TEXT_STYLE.outline ?? { color: "#000000", width: 4 } : null })}
      >
        {style.outline && (
          <>
            <ColorPicker value={style.outline.color} onChange={(color) => set("outline", { outline: { ...style.outline!, color } })} title="Outline colour" />
            <NumberField label="Width" value={style.outline.width} min={0} max={200} step={1} unit="px" onChange={(width) => set("outline", { outline: { ...style.outline!, width } })} />
          </>
        )}
      </Effect>
      <Effect
        label="Shadow"
        on={Boolean(style.shadow)}
        onToggle={(on) => set("shadow", { shadow: on ? { color: "#000000", blur: 8, dx: 3, dy: 3 } : null })}
      >
        {style.shadow && (
          <>
            <ColorPicker value={style.shadow.color} onChange={(color) => set("shadow", { shadow: { ...style.shadow!, color } })} title="Shadow colour" />
            <NumberField label="Blur" value={style.shadow.blur} min={0} max={200} step={1} unit="px" onChange={(blur) => set("shadow", { shadow: { ...style.shadow!, blur } })} />
            <NumberField label="Across" value={style.shadow.dx} min={-200} max={200} step={1} unit="px" onChange={(dx) => set("shadow", { shadow: { ...style.shadow!, dx } })} />
            <NumberField label="Down" value={style.shadow.dy} min={-200} max={200} step={1} unit="px" onChange={(dy) => set("shadow", { shadow: { ...style.shadow!, dy } })} />
          </>
        )}
      </Effect>
      <Effect
        label="Box"
        on={Boolean(style.background)}
        onToggle={(on) => set("background", { background: on ? { color: "#000000", padding: 16 } : null })}
      >
        {style.background && (
          <>
            <ColorPicker value={style.background.color} onChange={(color) => set("background", { background: { ...style.background!, color } })} title="Box colour" />
            <NumberField label="Padding" value={style.background.padding} min={0} max={500} step={1} unit="px" onChange={(padding) => set("background", { background: { ...style.background!, padding } })} />
          </>
        )}
      </Effect>
    </>
  );
}

/** An optional text effect: a checkbox, and its settings while it is on. */
function Effect({
  label,
  on,
  onToggle,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="edit-effect">
      <label className="edit-effect-toggle">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span>{label}</span>
      </label>
      {on && <div className="edit-effect-body">{children}</div>}
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

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Edit, EditSource, MediaInfo, Project, RecutRef } from "../../types";
import { cutSegments, describeRecut, hasFlags, previousSegments, recutProject } from "../../lib/recut";
import * as api from "../../lib/api";
import { errorMessage } from "../../lib/api";
import {
  DEFAULT_STILL_SECONDS,
  MAIN_TRACK_ID,
  addOverlayTrack,
  addSource,
  canvasFor,
  editEnd,
  mainTrack,
  moveTrack,
  overlayTarget,
  patchItem,
  patchTextStyle,
  patchTrack,
  placeSource,
  placeText,
  removeSource,
  removeTrack,
  setCanvas,
  setFade,
  addKey,
  clearMotion,
  moveKey,
  removeKey,
  setTransformAt,
  setText,
  sourceFromInfo,
  startEditFromVideo,
  type ItemPatch,
} from "../../lib/edit";
import { makeId } from "../../lib/ids";
import { useTextRasters } from "../../hooks/useTextRasters";
import { bakeBase, buildRenderPlan, nextBakePath, planHash, samePath } from "../../lib/editPlan";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../../lib/dropPaths";
import { formatShort } from "../../lib/time";
import { useEdit, type SetEdit } from "../../hooks/useEdit";
import { isTextEntry } from "../../hooks/useShortcuts";
import { EditPreview } from "./EditPreview";
import { EditTimeline, laneAt } from "./EditTimeline";
import { EditSidePanel, type EditSideTab } from "./EditSidePanel";
import { BakeDialog } from "./BakeDialog";
import { SideResizer } from "../SideResizer";

/** What App's shortcuts and drops reach into the Edit tab for. */
export interface EditHandle {
  togglePlay: () => void;
  split: () => void;
  deleteSelected: () => void;
  nudge: (direction: number) => void;
  zoom: (direction: number) => void;
  zoomFit: () => void;
  clearSelection: () => void;
  addFiles: (paths: string[]) => Promise<void>;
}

interface Props {
  ref?: Ref<EditHandle>;
  active: boolean;
  edit: Edit | undefined;
  /** The project's current video and its probe, to start an edit from. */
  videoPath: string;
  media: MediaInfo | null;
  projectPath: string | null;
  /** Cues or voice clips exist, so a re-cut would leave them out of step. */
  hasTimedWork: boolean;
  setEdit: (fn: (edit: Edit | undefined) => Edit | undefined, mergeKey?: string) => void;
  /** Makes a finished bake the project's video. */
  onBaked: (path: string, planHash: string) => Promise<void>;
  /** The whole project: what a re-cut would move, for the bake dialog and the report. */
  project: Project;
  /** Shows a flagged item where it lives, in Subtitles or Voiceover. */
  onRevealTimed: (ref: RecutRef) => void;
  /** Deletes everything the last re-cut parked. */
  onDeleteLost: () => void;
  notify: (message: string, kind?: "info" | "error") => void;
  sideWidth: number;
  onSideWidth: (width: number) => void;
  /** False while a dialog or menu has the keyboard. */
  keysEnabled: boolean;
}

function isImage(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

export function EditWorkspace({
  ref,
  active,
  edit,
  videoPath,
  media,
  projectPath,
  hasTimedWork,
  setEdit,
  onBaked,
  project,
  onRevealTimed,
  onDeleteLost,
  notify,
  sideWidth,
  onSideWidth,
  keysEnabled,
}: Props) {
  const setDefined: SetEdit = useCallback(
    (fn, mergeKey) => setEdit((e) => (e ? fn(e) : e), mergeKey),
    [setEdit],
  );
  const state = useEdit(edit, setDefined, active);
  // For listeners that should not re-subscribe on every frame of playback.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [tab, setTab] = useState<EditSideTab>("media");
  /** Bumped to fit the whole timeline in view. */
  const [fitRequest, setFitRequest] = useState(0);
  const [bake, setBake] = useState<{ output: string } | null>(null);
  const [binDrag, setBinDrag] = useState<{ sourceId: string; x: number; y: number } | null>(null);

  const selected = edit?.items.find((i) => i.id === state.selectedId) ?? null;

  // --- Sources -----------------------------------------------------------------
  const addFiles = useCallback(
    async (paths: string[]) => {
      const found: EditSource[] = [];
      const failed: string[] = [];
      for (const path of paths) {
        try {
          const info = await api.probeMedia(path);
          if (!info.hasVideo || !(info.width > 0) || !(info.height > 0)) {
            failed.push(path);
            continue;
          }
          found.push(sourceFromInfo(path, info, isImage(path) ? "image" : "video"));
        } catch {
          failed.push(path);
        }
      }
      if (failed.length > 0) {
        notify(
          `Could not use ${failed.length === 1 ? failed[0] : `${failed.length} files`} — not a video or image ffmpeg can read.`,
          "error",
        );
      }
      if (found.length === 0) return;
      setEdit((current) => {
        if (current) return found.reduce((e, s) => addSource(e, s).edit, current);
        // A first edit takes its canvas from the first file and lays the
        // videos end to end, so there is something to see straight away.
        const first = found.find((s) => s.kind === "video") ?? found[0];
        let next: Edit = { canvas: canvasFor(first), sources: [], tracks: [mainTrack()], items: [] };
        for (const source of found) {
          const added = addSource(next, source);
          next = added.edit;
          if (source.kind === "video") next = placeSource(next, added.id, MAIN_TRACK_ID, editEnd(next)).edit;
        }
        return next;
      });
    },
    [notify, setEdit],
  );

  const pickFiles = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [
        { name: "Video or image", extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
      ],
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length > 0) await addFiles(paths);
  }, [addFiles]);

  const startFromVideo = useCallback(() => {
    if (!videoPath || !media) return;
    setEdit(() => startEditFromVideo(videoPath, media));
  }, [videoPath, media, setEdit]);

  useImperativeHandle(
    ref,
    () => ({
      togglePlay: state.togglePlay,
      split: state.split,
      deleteSelected: state.deleteSelected,
      nudge: state.nudge,
      zoom: state.zoomBy,
      zoomFit: () => setFitRequest((n) => n + 1),
      clearSelection: () => state.setSelectedId(null),
      addFiles,
    }),
    [state, addFiles],
  );

  // Left and right nudge by a frame here, as well as the app's [ and ] keys.
  // Only in this tab: elsewhere the arrows keep their usual meaning.
  useEffect(() => {
    if (!active || !keysEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTextEntry(e.target)) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      stateRef.current.nudge(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, keysEnabled]);

  // --- Dragging a source from the bin onto a track ------------------------------
  // Pointer events rather than HTML drag and drop, which the webview withholds
  // while it listens for files dropped from the desktop.
  const startBinDrag = (e: ReactPointerEvent<HTMLElement>, sourceId: string) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      dragging = true;
      setBinDrag({ sourceId, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBinDrag(null);
      if (!dragging) return;
      const lane = laneAt(ev.clientX, ev.clientY, state.zoom);
      if (lane) state.place(sourceId, lane.trackId, lane.time);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // --- Baking ---------------------------------------------------------------------
  // Text is drawn to PNGs first: the preview shows them and the bake overlays them.
  const rasters = useTextRasters(edit);
  const plan = useMemo(() => (edit ? buildRenderPlan(edit, rasters.byItem) : null), [edit, rasters.byItem]);
  const hash = useMemo(() => (plan ? planHash(plan) : ""), [plan]);
  // Until the text is drawn the plan lacks it, and would read as changed.
  const bakeState = !edit?.baked
    ? "none"
    : !rasters.ready
      ? "checking"
      : edit.baked.planHash === hash
        ? "current"
        : "stale";

  const openBake = useCallback(async () => {
    if (!edit) return;
    state.pause();
    const base = bakeBase(projectPath, edit);
    if (!base) return;
    const sources = edit.sources.map((s) => s.path);
    try {
      const output = await nextBakePath(
        base,
        async (p) => sources.some((s) => samePath(s, p)) || (await api.fileExists(p)),
      );
      setBake({ output });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [edit, projectPath, notify, state]);

  /** Writes every drawn text into the bake's work dir, once per distinct drawing. */
  const stageText = useCallback(async () => {
    const staged = new Set<string>();
    for (const drawn of rasters.byItem.values()) {
      if (staged.has(drawn.name)) continue;
      await api.stageEditImage(drawn.name, drawn.bytes);
      staged.add(drawn.name);
    }
  }, [rasters.byItem]);

  // What a bake would do to the timed work, worked out while its dialog is open.
  const recutPreview = useMemo(() => {
    if (!bake || !edit || !plan) return null;
    const timed =
      project.cues.length + project.voiceover.clips.length + project.sections.length + project.timedBeats.length;
    const oldSegs = previousSegments(edit, project.videoPath);
    if (timed === 0 || !oldSegs) return null;
    return describeRecut(recutProject(project, oldSegs, cutSegments(edit), plan.total).report, "move");
  }, [bake, edit, plan, project]);

  // A re-cut that left something to check opens its report; one that did not
  // leaves the panel where it was. A tab that has gone falls back to Media.
  const recutAt = edit?.recut?.at;
  useEffect(() => {
    if (recutAt && hasFlags(edit?.recut)) setTab("recut");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recutAt]);
  useEffect(() => {
    if (tab === "recut" && !hasFlags(edit?.recut)) setTab("media");
  }, [tab, edit?.recut]);

  // Pause while the bake dialog is open.
  useEffect(() => {
    if (bake) stateRef.current.pause();
  }, [bake]);

  // --- Rendering -------------------------------------------------------------------
  if (!edit) {
    return (
      <main className="edit-empty" hidden={!active}>
        <div className="edit-empty-card">
          <h2>Edit</h2>
          <p className="hint">
            Cut one or more videos into a sequence, dip to black between clips, and bake the result
            into a new video that the Subtitles and Voiceover tabs then work on.
          </p>
          {videoPath && media ? (
            <button type="button" className="primary" onClick={startFromVideo}>
              Start an edit from this video
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void pickFiles()}>
              Add a video…
            </button>
          )}
          <p className="hint">You can also drop videos and images onto the window.</p>
        </div>
      </main>
    );
  }

  /** A new text item at the playhead, on the top overlay track. */
  const addText = () => {
    const trackId = makeId();
    const itemId = makeId();
    const at = state.time;
    setDefined((e) => {
      const target = overlayTarget(e, at, DEFAULT_STILL_SECONDS, trackId);
      return placeText(target.edit, target.trackId, at, "Text", itemId).edit;
    });
    state.setSelectedId(itemId);
    setTab("item");
  };

  /** Double-click in the media list: videos go on the end of the cut, stills over it at the playhead. */
  const appendSource = (sourceId: string) => {
    const source = edit.sources.find((s) => s.id === sourceId);
    if (!source) return;
    if (source.kind === "video") {
      state.place(sourceId, MAIN_TRACK_ID, editEnd(edit));
      return;
    }
    const trackId = makeId();
    const itemId = makeId();
    const at = state.time;
    setDefined((e) => {
      const target = overlayTarget(e, at, DEFAULT_STILL_SECONDS, trackId);
      return placeSource(target.edit, sourceId, target.trackId, at, itemId).edit;
    });
    state.setSelectedId(itemId);
  };

  // Keys and transforms act at the playhead, in the item's own time. Within
  // half a frame of a key is on it.
  const keyTolerance = 0.5 / edit.canvas.fps;
  const localTime = (e: Edit, id: string) => {
    const item = e.items.find((i) => i.id === id);
    return item ? state.time - item.start : 0;
  };
  const keyAt = (e: Edit, id: string) => {
    const item = e.items.find((i) => i.id === id);
    return item ? item.transform.findIndex((k) => Math.abs(k.time - (state.time - item.start)) <= keyTolerance) : -1;
  };

  const patchSelected = (id: string, patch: ItemPatch, field: string) => {
    const key = `item:${id}:${field}`;
    if (field === "fadeIn" || field === "fadeOut") {
      const seconds = (patch as Record<string, number>)[field];
      setDefined((e) => setFade(e, id, field === "fadeIn" ? "in" : "out", seconds), key);
    } else {
      setDefined((e) => patchItem(e, id, patch), key);
    }
  };

  return (
    <main
      className="layout voiceover edit-layout"
      hidden={!active}
      style={{ "--side-width": `${sideWidth}px` } as CSSProperties}
    >
      <div className="stage-column">
        <div className="edit-bar">
          <button type="button" className="small" onClick={state.togglePlay} title="Play or pause (Space)">
            {state.playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <span className="edit-clock">
            {formatShort(state.time)} / {formatShort(state.end)}
          </span>
          <button type="button" className="small" onClick={state.split} title="Split at the playhead (S)">
            Split
          </button>
          <button
            type="button"
            className="small"
            disabled={!selected}
            onClick={state.deleteSelected}
            title="Remove the selected item (Delete)"
          >
            Delete
          </button>
          <button type="button" className="small" onClick={addText} title="Add a text item at the playhead">
            + Text
          </button>
          <button
            type="button"
            className="small"
            onClick={() => setFitRequest((n) => n + 1)}
            title="Zoom to fit the whole timeline (Z)"
          >
            Fit
          </button>
          <span className="toolbar-spacer" />
          <span
            className={`edit-bake-state ${bakeState}`}
            title={edit.baked ? `Last baked to ${edit.baked.path}` : undefined}
          >
            {bakeState === "none"
              ? "Not baked"
              : bakeState === "checking"
                ? "Baked…"
                : bakeState === "current"
                  ? "Baked"
                  : "Bake out of date"}
          </span>
          <button
            type="button"
            className="small primary"
            disabled={!plan || plan.total <= 0 || !rasters.ready}
            title={rasters.ready ? undefined : "Drawing the text…"}
            onClick={() => void openBake()}
          >
            Bake…
          </button>
        </div>
        <EditPreview
          edit={edit}
          time={state.time}
          playing={state.playing}
          stalled={state.stalled}
          textImages={rasters.byItem}
          selectedId={state.selectedId}
          onMoveSelected={(id, x, y, drag) =>
            setDefined(
              (e) => setTransformAt(e, id, localTime(e, id), { x, y }, keyTolerance),
              `drag:${drag}`,
            )
          }
        />
      </div>

      <SideResizer width={sideWidth} onWidth={onSideWidth} />

      <aside className="side-column">
        <EditSidePanel
          edit={edit}
          tab={tab}
          onTab={setTab}
          selected={selected}
          onAddFiles={() => void pickFiles()}
          onSourcePointerDown={startBinDrag}
          onAppendSource={appendSource}
          onRemoveSource={(id) => setDefined((e) => removeSource(e, id))}
          onPatchItem={patchSelected}
          onTransform={(id, patch, field) =>
            setDefined(
              (e) => setTransformAt(e, id, localTime(e, id), patch, keyTolerance),
              // One undo step per field and key, not per keystroke.
              `item:${id}:key:${keyAt(edit, id)}:${field}`,
            )
          }
          time={state.time}
          keyTolerance={keyTolerance}
          onSeek={state.seek}
          onAddKey={(id) => setDefined((e) => addKey(e, id, localTime(e, id), keyTolerance))}
          onRemoveKey={(id, index) => setDefined((e) => removeKey(e, id, index))}
          onClearMotion={(id) => setDefined((e) => clearMotion(e, id, localTime(e, id)))}
          onText={(id, text) => setDefined((e) => setText(e, id, text), `item:${id}:text`)}
          onTextStyle={(id, patch, field) =>
            setDefined((e) => patchTextStyle(e, id, patch), `item:${id}:style:${field}`)
          }
          onCanvas={(canvas) => setDefined((e) => setCanvas(e, canvas))}
          project={project}
          onRevealTimed={onRevealTimed}
          onDeleteLost={onDeleteLost}
          onClearRecut={() =>
            setDefined((e) => {
              if (!e.recut) return e;
              const { recut: _gone, ...rest } = e;
              return rest;
            })
          }
        />
      </aside>

      <section className="list-row">
        <EditTimeline
          edit={edit}
          time={state.time}
          playing={state.playing}
          zoom={state.zoom}
          selectedId={state.selectedId}
          onSeek={state.seek}
          onZoomChange={state.setZoom}
          fitRequest={fitRequest}
          onSelect={(id) => {
            state.setSelectedId(id);
            if (id) setTab("item");
          }}
          onMove={state.move}
          onTrimStart={state.trimStart}
          onTrimEnd={state.trimEnd}
          onFade={state.fade}
          onPatchTrack={(id, patch) => setDefined((e) => patchTrack(e, id, patch))}
          onAddTrack={() => setDefined((e) => addOverlayTrack(e).edit)}
          onRemoveTrack={(id) => setDefined((e) => removeTrack(e, id))}
          onRenameTrack={(id, name) => setDefined((e) => patchTrack(e, id, { name }), `track:${id}:name`)}
          onMoveTrack={(id, direction) => setDefined((e) => moveTrack(e, id, direction))}
          onMoveKey={(id, index, t, drag) => setDefined((e) => moveKey(e, id, index, t), `drag:${drag}`)}
        />
      </section>

      {binDrag && (
        <div className="edit-bin-ghost" style={{ left: binDrag.x + 12, top: binDrag.y + 12 }}>
          {edit.sources.find((s) => s.id === binDrag.sourceId)?.path.split(/[\\/]/).pop()}
        </div>
      )}

      {bake && plan && (
        <BakeDialog
          plan={plan}
          planHash={hash}
          defaultOutput={bake.output}
          sources={edit.sources.map((s) => s.path)}
          rebakeWarning={hasTimedWork}
          recutPreview={recutPreview}
          prepare={stageText}
          onBaked={onBaked}
          onClose={() => setBake(null)}
        />
      )}
    </main>
  );
}

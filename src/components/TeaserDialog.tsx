import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { EditCanvas, EditTeaser, MixdownRequest, RenderProgress } from "../types";
import {
  cancelRender,
  errorMessage,
  readTextFile,
  renderTeaser,
  stageEditImage,
  writeTextFile,
} from "../lib/api";
import { buildRenderPlan, type TextRaster } from "../lib/editPlan";
import { rasterText } from "../lib/textRaster";
import { base64ToBytes, parseTemplate } from "../lib/template";
import { teaserScreenEdit } from "../lib/teaser";
import { formatDuration } from "../lib/time";

interface Props {
  /** The baked video the teaser is cut from. */
  videoPath: string;
  hasAudio: boolean;
  canvas: EditCanvas;
  teaser: EditTeaser;
  defaultOutput: string;
  /** Where the teaser's subtitles are written for the render. */
  assPath: string;
  /** The subtitles up to the cutoff. */
  assText: string;
  /** The Voiceover tab's mix, offered as the audio once it has clips. */
  mix: Omit<MixdownRequest, "outputPath">;
  onClose: () => void;
}

/**
 * Exports a teaser: the finished video — subtitles burned in, the voiceover
 * mix as its sound — up to the cutoff, then the post-teaser screen.
 */
export function TeaserDialog({
  videoPath,
  hasAudio,
  canvas,
  teaser,
  defaultOutput,
  assPath,
  assText,
  mix,
  onClose,
}: Props) {
  const [output, setOutput] = useState(defaultOutput);
  const [crf, setCrf] = useState(18);
  const hasMix = mix.clips.length > 0;
  const [useMix, setUseMix] = useState(hasMix);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const total = teaser.at + teaser.screen;

  useEffect(() => {
    const unlisten = listen<RenderProgress>("render-progress", (event) => setProgress(event.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  /** The post-teaser screen as a bake plan, its images and text staged. */
  const screenPlan = async () => {
    const template = teaser.templatePath ? parseTemplate(await readTextFile(teaser.templatePath)) : null;
    const screen = teaserScreenEdit(canvas, template);
    for (const [name, image] of Object.entries(template?.images ?? {})) {
      await stageEditImage(name, base64ToBytes(image.png));
    }
    const rasters = new Map<string, TextRaster>();
    for (const item of screen.items) {
      if (item.kind !== "text") continue;
      const drawn = await rasterText(item.text, item.style);
      if (!drawn) continue;
      await stageEditImage(drawn.name, drawn.bytes);
      rasters.set(item.id, drawn);
    }
    const plan = buildRenderPlan(screen, rasters);
    const stagedImages = new Set(Object.keys(template?.images ?? {}));
    return {
      ...plan,
      total: teaser.screen,
      layers: plan.layers.map((l) => (stagedImages.has(l.path) ? { ...l, staged: true } : l)),
    };
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    setProgress(null);
    try {
      await writeTextFile(assPath, assText);
      const post = await screenPlan();
      await renderTeaser({
        videoPath,
        assPath,
        outputPath: output,
        at: teaser.at,
        fade: teaser.fade,
        crf,
        audio: hasMix && useMix ? mix : null,
        hasAudio,
        post,
      });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pct = progress && progress.fraction >= 0 ? progress.fraction : 0;

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal narrow"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <header className="modal-header">
          <h2>Export teaser</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          <label className="field">
            <span>Output file</span>
            <div className="field-row">
              <input value={output} onChange={(e) => setOutput(e.target.value)} disabled={busy} />
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const picked = await save({
                    defaultPath: output,
                    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
                  });
                  if (picked) setOutput(picked);
                }}
              >
                Browse…
              </button>
            </div>
          </label>

          <label className="field">
            <span>Quality (CRF — lower is better and larger; 18 is near-lossless)</span>
            <input
              type="number"
              min={0}
              max={51}
              value={crf}
              disabled={busy}
              onChange={(e) => setCrf(Number(e.target.value))}
            />
          </label>

          {hasMix && (
            <label className="field">
              <span>Audio</span>
              <select value={useMix ? "mix" : "original"} disabled={busy} onChange={(e) => setUseMix(e.target.value === "mix")}>
                <option value="mix">Voiceover mix — as the Voiceover tab plays it</option>
                <option value="original">Original — the video's own soundtrack</option>
              </select>
            </label>
          )}

          <p className="hint">
            The video with its subtitles up to {formatDuration(teaser.at)}
            {teaser.fade > 0 ? `, fading out over ${teaser.fade} s` : ""}, then{" "}
            {teaser.screen > 0
              ? `${teaser.screen} s of the post-teaser screen (${teaser.templatePath ? "its template" : "black"}), in silence`
              : "nothing more"}
            . {formatDuration(total)} in all.
          </p>

          {busy && (
            <div className="progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
              </div>
              <span className="hint">
                {!progress
                  ? "Preparing…"
                  : progress.phase === "mixing"
                    ? `Mixing the voiceover · ${Math.round(pct * 100)}%`
                    : `${formatDuration(progress.timeSeconds)} of ${formatDuration(total)} · ${Math.round(
                        pct * 100,
                      )}% · ${progress.speed}`}
              </span>
            </div>
          )}

          {done && <p className="status">Finished. Saved to {output}</p>}
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          {busy ? (
            <button type="button" className="danger" onClick={() => cancelRender().catch(() => undefined)}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" disabled={!output.trim()} onClick={start}>
                Export
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

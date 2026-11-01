import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { formatShort } from "../lib/time";
import { basename } from "../lib/voiceover";
import { ReferenceAmount, TemplateOption, templateName, type TemplateChoice } from "./ReferenceParts";

/** Anything ffmpeg can take the sound out of. */
export const VOICE_SOURCE_EXTENSIONS = [
  "mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "mpg", "mpeg", "ts",
  "wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "wma",
];

interface Props {
  speakerName: string;
  /** What a template made from this voice is called unless renamed. */
  templateDefault: string;
  /**
   * Builds the voice from `segments` of `file`, through the same isolation
   * as a reference cut from the project's video; `template` names the voice
   * template to keep it as, if any.
   */
  onBuild: (file: string, segments: Array<[number, number]>, template: string | null) => Promise<void>;
  onClose: () => void;
}

interface Segment {
  id: string;
  start: number;
  end: number;
}

const PEAKS_PER_SECOND = 100;
const MIN_ZOOM = 10;
const MAX_ZOOM = 400;
const SEGMENT_COLOR = "rgba(255, 184, 77, 0.3)";
const PLAYING_COLOR = "rgba(255, 184, 77, 0.55)";
/** A drag shorter than this is a click that slipped, not a segment. */
const MIN_SEGMENT = 0.3;

/**
 * Cloning a voice from a recording of the user's choosing — another film, an
 * interview, a voice memo: the stretches where the speaker talks alone are
 * marked by dragging across the waveform, then built into a reference.
 */
export function VoiceFileDialog({ speakerName, templateDefault, onBuild, onClose }: Props) {
  const [file, setFile] = useState<string | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [peaks, setPeaks] = useState<{ peaks: number[]; duration: number } | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(40);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateChoice>({ save: true, name: templateDefault });

  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);

  const choose = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Video or audio", extensions: VOICE_SOURCE_EXTENSIONS }],
    });
    if (typeof picked !== "string") return;
    setError(null);
    setLoading(true);
    setPeaks(null);
    setSegments([]);
    setPlayingId(null);
    try {
      const [info, computed] = await Promise.all([
        api.probeMedia(picked),
        api.computePeaks(picked, PEAKS_PER_SECOND),
      ]);
      if (!info.hasAudio) throw new Error("This file has no sound to take a voice from.");
      setHasVideo(info.hasVideo);
      setFile(picked);
      setPeaks({ peaks: computed.peaks, duration: computed.duration || info.duration });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // The file picker opens straight away: choosing a file is the first step.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void choose();
  }, [choose]);

  // One waveform per file, over the dialog's own media element.
  useEffect(() => {
    const media = mediaRef.current;
    if (!file || !peaks || !media || !waveRef.current) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: waveRef.current,
      media,
      peaks: [peaks.peaks],
      duration: peaks.duration,
      height: 96,
      waveColor: "#3d4a5c",
      progressColor: "#5b7fa6",
      cursorColor: "#ff4d4d",
      cursorWidth: 2,
      minPxPerSec: zoom,
      normalize: true,
      fillParent: true,
      autoScroll: true,
      autoCenter: false,
      interact: true,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;
    const stopDrag = regions.enableDragSelection({ color: SEGMENT_COLOR });

    const sync = () =>
      setSegments(
        regions
          .getRegions()
          .map((r) => ({ id: r.id, start: r.start, end: r.end }))
          .sort((a, b) => a.start - b.start),
      );
    regions.on("region-created", (region: Region) => {
      if (region.end - region.start < MIN_SEGMENT) {
        region.remove();
        return;
      }
      sync();
    });
    regions.on("region-updated", sync);
    regions.on("region-removed", sync);
    regions.on("region-out", (region: Region) => {
      region.setOptions({ color: SEGMENT_COLOR });
      setPlayingId((id) => (id === region.id ? null : id));
    });
    // Double-click a segment to drop it.
    regions.on("region-double-clicked", (region: Region, e: MouseEvent) => {
      e.stopPropagation();
      region.remove();
    });

    return () => {
      stopDrag();
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
    // Zoom is applied below without rebuilding, which would lose the regions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, peaks]);

  useEffect(() => {
    try {
      wsRef.current?.zoom(zoom);
    } catch {
      // Not loaded yet: the zoom is picked up on creation.
    }
  }, [zoom]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const stop = () => setPlayingId(null);
    media.addEventListener("pause", stop);
    return () => media.removeEventListener("pause", stop);
  }, [file]);

  const region = (id: string) => regionsRef.current?.getRegions().find((r) => r.id === id);

  const play = (id: string) => {
    const r = region(id);
    if (!r) return;
    regionsRef.current?.getRegions().forEach((o) => o.setOptions({ color: SEGMENT_COLOR }));
    r.setOptions({ color: PLAYING_COLOR });
    r.play(true);
    setPlayingId(id);
  };

  const stop = () => {
    mediaRef.current?.pause();
    regionsRef.current?.getRegions().forEach((o) => o.setOptions({ color: SEGMENT_COLOR }));
    setPlayingId(null);
  };

  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

  const build = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    stop();
    try {
      await onBuild(
        file,
        segments.map((s) => [s.start, s.end]),
        templateName(template),
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    stop();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : close}>
      <div
        className="modal reference-dialog voice-file-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !busy) close();
        }}
      >
        <header className="modal-header">
          <h2>Clone {speakerName}'s voice from a file</h2>
          {!busy && (
            <button type="button" className="icon-button" onClick={close}>
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          <div className="voice-file-source">
            <button type="button" onClick={() => void choose()} disabled={busy || loading}>
              {file ? "Another file…" : "Choose a video or audio file…"}
            </button>
            {file && (
              <span className="voice-file-name" title={file}>
                {basename(file)}
              </span>
            )}
          </div>

          {loading && <p className="hint">Reading the sound…</p>}

          <video
            ref={mediaRef}
            className="voice-file-video"
            src={file ? convertFileSrc(file) : undefined}
            style={{ display: file && hasVideo ? undefined : "none" }}
            preload="auto"
            onClick={(e) => {
              const v = e.currentTarget;
              if (v.paused) void v.play();
              else v.pause();
            }}
          />

          {file && peaks && (
            <>
              <p className="hint">
                Drag across the waveform to mark where {speakerName} speaks clearly and alone.
                Drag a segment's edges to adjust it; double-click one to remove it. Click the
                waveform to listen from there. Music and effects are taken out, as for a voice
                built from the project's video.
              </p>
              <div ref={waveRef} className="voice-file-wave" />
              <div className="voice-file-controls">
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    const m = mediaRef.current;
                    if (!m) return;
                    if (m.paused) void m.play();
                    else m.pause();
                  }}
                >
                  ▶ / ■
                </button>
                <label className="voice-file-zoom">
                  Zoom
                  <input
                    type="range"
                    min={Math.log(MIN_ZOOM)}
                    max={Math.log(MAX_ZOOM)}
                    step={0.01}
                    value={Math.log(zoom)}
                    onChange={(e) => setZoom(Math.round(Math.exp(Number(e.target.value))))}
                  />
                </label>
              </div>

              <div className="reference-list voice-file-segments">
                {segments.length === 0 && <p className="hint">No segments marked yet.</p>}
                {segments.map((s) => (
                  <div key={s.id} className="reference-row chosen">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => (playingId === s.id ? stop() : play(s.id))}
                      title={playingId === s.id ? "Stop" : "Listen to this segment"}
                    >
                      {playingId === s.id ? "■" : "▶"}
                    </button>
                    <span className="reference-time">
                      {formatShort(s.start)} – {formatShort(s.end)}
                    </span>
                    <span className="reference-length">{(s.end - s.start).toFixed(1)} s</span>
                    <span className="modal-footer-spacer" />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => region(s.id)?.remove()}
                      disabled={busy}
                      title="Remove this segment"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <ReferenceAmount count={segments.length} noun="segment" total={total} />
              <TemplateOption choice={template} disabled={busy} onChange={setTemplate} />
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <footer className="modal-footer">
          <button
            type="button"
            onClick={() => regionsRef.current?.clearRegions()}
            disabled={busy || segments.length === 0}
          >
            Clear
          </button>
          <span className="modal-footer-spacer" />
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !file || segments.length === 0}
            onClick={() => void build()}
          >
            {busy ? "Isolating the voice…" : "Build voice"}
          </button>
        </footer>
      </div>
    </div>
  );
}

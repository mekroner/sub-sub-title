import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { Cue, Speaker } from "../types";
import { contrastText, withAlpha } from "../lib/colors";

interface Props {
  videoEl: HTMLVideoElement | null;
  peaks: number[] | null;
  duration: number;
  cues: Cue[];
  speakers: Speaker[];
  selectedCueId: string | null;
  zoom: number;
  onSelectCue: (id: string) => void;
  onRetimeCue: (id: string, start: number, end: number, final: boolean) => void;
  onCreateCue: (start: number, end: number) => void;
  onSeek: (time: number) => void;
}

/** Regions outside the viewport are not created at all; this is the margin. */
const WINDOW_PADDING_SECONDS = 20;

export function WaveformPane({
  videoEl,
  peaks,
  duration,
  cues,
  speakers,
  selectedCueId,
  zoom,
  onSelectCue,
  onRetimeCue,
  onCreateCue,
  onSeek,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  /** cueId -> live Region instance, for the cues currently in the window. */
  const regionMap = useRef<Map<string, Region>>(new Map());
  /** Suppresses `region-created` while we are the ones adding regions. */
  const syncing = useRef(false);
  const [visible, setVisible] = useState<[number, number]>([0, 60]);
  const [ready, setReady] = useState(false);

  // Latest props, so the wavesurfer event handlers never close over stale state.
  const handlers = useRef({ onSelectCue, onRetimeCue, onCreateCue, onSeek, cues });
  handlers.current = { onSelectCue, onRetimeCue, onCreateCue, onSeek, cues };

  // --- Create / destroy ---------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || !videoEl || !peaks || peaks.length === 0) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      media: videoEl,
      peaks: [peaks],
      duration,
      height: 128,
      waveColor: "#3d4a5c",
      progressColor: "#5b7fa6",
      cursorColor: "#ff4d4d",
      cursorWidth: 2,
      minPxPerSec: zoom,
      autoScroll: true,
      autoCenter: true,
      normalize: true,
      fillParent: true,
      interact: true,
      plugins: [regions],
    });

    wsRef.current = ws;
    regionsRef.current = regions;
    regionMap.current = new Map();

    const disableDragSelection = regions.enableDragSelection({
      color: "rgba(255,255,255,0.18)",
    });

    ws.on("ready", () => {
      setReady(true);
      const width = containerRef.current?.clientWidth ?? 800;
      setVisible([0, width / zoom]);
    });

    // wavesurfer reports the visible time range directly, which is exactly the
    // window we need for deciding which regions to materialise.
    ws.on("scroll", (start: number, end: number) => setVisible([start, end]));

    ws.on("interaction", (time: number) => handlers.current.onSeek(time));

    regions.on("region-created", (region: Region) => {
      if (syncing.current) return;
      // A user drag-selection: turn it into a real cue and drop the temporary
      // region, which the cue sync will immediately recreate.
      const { start, end } = region;
      region.remove();
      handlers.current.onCreateCue(start, end);
    });

    regions.on("region-updated", (region: Region) => {
      handlers.current.onRetimeCue(region.id, region.start, region.end, true);
    });

    regions.on("region-clicked", (region: Region, event: MouseEvent) => {
      event.stopPropagation();
      handlers.current.onSelectCue(region.id);
      handlers.current.onSeek(region.start);
    });

    return () => {
      disableDragSelection();
      setReady(false);
      regionMap.current = new Map();
      wsRef.current = null;
      regionsRef.current = null;
      // Drop our listeners before destroying, so teardown cannot fire handlers
      // against unmounted state. destroy() pauses the shared <video> but leaves
      // it in the DOM, since wavesurfer did not create it.
      ws.unAll();
      ws.destroy();
    };
    // Recreate only when the underlying media or decoded peaks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, peaks, duration]);

  // --- Zoom ---------------------------------------------------------------
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    try {
      ws.zoom(zoom);
    } catch {
      // zoom() throws if the instance is mid-teardown; harmless.
    }
  }, [zoom, ready]);

  // --- Sync cues -> regions, windowed to the visible range ----------------
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;

    const [from, to] = visible;
    const lo = from - WINDOW_PADDING_SECONDS;
    const hi = to + WINDOW_PADDING_SECONDS;
    const colorOf = new Map(speakers.map((s) => [s.id, s.color]));

    const inWindow = cues.filter((c) => c.end >= lo && c.start <= hi);
    const wanted = new Set(inWindow.map((c) => c.id));

    syncing.current = true;
    try {
      // Drop regions that scrolled out of the window or whose cue is gone.
      for (const [id, region] of regionMap.current) {
        if (!wanted.has(id)) {
          region.remove();
          regionMap.current.delete(id);
        }
      }

      for (const cue of inWindow) {
        const base = cue.speakerId ? colorOf.get(cue.speakerId) ?? "#8a94a6" : "#8a94a6";
        const selected = cue.id === selectedCueId;
        const color = withAlpha(base, selected ? 0.45 : 0.22);
        const existing = regionMap.current.get(cue.id);

        if (!existing) {
          const region = regions.addRegion({
            id: cue.id,
            start: cue.start,
            end: cue.end,
            color,
            drag: true,
            resize: true,
          });
          styleRegion(region, base, selected, cue.text);
          regionMap.current.set(cue.id, region);
          continue;
        }

        // Only touch the DOM when something actually moved; setOptions on every
        // render would fight the user mid-drag.
        const moved =
          Math.abs(existing.start - cue.start) > 0.001 ||
          Math.abs(existing.end - cue.end) > 0.001;
        if (moved) {
          existing.setOptions({ start: cue.start, end: cue.end });
        }
        styleRegion(existing, base, selected, cue.text);
      }
    } finally {
      syncing.current = false;
    }
  }, [cues, speakers, selectedCueId, visible, ready]);

  const hasWaveform = Boolean(peaks && peaks.length > 0 && videoEl);

  return (
    <div className="waveform-pane">
      <div ref={containerRef} className="waveform-canvas" />
      {!hasWaveform && (
        <div className="waveform-placeholder">
          {videoEl
            ? "Extracting the waveform…"
            : "Open a video to see its waveform."}
        </div>
      )}
    </div>
  );
}

/** Region styling that the plugin options do not cover. */
function styleRegion(region: Region, color: string, selected: boolean, text: string) {
  const el = region.element;
  if (!el) return;
  el.style.backgroundColor = withAlpha(color, selected ? 0.45 : 0.22);
  el.style.borderLeft = `2px solid ${color}`;
  el.style.borderRight = `2px solid ${color}`;
  el.style.boxShadow = selected ? `inset 0 0 0 1px ${color}` : "none";
  el.style.zIndex = selected ? "5" : "3";

  const label = text.replace(/\s+/g, " ").trim().slice(0, 40);
  if (el.dataset.label !== label) {
    el.dataset.label = label;
    let span = el.querySelector<HTMLSpanElement>(".region-label");
    if (!span) {
      span = document.createElement("span");
      span.className = "region-label";
      el.appendChild(span);
    }
    span.textContent = label;
    span.style.color = contrastText(color) === "#000" ? "#0b0e13" : "#eef2f7";
  }
}

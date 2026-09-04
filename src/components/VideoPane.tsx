import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cue, Settings, Speaker } from "../types";

interface Props {
  src: string | null;
  activeCue: Cue | null;
  speaker: Speaker | null;
  settings: Settings;
  /** Natural video size, used to letterbox the caption overlay exactly. */
  videoWidth: number;
  videoHeight: number;
  onTimeUpdate: (time: number) => void;
  onDurationChange: (duration: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onError: (message: string) => void;
}

/**
 * Plain `<video>` plus a positioned caption overlay. The overlay is placed over
 * the video's actual letterboxed rectangle and scaled from the source
 * resolution, so it previews the .ass burn-in rather than merely approximating
 * it.
 */
export const VideoPane = forwardRef<HTMLVideoElement, Props>(function VideoPane(
  {
    src,
    activeCue,
    speaker,
    settings,
    videoWidth,
    videoHeight,
    onTimeUpdate,
    onDurationChange,
    onPlayingChange,
    onError,
  },
  ref,
) {
  const color = speaker?.color ?? "#ffffff";

  // A silent black frame is the worst failure mode, so a load failure stays on
  // screen (with the URL that failed) rather than passing by as a toast.
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => setLoadError(null), [src]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStage({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [src]);

  // Where the video actually sits inside its box under object-fit: contain.
  const aspect = videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : 16 / 9;
  const box = (() => {
    const { width, height } = stage;
    if (width <= 0 || height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
    if (width / height > aspect) {
      const w = height * aspect;
      return { left: (width - w) / 2, top: 0, width: w, height };
    }
    const h = width / aspect;
    return { left: 0, top: (height - h) / 2, width, height: h };
  })();

  // .ass sizes are in source-video pixels; scale to the rendered box.
  const scale = videoHeight > 0 && box.height > 0 ? box.height / videoHeight : 0;
  const fontSize = Math.max(8, settings.fontSize * (scale || 0.09));
  const outline = Math.max(1, settings.outline * (scale || 0.09) * 1.4);

  return (
    <div className="video-pane">
      {src ? (
        <div className="video-stage" ref={stageRef}>
          <video
            ref={ref}
            className="video-el"
            src={src}
            onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
            onDurationChange={(e) => onDurationChange(e.currentTarget.duration)}
            onPlay={() => onPlayingChange(true)}
            onPause={() => onPlayingChange(false)}
            onSeeked={(e) => onTimeUpdate(e.currentTarget.currentTime)}
            onError={(e) => {
              const err = e.currentTarget.error;
              const detail = err
                ? `media error ${err.code}${err.message ? `: ${err.message}` : ""}`
                : "unknown media error";
              setLoadError(detail);
              onError(`The video could not be played (${detail}).`);
            }}
          />

          {activeCue && activeCue.text.trim() !== "" && box.height > 0 && (
            <div
              className="caption-layer"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                paddingBottom: box.height * 0.045,
              }}
            >
              <span
                className="caption-text"
                style={{
                  color,
                  fontFamily: `"${settings.fontName}", Arial, sans-serif`,
                  fontSize: `${fontSize}px`,
                  // Four offsets approximate the .ass outline; text-stroke
                  // renders inconsistently in WebView2.
                  textShadow: [
                    `-${outline}px -${outline}px 0 #000`,
                    `${outline}px -${outline}px 0 #000`,
                    `-${outline}px ${outline}px 0 #000`,
                    `${outline}px ${outline}px 0 #000`,
                    `0 ${outline * 1.5}px ${outline * 2}px rgba(0,0,0,0.6)`,
                  ].join(", "),
                }}
              >
                {activeCue.text.split("\n").map((line, i) => (
                  <span key={i} className="caption-line">
                    {line}
                  </span>
                ))}
              </span>
            </div>
          )}

          {loadError && (
            <div className="video-error">
              <strong>This video could not be played.</strong>
              <span>{loadError}</span>
              <code>{src}</code>
            </div>
          )}
        </div>
      ) : (
        <div className="video-empty">
          <div>
            <h2>No video loaded</h2>
            <p>
              Open a video to begin. If a <code>.captions.json</code> or{" "}
              <code>.srt</code> sits next to it, it is picked up automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
});

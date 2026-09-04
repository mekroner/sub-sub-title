import { formatShort, formatDuration } from "../lib/time";

export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

interface Props {
  enabled: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  onTogglePlay: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onPlaybackRateChange: (rate: number) => void;
}

/** Transport controls under the video: play/pause, volume, playback speed. */
export function TransportBar({
  enabled,
  playing,
  currentTime,
  duration,
  volume,
  muted,
  playbackRate,
  onTogglePlay,
  onVolumeChange,
  onToggleMute,
  onPlaybackRateChange,
}: Props) {
  return (
    <div className="transport-bar">
      <button
        type="button"
        className="transport-play"
        disabled={!enabled}
        onClick={onTogglePlay}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>

      <span className="transport-time">
        {formatShort(currentTime)} <span className="dim">/ {formatDuration(duration)}</span>
      </span>

      <div className="transport-spacer" />

      <div className="transport-group" title="Volume">
        <button
          type="button"
          className="icon-button"
          disabled={!enabled}
          onClick={onToggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
        </button>
        <input
          type="range"
          className="volume-slider"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          disabled={!enabled}
          aria-label="Volume"
          onChange={(e) => onVolumeChange(Number(e.target.value))}
        />
        <span className="transport-readout">{Math.round((muted ? 0 : volume) * 100)}%</span>
      </div>

      <div className="transport-group" title="Playback speed">
        <label className="transport-label" htmlFor="playback-rate">
          Speed
        </label>
        <select
          id="playback-rate"
          value={playbackRate}
          disabled={!enabled}
          onChange={(e) => onPlaybackRateChange(Number(e.target.value))}
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
        {playbackRate !== 1 && (
          <button
            type="button"
            className="icon-button"
            title="Back to normal speed"
            onClick={() => onPlaybackRateChange(1)}
          >
            ↺
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Plays the voiceover mix in step with the video.
 *
 * The video's own audio is taken from the `<video>` element through a
 * MediaElementAudioSourceNode rather than decoded separately: it stays locked to
 * the picture through seeks and rate changes, and a two-hour soundtrack never
 * has to sit decoded in memory. That routing is one-way — once an element feeds
 * the graph it can no longer play to the speakers on its own — so after the
 * first attach every sound goes through here, the transport volume included.
 * The asset protocol answers with the window's origin in
 * Access-Control-Allow-Origin, which is what lets a `crossorigin` video feed
 * the graph instead of being silenced as cross-origin.
 *
 * Clips are decoded once and scheduled a little ahead of the video's clock.
 * The two clocks drift by milliseconds over a clip's length, which is below
 * what anyone hears; anything that moves the clock (seek, pause, rate) stops
 * every clip and schedules again from the new position.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { GainPoint, VoiceClip, Voiceover } from "../types";
import { clipEnd, dbToGain, isAudible, ORIGINAL_TRACK_ID } from "../lib/voiceover";
import { curveDb } from "../lib/automation";

/** How far ahead of the playhead clips are handed to the audio clock. */
const LOOKAHEAD_SECONDS = 0.4;
/** Also the step at which gain curves are followed during playback. */
const TICK_MS = 40;
/** Gain changes glide over roughly this long, so a mute is not a click. */
const GAIN_SMOOTHING = 0.015;
/**
 * Time constant while following a curve: about a third of a tick, so each
 * glide has all but arrived when the next one takes over.
 */
const CURVE_SMOOTHING = TICK_MS / 1000 / 3;
/** Resolution of the waveform drawn inside a clip. */
export const CLIP_PEAKS_PER_SECOND = 200;

interface Playing {
  node: AudioBufferSourceNode;
  gain: GainNode;
  /** The clip as scheduled; any difference means it must be scheduled again. */
  clip: VoiceClip;
}

export class VoiceoverMixer {
  private readonly ctx = new AudioContext();
  private readonly master = this.ctx.createGain();
  private readonly trackGains = new Map<string, GainNode>();
  /** An element can be wrapped only once, ever, so the node is kept with it. */
  private readonly elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private readonly loading = new Map<string, Promise<AudioBuffer>>();
  private readonly decoded = new Map<string, AudioBuffer>();
  private readonly peaks = new Map<string, Float32Array>();
  private readonly playing = new Map<string, Playing>();
  private readonly decodeListeners = new Set<() => void>();

  private video: HTMLVideoElement | null = null;
  private detachVideo: (() => void) | null = null;
  private voiceover: Voiceover | null = null;
  private duck: GainPoint[] = [];
  /** Off in the Subtitles tab: the original plays at unity and clips are silent. */
  private enabled = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.master.connect(this.ctx.destination);
    this.trackGains.set(ORIGINAL_TRACK_ID, this.makeTrackGain());
  }

  attach(video: HTMLVideoElement | null) {
    if (video === this.video) return;
    this.detachVideo?.();
    this.detachVideo = null;
    this.stopAll();
    this.video = video;
    if (!video) return;

    let source = this.elementSources.get(video);
    if (!source) {
      source = this.ctx.createMediaElementSource(video);
      this.elementSources.set(video, source);
    }
    source.disconnect();
    source.connect(this.trackGain(ORIGINAL_TRACK_ID));

    const restart = () => {
      this.stopAll();
      this.applyGains();
      this.schedule();
    };
    const onPlay = () => {
      // A context created before any gesture starts suspended, and a suspended
      // context silences the video along with everything else.
      void this.ctx.resume();
      restart();
      this.startTimer();
    };
    const onPause = () => {
      this.stopTimer();
      this.stopAll();
      this.applyGains();
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    const onSeeking = () => this.stopAll();
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", restart);
    video.addEventListener("ratechange", restart);
    this.detachVideo = () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", restart);
      video.removeEventListener("ratechange", restart);
      this.stopTimer();
    };
    if (!video.paused) onPlay();
  }

  /** Transport volume and mute; the element itself is left at full volume. */
  setMaster(volume: number, muted: boolean) {
    this.glide(this.master.gain, muted ? 0 : Math.max(0, Math.min(1, volume)));
  }

  /**
   * `duck` is the original track's automatic duck under the cues, derived by
   * the caller (which knows the cues) and added on top of the drawn curve.
   */
  setMix(voiceover: Voiceover, enabled: boolean, duck: GainPoint[]) {
    this.voiceover = voiceover;
    this.enabled = enabled;
    this.duck = duck;

    const live = new Set(voiceover.tracks.map((t) => t.id));
    for (const [id, gain] of this.trackGains) {
      if (id !== ORIGINAL_TRACK_ID && !live.has(id)) {
        gain.disconnect();
        this.trackGains.delete(id);
      }
    }
    this.applyGains();

    // A clip that was edited, moved to another track or removed is stopped;
    // `schedule` then picks it up again from where the playhead is.
    const byId = new Map(voiceover.clips.map((c) => [c.id, c]));
    for (const [id, playing] of this.playing) {
      const clip = byId.get(id);
      if (!enabled || !clip || !sameSchedule(clip, playing.clip)) this.stop(id);
    }
    this.schedule();
  }

  /** Decodes (once) and returns the file's audio. Rejects on unreadable files. */
  load(path: string): Promise<AudioBuffer> {
    let pending = this.loading.get(path);
    if (!pending) {
      pending = fetch(convertFileSrc(path))
        .then((response) => {
          if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`);
          return response.arrayBuffer();
        })
        .then((bytes) => this.ctx.decodeAudioData(bytes))
        .then((buffer) => {
          this.decoded.set(path, buffer);
          this.peaks.set(path, computePeaks(buffer, CLIP_PEAKS_PER_SECOND));
          for (const listener of this.decodeListeners) listener();
          // A clip waiting on this file may already be due.
          this.schedule();
          return buffer;
        });
      // A failure is not cached, so fixing the file and retrying works.
      pending.catch(() => this.loading.delete(path));
      this.loading.set(path, pending);
    }
    return pending;
  }

  /** Absolute peak per `CLIP_PEAKS_PER_SECOND` bucket, once decoded. */
  peaksFor(path: string): Float32Array | null {
    return this.peaks.get(path) ?? null;
  }

  onDecoded(listener: () => void): () => void {
    this.decodeListeners.add(listener);
    return () => this.decodeListeners.delete(listener);
  }

  dispose() {
    this.detachVideo?.();
    this.stopAll();
    void this.ctx.close();
  }

  /**
   * Sets every track's gain from its fader, mute/solo and curve. While playing
   * it aims at where the playhead will be by the next tick, and the glide
   * carries it there, so a curve plays as a smooth ramp rather than steps.
   */
  private applyGains() {
    const voiceover = this.voiceover;
    if (!voiceover) return;
    const video = this.video;
    const rolling = video !== null && !video.paused;
    const time = video
      ? video.currentTime + (rolling ? (TICK_MS / 1000) * (video.playbackRate || 1) : 0)
      : 0;
    for (const track of voiceover.tracks) {
      const target = !this.enabled
        ? track.kind === "original"
          ? 1
          : 0
        : isAudible(voiceover, track)
          ? dbToGain(
              track.gainDb +
                curveDb(track.automation, time) +
                (track.kind === "original" ? curveDb(this.duck, time) : 0),
            )
          : 0;
      this.glide(this.trackGain(track.id).gain, target, rolling ? CURVE_SMOOTHING : GAIN_SMOOTHING);
    }
  }

  private schedule() {
    const video = this.video;
    const voiceover = this.voiceover;
    if (!video || !voiceover || !this.enabled || video.paused || video.seeking) return;

    const now = video.currentTime;
    const rate = video.playbackRate || 1;
    const horizon = now + LOOKAHEAD_SECONDS * rate;
    const tracks = new Map(voiceover.tracks.map((t) => [t.id, t]));

    for (const clip of voiceover.clips) {
      if (this.playing.has(clip.id)) continue;
      if (clipEnd(clip) <= now || clip.start >= horizon) continue;
      const track = tracks.get(clip.trackId);
      if (!track || !isAudible(voiceover, track)) continue;

      const buffer = this.decoded.get(clip.file);
      if (!buffer) {
        // Decoding re-enters `schedule` when done; a failure was already
        // reported when the clip was imported.
        this.load(clip.file).catch(() => undefined);
        continue;
      }

      const into = Math.max(0, now - clip.start);
      const offset = clip.offset + into;
      const length = clip.duration - into;
      if (length <= 0 || offset >= buffer.duration) continue;

      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate;
      const gain = this.ctx.createGain();
      gain.gain.value = dbToGain(clip.gainDb);
      node.connect(gain).connect(this.trackGain(clip.trackId));

      const when = this.ctx.currentTime + Math.max(0, clip.start - now) / rate;
      node.start(when, offset, length);
      node.onended = () => {
        if (this.playing.get(clip.id)?.node === node) this.stop(clip.id);
      };
      this.playing.set(clip.id, { node, gain, clip });
    }
  }

  private stop(id: string) {
    const playing = this.playing.get(id);
    if (!playing) return;
    this.playing.delete(id);
    playing.node.onended = null;
    try {
      playing.node.stop();
    } catch {
      // Already stopped.
    }
    playing.node.disconnect();
    playing.gain.disconnect();
  }

  private stopAll() {
    for (const id of [...this.playing.keys()]) this.stop(id);
  }

  private startTimer() {
    if (this.timer === null) {
      this.timer = setInterval(() => {
        this.applyGains();
        this.schedule();
      }, TICK_MS);
    }
  }

  private stopTimer() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private trackGain(id: string): GainNode {
    let gain = this.trackGains.get(id);
    if (!gain) {
      gain = this.makeTrackGain();
      this.trackGains.set(id, gain);
    }
    return gain;
  }

  private makeTrackGain(): GainNode {
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    return gain;
  }

  private glide(param: AudioParam, value: number, smoothing = GAIN_SMOOTHING) {
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setTargetAtTime(value, this.ctx.currentTime, smoothing);
  }
}

function sameSchedule(a: VoiceClip, b: VoiceClip): boolean {
  return (
    a.file === b.file &&
    a.trackId === b.trackId &&
    a.start === b.start &&
    a.offset === b.offset &&
    a.duration === b.duration &&
    a.gainDb === b.gainDb
  );
}

/** Largest absolute sample across channels, per bucket. */
export function computePeaks(buffer: AudioBuffer, perSecond: number): Float32Array {
  const bucket = Math.max(1, Math.round(buffer.sampleRate / perSecond));
  const count = Math.ceil(buffer.length / bucket);
  const out = new Float32Array(count);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < count; i++) {
      let peak = out[i];
      const end = Math.min(data.length, (i + 1) * bucket);
      for (let s = i * bucket; s < end; s++) {
        const v = Math.abs(data[s]);
        if (v > peak) peak = v;
      }
      out[i] = peak;
    }
  }
  return out;
}

"""Regenerates the built-in Female and Male reference voices.

They are synthetic: spoken by Kokoro-82M v1.0 (Apache-2.0,
https://github.com/hexgrad/kokoro) through kokoro-onnx, so no real person's
voice is cloned. Chatterbox clones them like any other reference clip.

    pip install kokoro-onnx soundfile pyloudnorm
    # kokoro-v1.0.onnx and voices-v1.0.bin from
    # https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
    python synthesize.py <dir with the model files> <out dir>
"""

import sys

import numpy as np
import pyloudnorm
import soundfile
from kokoro_onnx import Kokoro

# Preset name -> Kokoro voice. af_heart is Kokoro's best-rated voice;
# am_michael is its most natural American male, pitched around 120 Hz.
VOICES = {"female": "af_heart", "male": "am_michael"}

# About ten seconds of relaxed, varied speech: a statement, a pause, a lift.
# Chatterbox conditions on the first ten seconds of a reference, and Turbo
# refuses one of five seconds or less.
TEXT = (
    "I wasn't sure what to expect when we first got there. "
    "The streets were quiet, the light was fading, and honestly? "
    "It turned out to be one of the best evenings I can remember."
)
LUFS = -23.0
PAD = 0.15


def trimmed(audio, sr):
    """Leading and trailing silence cut back to PAD seconds."""
    loud = np.flatnonzero(np.abs(audio) > 0.01)
    if len(loud) == 0:
        return audio
    pad = int(PAD * sr)
    return audio[max(0, loud[0] - pad) : loud[-1] + pad]


def main(model_dir, out_dir):
    kokoro = Kokoro(f"{model_dir}/kokoro-v1.0.onnx", f"{model_dir}/voices-v1.0.bin")
    for preset, voice in VOICES.items():
        audio, sr = kokoro.create(TEXT, voice=voice, speed=1.0, lang="en-us")
        audio = trimmed(audio, sr)
        meter = pyloudnorm.Meter(sr)
        audio = pyloudnorm.normalize.loudness(audio, meter.integrated_loudness(audio), LUFS)
        audio = np.clip(audio, -0.95, 0.95)
        soundfile.write(f"{out_dir}/{preset}.wav", audio, sr, subtype="PCM_16")
        print(f"{preset}: {voice}, {len(audio) / sr:.1f} s")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

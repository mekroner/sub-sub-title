"""What every voice engine sidecar of sub-sub-title shares: the line protocol,
loudness levelling and finding where the voice is in a take.

Importing this first takes the real stdout for the protocol alone and points
`sys.stdout` at stderr, so a library's stray print can never corrupt a reply.
"""

import json
import os
import random
import sys

PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr


def send(message):
    PROTOCOL.write(json.dumps(message) + "\n")
    PROTOCOL.flush()


# Every reference is cloned from speech at this integrated loudness, so all the
# voices in a project come out alike in level. It is the level Turbo already
# normalises to internally; the Expressive model does not normalise at all.
# References built from the video arrive here already level line by line.
REFERENCE_LUFS = -27.0
# Every take is written at this integrated loudness, so lines from different
# voices and models sit at one level in the mix before anyone touches a fader.
VOICE_LUFS = -20.0
# Gain never takes a sample past this (-1 dBFS).
PEAK_CEILING = 10 ** (-1.0 / 20)


def level(audio, sr, target):
    """`audio` at `target` integrated loudness, its peak never past
    PEAK_CEILING. Anything the meter cannot measure — shorter than its one
    400 ms block, or silent — comes back as the same object, untouched."""
    import numpy as np
    import pyloudnorm

    if len(audio) < 0.4 * sr:
        return audio
    loudness = pyloudnorm.Meter(sr).integrated_loudness(audio)
    if not np.isfinite(loudness) or loudness < -70:
        return audio
    gain = 10 ** ((target - loudness) / 20)
    peak = float(np.abs(audio).max())
    if peak * gain > PEAK_CEILING:
        gain = PEAK_CEILING / peak
    return audio * gain


# Speech is any 20 ms frame within 40 dB of the take's loudest frame (and
# above -60 dBFS); the window is padded so a soft onset or breath survives.
SPEECH_FRAME = 0.02
SPEECH_RANGE_DB = 40.0
SPEECH_FLOOR_DB = -60.0
SPEECH_PAD = 0.06


def speech_window(audio, sr):
    """[start, end] of the voice in seconds, padded and clamped to the take,
    or None if nothing in it is loud enough to be speech."""
    import numpy as np

    frame = max(1, int(SPEECH_FRAME * sr))
    count = len(audio) // frame
    if count == 0:
        return None
    frames = audio[: count * frame].reshape(count, frame)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    db = 20 * np.log10(np.maximum(rms, 1e-10))
    threshold = max(float(db.max()) - SPEECH_RANGE_DB, SPEECH_FLOOR_DB)
    loud = np.nonzero(db >= threshold)[0]
    if len(loud) == 0:
        return None
    seconds = len(audio) / sr
    start = max(0.0, loud[0] * frame / sr - SPEECH_PAD)
    end = min(seconds, (loud[-1] + 1) * frame / sr + SPEECH_PAD)
    return [round(start, 4), round(end, 4)]


def seed_everything(seed):
    import numpy as np
    import torch

    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

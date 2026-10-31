"""The voice engine sidecar for sub-sub-title.

Reads one JSON request per line on stdin and answers with one JSON object per
line on stdout. Models are loaded on first use and kept on the GPU. Exits when
stdin closes, which is how the app shuts it down — however the app exits.

Libraries print freely, so the real stdout is kept for the protocol alone and
`sys.stdout` is pointed at stderr: a stray print can never corrupt a reply.

    {"id": 1, "op": "generate", "engine": "turbo", "text": "...",
     "reference": "C:/ref.wav" | null, "seed": 7, "exaggeration": 0.5,
     "cfgWeight": 0.5, "temperature": 0.8, "out": "C:/line.wav"}
    -> {"id": 1, "ok": true, "path": "C:/line.wav", "duration": 2.41}
    -> {"id": 1, "ok": false, "error": "..."}

    {"id": 2, "op": "align", "audio": "C:/line.wav", "segments": ["One two", "three"]}
    -> {"id": 2, "ok": true, "marks": [[0.12, 0.81], [0.95, 1.40]]}

While a model loads: {"event": "loading", "detail": "turbo"}.
"""

import json
import os
import random
import re
import sys
import traceback

PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr


def send(message):
    PROTOCOL.write(json.dumps(message) + "\n")
    PROTOCOL.flush()


_models = {}
# Prepared voice conditioning per (engine, reference). Preparing it means
# loading and analysing the reference clip, which the library would otherwise
# redo for every single line. `None` is the model's built-in voice.
_conds = {}


def load(engine):
    model = _models.get(engine)
    if model is not None:
        return model
    send({"event": "loading", "detail": engine})
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if engine == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        model = ChatterboxTurboTTS.from_pretrained(device=device)
    elif engine == "standard":
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=device)
    else:
        raise ValueError(f"Unknown engine: {engine}")
    # One model on the GPU at a time: two would crowd a 16 GB card.
    for other in list(_models):
        del _models[other]
    _conds.clear()
    if device == "cuda":
        torch.cuda.empty_cache()
    _models[engine] = model
    _conds[(engine, None, None)] = model.conds
    send({"event": "ready", "detail": f"{engine} on {device}"})
    return model


# Every reference is cloned from speech at this integrated loudness, so all the
# voices in a project come out alike in level. It is the level Turbo already
# normalises to internally; the Expressive model does not normalise at all.
# References built from the video arrive here already level line by line.
REFERENCE_LUFS = -27.0
# Gain never takes a sample past this (-1 dBFS).
REFERENCE_PEAK = 10 ** (-1.0 / 20)


def normalized_reference(path):
    """A copy of the reference at REFERENCE_LUFS, cached by file and
    modification time. Anything that cannot be measured — too short, silent,
    unreadable as audio here — is used as it is."""
    import hashlib
    import tempfile

    stat = os.stat(path)
    key = hashlib.sha1(
        f"{os.path.abspath(path)}|{stat.st_mtime_ns}|{stat.st_size}".encode()
    ).hexdigest()[:16]
    out = os.path.join(tempfile.gettempdir(), "sub-sub-title-tts", f"ref-{key}.wav")
    if os.path.exists(out):
        return out

    try:
        import librosa
        import numpy as np
        import pyloudnorm
        import soundfile

        audio, sr = librosa.load(path, sr=None, mono=True)
        # The meter needs at least one 400 ms block.
        if len(audio) < 0.4 * sr:
            return path
        loudness = pyloudnorm.Meter(sr).integrated_loudness(audio)
        if not np.isfinite(loudness) or loudness < -70:
            return path
        gain = 10 ** ((REFERENCE_LUFS - loudness) / 20)
        peak = float(np.abs(audio).max())
        if peak * gain > REFERENCE_PEAK:
            gain = REFERENCE_PEAK / peak
        os.makedirs(os.path.dirname(out), exist_ok=True)
        soundfile.write(out, audio * gain, sr, subtype="PCM_16")
        return out
    except Exception:  # noqa: BLE001 — a reference that cannot be levelled still clones
        traceback.print_exc()
        return path


def seed_everything(seed):
    import numpy as np
    import torch

    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def generate(request):
    import torchaudio

    engine = request.get("engine", "turbo")
    model = load(engine)

    reference = request.get("reference") or None
    exaggeration = float(request.get("exaggeration", 0.5))
    # The file's modification time too, so a reference replaced in place is
    # prepared afresh rather than served from the cache.
    key = (engine, reference, os.path.getmtime(reference) if reference else None)
    if key not in _conds:
        try:
            # Turbo ignores exaggeration; the standard model bakes it into the
            # conditioning, and `generate` updates it when it differs.
            model.prepare_conditionals(
                normalized_reference(reference),
                exaggeration=exaggeration if engine == "standard" else 0.0,
            )
        except AssertionError as error:
            # Turbo's own check, phrased for a person.
            raise ValueError(
                "The reference clip is too short: Turbo needs more than 5 seconds of the voice."
            ) from error
        _conds[key] = model.conds
    model.conds = _conds[key]

    kwargs = {"temperature": float(request.get("temperature", 0.8))}
    if engine == "standard":
        kwargs["exaggeration"] = exaggeration
        kwargs["cfg_weight"] = float(request.get("cfgWeight", 0.5))

    seed_everything(int(request.get("seed", 0)))
    wav = model.generate(request["text"], **kwargs)
    out = request["out"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    torchaudio.save(out, wav.cpu(), model.sr)
    return {"path": out, "duration": wav.shape[-1] / model.sr}


_aligner = None


def load_aligner():
    """torchaudio's MMS forced aligner: given the words, finds where they are
    spoken. Loaded on first use; its weights (about 1.2 GB) go to TORCH_HOME."""
    global _aligner
    if _aligner is None:
        send({"event": "loading", "detail": "aligner"})
        import torch
        import torchaudio

        bundle = torchaudio.pipelines.MMS_FA
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _aligner = {
            "bundle": bundle,
            "model": bundle.get_model(with_star=False).to(device),
            "tokenizer": bundle.get_tokenizer(),
            "align": bundle.get_aligner(),
            "device": device,
        }
        send({"event": "ready", "detail": f"aligner on {device}"})
    return _aligner


def words_of(text):
    """The aligner's alphabet is lower-case a-z and the apostrophe; anything
    else is dropped, and a word left with no letters (a number, a dash) is
    skipped rather than guessed at."""
    # A tag like [laugh] is a sound, not the word "laugh": it must not be
    # looked for among the spoken words.
    text = re.sub(r"\[[^\]]*\]", " ", text)
    words = []
    for raw in text.lower().replace("’", "'").split():
        word = "".join(ch for ch in raw if ("a" <= ch <= "z") or ch == "'").strip("'")
        if any("a" <= ch <= "z" for ch in word):
            words.append(word)
    return words


def align(request):
    """Where each segment's words fall in the audio: [start, end] per segment,
    in seconds. A segment with no alignable words (a lone tag) gets the gap
    between its neighbours, so the list always matches the segments."""
    import torch
    import torchaudio

    a = load_aligner()
    bundle = a["bundle"]
    waveform, sr = torchaudio.load(request["audio"])
    waveform = waveform.mean(dim=0, keepdim=True)
    if sr != bundle.sample_rate:
        waveform = torchaudio.functional.resample(waveform, sr, bundle.sample_rate)
    seconds = waveform.size(1) / bundle.sample_rate

    segments = [words_of(text) for text in request["segments"]]
    flat = [word for words in segments for word in words]
    if not flat:
        raise ValueError("Nothing in the line can be aligned.")

    with torch.inference_mode():
        emission, _ = a["model"](waveform.to(a["device"]))
        spans = a["align"](emission[0], a["tokenizer"](flat))
    ratio = seconds / emission.size(1)

    marks, at = [], 0
    for words in segments:
        own = spans[at : at + len(words)]
        at += len(words)
        marks.append([own[0][0].start * ratio, own[-1][-1].end * ratio] if own else None)
    # Fill wordless segments from their neighbours.
    for i, mark in enumerate(marks):
        if mark is None:
            before = next((m[1] for m in reversed(marks[:i]) if m), 0.0)
            after = next((m[0] for m in marks[i + 1 :] if m), seconds)
            marks[i] = [before, max(before, after)]
    return {"marks": marks}


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--warmup":
        # Run by the installer: downloads the weights, proves CUDA works.
        load(sys.argv[2])
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            if op == "generate":
                result = generate(request)
            elif op == "align":
                result = align(request)
            else:
                raise ValueError(f"Unknown op: {op}")
            send({"id": request_id, "ok": True, **result})
        except Exception as error:  # noqa: BLE001 — every failure goes back as a reply
            traceback.print_exc()
            send({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()

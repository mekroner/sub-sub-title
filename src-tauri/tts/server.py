"""The voice engine sidecar for sub-sub-title.

Reads one JSON request per line on stdin and answers with one JSON object per
line on stdout. Models are loaded on first use and kept on the GPU. Exits when
stdin closes, which is how the app shuts it down — however the app exits.

The protocol, levelling and speech finding are shared with every engine's
sidecar, in common.py.

    {"id": 1, "op": "generate", "engine": "turbo", "text": "...",
     "reference": "C:/ref.wav" | null, "seed": 7, "exaggeration": 0.5,
     "cfgWeight": 0.5, "temperature": 0.8, "out": "C:/line.wav", "check": false}
    -> {"id": 1, "ok": true, "path": "C:/line.wav", "duration": 2.41,
        "speech": [0.18, 2.30]}
    -> {"id": 1, "ok": false, "error": "..."}

Every take is levelled to VOICE_LUFS before it is written. `speech` is where
the voice starts and ends in it, padded; absent when no voice was found.
With "check": true the reply also carries "score" (how well the words were
found in the take, 0..1) and "rate" (letters per second of speech), or
neither if the check could not be made.

    {"id": 2, "op": "align", "audio": "C:/line.wav", "segments": ["One two", "three"]}
    -> {"id": 2, "ok": true, "marks": [[0.12, 0.81], [0.95, 1.40]]}

    {"id": 3, "op": "reference", "segments": ["C:/a.wav", "C:/b.wav"], "out": "C:/ref.wav"}
    -> {"id": 3, "ok": true, "seconds": 12.4, "kept": 2, "isolated": true}

Builds a cloning reference from a speaker's lines, cut from the film: the
voice is separated from music and effects, each line trimmed to its speech,
the cleanest lines put first and the whole capped at what the models read.

While a model loads: {"event": "loading", "detail": "turbo"}.
"""

import json
import os
import re
import sys
import traceback

# First: it takes stdout for the protocol before any library can print.
from common import (
    REFERENCE_LUFS,
    VOICE_LUFS,
    level,
    seed_everything,
    send,
    speech_window,
)


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
        import soundfile

        audio, sr = librosa.load(path, sr=None, mono=True)
        levelled = level(audio, sr, REFERENCE_LUFS)
        if levelled is audio:
            return path
        os.makedirs(os.path.dirname(out), exist_ok=True)
        soundfile.write(out, levelled, sr, subtype="PCM_16")
        return out
    except Exception:  # noqa: BLE001 — a reference that cannot be levelled still clones
        traceback.print_exc()
        return path


def generate(request):
    import soundfile

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
    audio = level(wav.squeeze(0).cpu().numpy(), model.sr, VOICE_LUFS)
    out = request["out"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    soundfile.write(out, audio, model.sr, subtype="PCM_16")

    duration = len(audio) / model.sr
    result = {"path": out, "duration": duration}
    speech = speech_window(audio, model.sr)
    if speech:
        result["speech"] = speech
    if request.get("check"):
        try:
            result.update(check(out, request["text"], speech or [0.0, duration]))
        except Exception:  # noqa: BLE001 — an unchecked take is still a take
            traceback.print_exc()
    return result


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


def align_words(path, words):
    """The aligner's spans for `words` in the audio at `path`: one list of
    letter spans per word. Also the audio's length, and seconds per frame."""
    import torch
    import torchaudio

    a = load_aligner()
    bundle = a["bundle"]
    waveform, sr = torchaudio.load(path)
    waveform = waveform.mean(dim=0, keepdim=True)
    if sr != bundle.sample_rate:
        waveform = torchaudio.functional.resample(waveform, sr, bundle.sample_rate)
    seconds = waveform.size(1) / bundle.sample_rate

    with torch.inference_mode():
        emission, _ = a["model"](waveform.to(a["device"]))
        spans = a["align"](emission[0], a["tokenizer"](words))
    return spans, seconds, seconds / emission.size(1)


# A line shorter than this is not checked: a word or two gives the aligner too
# little to be sure of (a clean "Run!" scored 0.33), and the padding around
# it swamps the rate.
CHECK_MIN_LETTERS = 8


def check(path, text, speech):
    """How well the take says `text`. Forced alignment always places every
    word somewhere, but a word the voice dropped or garbled is placed with
    little confidence, which pulls the mean letter score down. The rate is
    letters per second of speech: a take that rushes, or stalls in silence,
    falls outside what a person speaks."""
    words = words_of(text)
    letters = sum(len(word.replace("'", "")) for word in words)
    if letters < CHECK_MIN_LETTERS:
        return {}
    rate =round(letters / max(speech[1] - speech[0], 1e-3), 2)
    try:
        spans, _, _ = align_words(path, words)
    except RuntimeError as error:
        # CTC cannot fit more letters than the audio has frames: the take is
        # far too short for its line, which is the surest sign of all.
        if "too long" in str(error):
            return {"score": 0.0, "rate": rate}
        raise
    scores = [span.score for word in spans for span in word]
    return {"score": round(sum(scores) / len(scores), 4) if scores else 0.0, "rate": rate}


def align(request):
    """Where each segment's words fall in the audio: [start, end] per segment,
    in seconds. A segment with no alignable words (a lone tag) gets the gap
    between its neighbours, so the list always matches the segments."""
    segments = [words_of(text) for text in request["segments"]]
    flat = [word for words in segments for word in words]
    if not flat:
        raise ValueError("Nothing in the line can be aligned.")

    spans, seconds, ratio = align_words(request["audio"], flat)

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


# --- References ----------------------------------------------------------------

# Chatterbox reads only the start of a reference: its tone from the first
# 10 s, its manner from the first 6 s (Expressive) or 15 s (Turbo). More than
# this is never heard, so the best lines must come first and fill it.
REFERENCE_SPEECH_SECONDS = 15.0
# Lines are joined with this much silence, so no word runs into the next.
REFERENCE_GAP = 0.15
# A line whose separated voice carries less than this share of its energy is
# mostly music or effects: the voice the model would learn from it is thin and
# full of separation artefacts. Measured: clean dialogue 0.99 and up, the same
# line under music as loud as it 0.49, music alone 0.0.
MIN_VOICE_SHARE = 0.35
# Demucs' fine-tuned bag: one model per stem, the best of its voices.
SEPARATION_MODEL = "htdemucs_ft"

_separator = None


def load_separator():
    """Demucs, to take the voice out of a film's mix. None when it is not
    installed (an engine from before it was added), and references are then
    built from the mix as they always were."""
    global _separator
    if _separator is None:
        try:
            from demucs.pretrained import get_model
        except ImportError:
            return None
        send({"event": "loading", "detail": "separator"})
        import torch

        model = get_model(SEPARATION_MODEL)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _separator = {"model": model.to(device), "device": device}
        send({"event": "ready", "detail": f"separator on {device}"})
    return _separator


def isolate(audio, sr):
    """The voice in `audio` (mono, any rate) and its share of the energy,
    0..1; or None when it cannot be separated."""
    separator = load_separator()
    if separator is None:
        return None
    import librosa
    import numpy as np
    import torch
    from demucs.apply import apply_model

    model = separator["model"]
    mix = librosa.resample(audio, orig_sr=sr, target_sr=model.samplerate) if sr != model.samplerate else audio
    # Demucs works in stereo; a mono line is the same on both sides.
    stereo = torch.from_numpy(np.stack([mix, mix])).float()
    # Normalised as Demucs' own command line does, for the level it was trained at.
    centre, scale = stereo.mean(), stereo.std() + 1e-8
    with torch.inference_mode():
        stems = apply_model(model, ((stereo - centre) / scale)[None], device=separator["device"], progress=False)[0]
    voice = (stems[model.sources.index("vocals")] * scale).mean(dim=0).cpu().numpy()
    voice = librosa.resample(voice, orig_sr=model.samplerate, target_sr=sr) if sr != model.samplerate else voice
    voice = voice[: len(audio)]
    rest = audio[: len(voice)] - voice
    voiced, other = float(np.sum(voice**2)), float(np.sum(rest**2))
    return voice, voiced / max(voiced + other, 1e-12)


def reference(request):
    """Joins the lines at `segments` into one reference at `out`: each line's
    voice, trimmed to its speech, cleanest first, capped and levelled."""
    import librosa
    import numpy as np
    import soundfile

    sr = 24000
    lines, isolated = [], False
    for order, path in enumerate(request["segments"]):
        audio, _ = librosa.load(path, sr=sr, mono=True)
        share = None
        try:
            separated = isolate(audio, sr)
        except Exception:  # noqa: BLE001 — an unseparated line is still a line
            traceback.print_exc()
            separated = None
        if separated is not None:
            audio, share = separated
            isolated = True
            if share < MIN_VOICE_SHARE:
                continue
        window = speech_window(audio, sr)
        if window is None:
            continue
        audio = audio[int(window[0] * sr) : int(window[1] * sr)]
        lines.append((share, order, level(audio, sr, REFERENCE_LUFS)))
    if not lines:
        raise ValueError("No clear speech was found in these lines. Try others, away from music.")

    # Cleanest first. Shares a hair apart are the same to the ear, so among
    # those, and lines no separation could judge, the longest go first: a
    # whole sentence shows more of how someone talks than a word or two.
    lines.sort(key=lambda line: (-round(line[0] or 0.0, 2), -len(line[2]), line[1]))
    gap = np.zeros(int(REFERENCE_GAP * sr), dtype=np.float32)
    pieces, seconds, kept = [], 0.0, 0
    for _, _, audio in lines:
        if pieces:
            pieces.append(gap)
            seconds += REFERENCE_GAP
        room = REFERENCE_SPEECH_SECONDS - seconds
        if room <= 0.3:
            pieces.pop()
            break
        audio = audio[: int(room * sr)]
        pieces.append(audio.astype(np.float32))
        seconds += len(audio) / sr
        kept += 1
    joined = level(np.concatenate(pieces), sr, REFERENCE_LUFS)
    out = request["out"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    soundfile.write(out, joined, sr, subtype="PCM_16")
    return {"seconds": round(len(joined) / sr, 3), "kept": kept, "isolated": isolated}


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--warmup":
        # Run by the installer: downloads the weights, proves CUDA works.
        if sys.argv[2] == "extras":
            if load_separator() is None:
                raise SystemExit("Demucs is not installed.")
        else:
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
            elif op == "reference":
                result = reference(request)
            else:
                raise ValueError(f"Unknown op: {op}")
            send({"id": request_id, "ok": True, **result})
        except Exception as error:  # noqa: BLE001 — every failure goes back as a reply
            traceback.print_exc()
            send({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()

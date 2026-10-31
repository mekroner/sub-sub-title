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

While a model loads: {"event": "loading", "detail": "turbo"}.
"""

import json
import os
import random
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
    _conds[(engine, None)] = model.conds
    send({"event": "ready", "detail": f"{engine} on {device}"})
    return model


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
    key = (engine, reference)
    if key not in _conds:
        try:
            # Turbo ignores exaggeration; the standard model bakes it into the
            # conditioning, and `generate` updates it when it differs.
            model.prepare_conditionals(
                reference, exaggeration=exaggeration if engine == "standard" else 0.0
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
            if request.get("op") != "generate":
                raise ValueError(f"Unknown op: {request.get('op')}")
            send({"id": request_id, "ok": True, **generate(request)})
        except Exception as error:  # noqa: BLE001 — every failure goes back as a reply
            traceback.print_exc()
            send({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()

"""Resident native StartLux decisions. One model at a time, no network or writes."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
import sys, json, time, gc, hashlib
from collections import OrderedDict
import psutil
import mlx.core as mx
from startlux_decision.mlx_model import MLXDecision
from selection import choose_model, retain_current

config = json.loads(sys.argv[1])
model = None
current = None
switched = 0
GIB = 1024 ** 3
cache = OrderedDict()

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def select_model():
    global model, current, switched
    available = psutil.virtual_memory().available / GIB
    reclaimable = mx.get_active_memory() / GIB if model else 0
    headroom = available + reclaimable
    load = os.getloadavg()[0] / (os.cpu_count() or 1)
    mode = config.get("mode", "auto")
    try:
        choice = choose_model(mode, config["models"], headroom, load)
    except RuntimeError:
        if model:
            model = None; current = None; cache.clear(); gc.collect(); mx.clear_cache()
        raise
    if model and retain_current(mode, current, choice, time.monotonic() - switched, headroom):
        choice = current
    changed = current != choice
    if changed:
        model = None; current = None; cache.clear(); gc.collect(); mx.clear_cache()
        mx.reset_peak_memory()
        model = MLXDecision(config["models"][choice]["path"])
        current = choice; switched = time.monotonic()
    return {"size": current, "alias": config["models"][current]["alias"], "revision": config["models"][current]["revision"],
            "switched": changed, "availableGiB": available, "loadPerCpu": load}

emit({"ready": True})
for line in sys.stdin:
    try:
        request = json.loads(line)
        started = time.perf_counter()
        selection = select_model()
        key = hashlib.sha256(json.dumps([selection["alias"], selection["revision"], request["state"], request["questions"]], ensure_ascii=False).encode()).hexdigest()
        previous = cache.get(key)
        cached = previous is not None and time.monotonic() - previous[0] < 300
        if cached:
            _, answers, usage = previous
            cache.move_to_end(key)
        else:
            answers, usage = model.decide(request["state"], request["questions"])
            cache[key] = (time.monotonic(), answers, usage)
            if len(cache) > 128:
                cache.popitem(last=False)
        emit({"answers": answers, "usage": usage, "model": selection, "cached": cached, "elapsedMs": (time.perf_counter()-started)*1000, "peakModelBytes": mx.get_peak_memory()})
    except Exception as error:
        emit({"error": str(error)})

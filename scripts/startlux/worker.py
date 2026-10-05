"""Resident native StartLux decisions. One model at a time, no network or writes."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
import sys, json, time, gc
import psutil
import mlx.core as mx
from startlux_decision.mlx_model import MLXDecision

config = json.loads(sys.argv[1])
model = None
current = None
switched = 0
GIB = 1024 ** 3

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def select_model():
    global model, current, switched
    available = psutil.virtual_memory().available / GIB
    reclaimable = mx.get_active_memory() / GIB if model else 0
    headroom = available + reclaimable
    load = os.getloadavg()[0] / (os.cpu_count() or 1)
    mode = config.get("mode", "auto")
    # Admission includes weight residency, activations, and 4 GiB host reserve.
    choice = "4b" if mode == "4b" or (mode == "auto" and headroom >= 14 and load < .85) else "2b"
    if headroom < (14 if choice == "4b" else 8):
        if mode == "auto" and headroom >= 8:
            choice = "2b"
        else:
            if model:
                model = None; current = None; gc.collect(); mx.clear_cache()
            raise RuntimeError("可用内存不足，保留原检索并交给常规 Agent")
    if choice not in config["models"]:
        if mode == "auto" and "2b" in config["models"]: choice = "2b"
        else: raise RuntimeError("所选决策模型尚未通过 osdk 安装")
    if model and mode == "auto" and current != choice and time.monotonic() - switched < 300 and available >= 4:
        choice = current
    changed = current != choice
    if changed:
        model = None; current = None; gc.collect(); mx.clear_cache()
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
        answers, usage = model.decide(request["state"], request["questions"])
        emit({"answers": answers, "usage": usage, "model": selection, "elapsedMs": (time.perf_counter()-started)*1000, "peakModelBytes": mx.get_peak_memory()})
    except Exception as error:
        emit({"error": str(error)})

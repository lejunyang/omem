"""Same-input quality and warm budget coverage, without the host result cache."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
import sys, json, time, pathlib
import psutil
import mlx.core as mx
from startlux_decision.mlx_model import MLXDecision
from selection import choose_model

inputs = json.loads(pathlib.Path(sys.argv[1]).read_text())
selection = json.loads(sys.argv[2])
output = pathlib.Path(sys.argv[3])
size = selection["size"]
report = {"model": selection, "items": [], "budget": {"items": []}}

def save():
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2))

try:
    available = psutil.virtual_memory().available / 1024 ** 3
    load = os.getloadavg()[0] / (os.cpu_count() or 1)
    report["admission"] = {"availableGiB": available, "loadPerCpu": load}
    choose_model(size, {size: selection}, available, load)
    started = time.perf_counter()
    model = MLXDecision(selection["path"])
    # A separate request warms the model; it is excluded from measured cases.
    model.decide(inputs["warmState"], inputs["questions"])
    report["warmMs"] = (time.perf_counter() - started) * 1000
    for item in inputs["items"]:
        # Keep the production resource guard, including reclaimable resident bytes.
        choose_model(size, {size: selection},
                     (psutil.virtual_memory().available + mx.get_active_memory()) / 1024 ** 3, load)
        started = time.perf_counter()
        answers, usage = model.decide(item["state"], inputs["questions"])
        result = {"id": item["id"], "inputDigest": item["inputDigest"],
                  "answers": answers, "usage": usage,
                  "elapsedMs": (time.perf_counter() - started) * 1000}
        report["items"].append(result)
        save()
        print(json.dumps({"size": size, "id": item["id"], "ms": result["elapsedMs"],
                          "relevance": answers["relevance"]}, ensure_ascii=False), flush=True)
    # Exactly the same inputs, in the same order; no marker or changed question.
    # Native inference cannot be interrupted: the last request may cross the limit.
    started = time.perf_counter()
    for item in inputs["items"]:
        if (time.perf_counter() - started) * 1000 >= inputs["budgetMs"]:
            break
        request_start = time.perf_counter()
        answers, _ = model.decide(item["state"], inputs["questions"])
        elapsed = (time.perf_counter() - started) * 1000
        report["budget"]["items"].append({"id": item["id"], "inputDigest": item["inputDigest"],
            "answers": answers, "elapsedMs": (time.perf_counter() - request_start) * 1000,
            "completedWithinBudget": elapsed <= inputs["budgetMs"]})
    report["budget"]["elapsedMs"] = (time.perf_counter() - started) * 1000
    report["peakModelBytes"] = mx.get_peak_memory()
    report["complete"] = True
except Exception as error:
    report["unavailable"] = str(error)
finally:
    save()

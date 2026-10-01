"""Reaggregate upstream saved metrics; does NOT rerun retrieval or validate gold labels.

python audit_artifacts.py --data-dir /tmp/mempalace-audit --download
Network is optional; without --download only already-downloaded files are read.
All downloads use immutable GitHub commit URLs and a bounded file size.
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

COMMIT = "8c4865f70c49b6346c53474a9e5684c5f17d3fa9"
FILES = {
    "results_mempal_raw_session_20260414_1629.jsonl": "2b71b5e514279c28443736561e2ac453045520b0f8832ff092e8a6143965e5d1",
    "results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl": "5f5849e8facdbdec673967dfbd9dd288323983ae824ca787ffa89110dd1b588d",
    "results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl": "8bc55a31d7cc260564f2607feae49f396d58dea6ba9de5141ce4abbec67ba624",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    root = args.data_dir
    root.mkdir(parents=True, exist_ok=True)
    names = [*FILES, "lme_split_50_450.json"]
    if args.download:
        for name in names:
            req = urllib.request.Request(
                f"https://raw.githubusercontent.com/mempalace/mempalace/{COMMIT}/benchmarks/{name}",
                headers={"User-Agent": "omem-research-audit"},
            )
            with urllib.request.urlopen(req, timeout=60) as response:
                data = response.read(16_000_001)
            if len(data) > 16_000_000:
                raise ValueError("Artifact size limit exceeded")
            (root / name).write_bytes(data)
    split = json.loads((root / "lme_split_50_450.json").read_text())
    assert len(set(split["dev"])) == 50 and len(set(split["held_out"])) == 450
    assert not (set(split["dev"]) & set(split["held_out"]))
    out = []
    for name, expected in sorted(FILES.items()):
        data = (root / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected:
            raise ValueError(f"Artifact hash mismatch: {name}")
        rows = [json.loads(line) for line in data.splitlines() if line.strip()]
        ids = {row["question_id"] for row in rows}
        assert len(ids) == len(rows), "Duplicate question IDs"
        metrics = {}
        for group, values in rows[0]["retrieval_results"]["metrics"].items():
            for key in values:
                nums = [row["retrieval_results"]["metrics"][group][key] for row in rows]
                metrics[f"{group}/{key}"] = {"sum": sum(nums), "mean": sum(nums) / len(nums)}
        overlap = len(ids & set(split["dev"]))
        if "held_out" in name:
            assert ids == set(split["held_out"]), "Held-out IDs differ from split"
        out.append({"file": name, "rows": len(rows), "unique_question_ids": len(ids),
                    "dev_overlap": overlap, "sha256": digest, "metrics": metrics})
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()

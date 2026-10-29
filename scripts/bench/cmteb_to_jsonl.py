"""C-MTEB retrieval parquet (corpus, queries, qrels) -> corpus.jsonl + queries.jsonl for scripts/eval-retrieval.ts.

Called by scripts/bench/fetch.ts:
    python -I cmteb_to_jsonl.py <corpus.parquet> <queries.parquet> <qrels.parquet> <out_dir> <seed> <n_queries> <n_distractors>

Subset: n_queries random questions that have a positive, all their relevant documents, and
n_distractors random other documents. With seed 7, 400 and 15000 this is the T2Retrieval subset the
2026-10-12 numbers in docs/v2/evaluation.md were measured on (same steps as the former prep-t2.py).
"""
import json
import os
import random
import sys

import pandas as pd

corpus_path, queries_path, qrels_path, out_dir, seed, n_queries, n_distractors = sys.argv[1:8]
random.seed(int(seed))
corpus = pd.read_parquet(corpus_path)
queries = pd.read_parquet(queries_path)
qrels = pd.read_parquet(qrels_path)
print(corpus.shape, queries.shape, qrels.shape, qrels.columns.tolist(), file=sys.stderr)
qrels = qrels[qrels["score"] > 0]
qids = sorted(qrels["qid"].unique())
random.shuffle(qids)
qids = qids[: int(n_queries)]
rel = qrels[qrels["qid"].isin(qids)]
need = set(rel["pid"].astype(str))
ids = corpus["id"].astype(str).tolist()
others = [i for i in ids if i not in need]
random.shuffle(others)
keep = need | set(others[: int(n_distractors)])
sub = corpus[corpus["id"].astype(str).isin(keep)]
with open(os.path.join(out_dir, "corpus.jsonl"), "w", encoding="utf-8") as f:
    for r in sub.itertuples():
        f.write(json.dumps({"id": str(r.id), "text": r.text}, ensure_ascii=False) + "\n")
qtext = dict(zip(queries["id"].astype(str), queries["text"]))
with open(os.path.join(out_dir, "queries.jsonl"), "w", encoding="utf-8") as f:
    for q in qids:
        rows = rel[rel["qid"] == q]
        rels = {str(p): int(s) for p, s in zip(rows["pid"], rows["score"])}
        f.write(json.dumps({"id": str(q), "text": qtext[str(q)], "rels": rels}, ensure_ascii=False) + "\n")
print(len(sub), "docs", len(qids), "queries", "avg rel", round(len(rel) / max(1, len(qids)), 2), "avg len", round(sub["text"].str.len().mean(), 1), file=sys.stderr)

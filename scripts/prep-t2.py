import json, random
from huggingface_hub import hf_hub_download
import pandas as pd
random.seed(7)
corpus = pd.read_parquet(hf_hub_download("C-MTEB/T2Retrieval", "data/corpus-00000-of-00001-8afe7b7a7eca49e3.parquet", repo_type="dataset"))
queries = pd.read_parquet(hf_hub_download("C-MTEB/T2Retrieval", "data/queries-00000-of-00001-930bf3b805a80dd9.parquet", repo_type="dataset"))
qrels = pd.read_parquet(hf_hub_download("C-MTEB/T2Retrieval-qrels", "data/dev-00000-of-00001-92ed0416056ff7e1.parquet", repo_type="dataset"))
print(corpus.shape, queries.shape, qrels.shape, qrels.columns.tolist())
qrels = qrels[qrels["score"] > 0]
qids = sorted(qrels["qid"].unique())
random.shuffle(qids)
qids = qids[:400]
rel = qrels[qrels["qid"].isin(qids)]
need = set(rel["pid"].astype(str))
ids = corpus["id"].astype(str).tolist()
others = [i for i in ids if i not in need]
random.shuffle(others)
keep = need | set(others[:15000])
sub = corpus[corpus["id"].astype(str).isin(keep)]
with open("t2_corpus.jsonl", "w") as f:
    for r in sub.itertuples():
        f.write(json.dumps({"id": str(r.id), "text": r.text}, ensure_ascii=False) + "\n")
qtext = dict(zip(queries["id"].astype(str), queries["text"]))
with open("t2_queries.jsonl", "w") as f:
    for q in qids:
        rels = {str(p): int(s) for p, s in zip(rel[rel["qid"] == q]["pid"], rel[rel["qid"] == q]["score"])}
        f.write(json.dumps({"id": str(q), "text": qtext[str(q)], "rels": rels}, ensure_ascii=False) + "\n")
print(len(sub), "docs", len(qids), "queries", "avg rel", len(rel)/len(qids), "avg len", sub["text"].str.len().mean())

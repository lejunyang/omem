import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['TOKENIZERS_PARALLELISM']='false'
import json, pathlib, sys, time, resource, importlib.metadata
import mlx.core as mx
from startlux_decision.mlx_model import MLXDecision
root=pathlib.Path(__file__).parent
requests=json.loads((root/'cases.json').read_text())
start=time.perf_counter()
model=MLXDecision(sys.argv[1])
load_ms=(time.perf_counter()-start)*1000
report={'upstreamCommit':'0e7a2e81b9c92756e26d8edd843a44d50e362669','modelRevision':sys.argv[3],'backend':'official MLXDecision bf16','questions':requests['questions'],'loadMs':load_ms,'items':[],'method':'One native request per passage with six independent typed questions. Expected relevance never sent to model. Synthetic examples and current HTTP candidates; no production filtering or calibrated threshold.'}
for item in requests['items']:
 start=time.perf_counter()
 answers,usage=model.decide(item['state'], requests['questions'])
 ms=(time.perf_counter()-start)*1000
 result={**item,'answers':answers,'usage':usage,'elapsedMs':ms,'peakModelBytes':mx.get_peak_memory(),'peakResidentBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
 report['items'].append(result)
 pathlib.Path(sys.argv[2]).write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps({'id':item['id'],'ms':round(ms),'answers':{k:v.get('choice',v.get('score',v.get('noul'))) for k,v in answers.items()}},ensure_ascii=False),flush=True)
# Reuse the resident model and repeat exactly the same first passage after warm-up.
start=time.perf_counter()
answers,usage=model.decide(requests['items'][0]['state'],requests['questions'])
report['warmRepeat']={'elapsedMs':(time.perf_counter()-start)*1000,'answers':answers,'usage':usage}
report['complete']=True
report['versions']={p:importlib.metadata.version(p) for p in ['mlx','mlx-lm','torch','transformers']}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'complete':True,'loadMs':round(load_ms),'warmRepeatMs':round(report['warmRepeat']['elapsedMs'])}),flush=True)

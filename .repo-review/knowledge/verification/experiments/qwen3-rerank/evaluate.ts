import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {AutoTokenizer,AutoModelForCausalLM,Tensor,env} from '@huggingface/transformers';

const snapshot=JSON.parse(execFileSync('osdk',['model','show','qwen3-relevance','--json'],{encoding:'utf8'})).model;
const sourceFile=new URL('../../navigation-passages.json',import.meta.url).pathname;
const sourceBytes=readFileSync(sourceFile), source=JSON.parse(sourceBytes.toString());
const report:any={at:new Date().toISOString(),status:'loading',runtime:'@huggingface/transformers@4.3.0 + onnxruntime-node@1.30.0',device:'cpu',dtype:'q4',threads:2,model:snapshot.repository,revision:snapshot.revision,files:snapshot.files,sourceReport:sourceFile,sourceReportSha256:createHash('sha256').update(sourceBytes).digest('hex'),corpusDigest:source.corpusDigest,method:'Exactly the recorded after-bge-v2 local passage inputs. Compare model-only ordering, not fused retrieval, recall or answer accuracy. No source-dependent instruction or tuning.',cases:[]};
const save=()=>writeFileSync(process.env.QWEN_REPORT ?? new URL('../../../../runtime/research/qwen3-repeat.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
env.allowRemoteModels=false;env.useFSCache=false;
const start=performance.now();
const tokenizer=await AutoTokenizer.from_pretrained(snapshot.snapshot_path,{local_files_only:true});
const model=await AutoModelForCausalLM.from_pretrained(snapshot.snapshot_path,{local_files_only:true,dtype:'q4',device:'cpu',session_options:{intraOpNumThreads:2}});
report.loadMs=Math.round(performance.now()-start);
const yes=tokenizer.encode('yes',{add_special_tokens:false})[0]!, no=tokenizer.encode('no',{add_special_tokens:false})[0]!;
const prefix='<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';
const suffix='<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';
const prefixIds=tokenizer.encode(prefix,{add_special_tokens:false}),suffixIds=tokenizer.encode(suffix,{add_special_tokens:false});
const instructions={default:'Given a web search query, retrieve relevant passages that answer the query',answer:'Retrieve passages that directly answer the question, including the applicable status, constraints or code behavior. Topical mentions alone are insufficient.'};
report.prompt={prefix,suffix,instructions,maximumTokens:8192,tokenYes:yes,tokenNo:no};
async function score(query:string,text:string,instruction:string){
  const start=performance.now();
  const body=tokenizer.encode(`<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${text}`,{add_special_tokens:false});
  const limit=8192-prefixIds.length-suffixIds.length;
  const ids=[...prefixIds,...body.slice(0,limit),...suffixIds];
  const input_ids=new Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,ids.length]);
  const attention_mask=new Tensor('int64',new BigInt64Array(ids.length).fill(1n),[1,ids.length]);
  const output=await model({input_ids,attention_mask});
  const logits=output.logits,offset=(logits.dims[1]-1)*logits.dims[2];
  const delta=Number(logits.data[offset+yes])-Number(logits.data[offset+no]);
  if(!Number.isFinite(delta))throw Error('Invalid yes/no logits');
  const result={score:1/(1+Math.exp(-delta)),delta,tokens:ids.length,truncated:body.length>limit,ms:Math.round(performance.now()-start)};
  for(const tensor of Object.values(output) as any[])if(tensor?.dispose)tensor.dispose();
  input_ids.dispose();attention_mask.dispose();
  return result;
}
try {
  report.calibration=[];
  for(const text of ['中国的首都是北京。','重力是物体之间的吸引力。'])report.calibration.push({query:'中国的首都是哪里？',text,...await score('中国的首都是哪里？',text,instructions.default)});
  if(report.calibration[0].score<=report.calibration[1].score)throw Error('Basic Chinese relevance calibration failed');
  report.status='running'; save();console.log('READY',report.loadMs,report.calibration);
  for(const c of source.cases){
    const baseline=c.variants['after-bge-v2']?.ranking;
    if(!baseline?.passages?.length)continue;
    const result:any={query:c.query,baselineModel:baseline.model,baselineMs:baseline.ms,passages:baseline.passages.map((p:any)=>({text:p.text,bge:p.score}))};
    report.cases.push(result);
    for(const [variant,instruction] of Object.entries(instructions)){
      const started=performance.now();
      for(let i=0;i<result.passages.length;i++){
        result.passages[i][variant]=await score(c.query,result.passages[i].text,instruction);
        if((i+1)%10===0){save();console.log('PROGRESS',report.cases.length,variant,i+1);}
      }
      result[variant+'Ms']=Math.round(performance.now()-started);save();
      console.log('CASE',report.cases.length,variant,c.query,result[variant+'Ms']);
    }
  }
  report.status='completed';report.completedAt=new Date().toISOString();report.rss=process.memoryUsage().rss;
} catch(error){report.status='failed';report.error=String(error);process.exitCode=1;console.error(error);}
finally{save();await model.dispose();}

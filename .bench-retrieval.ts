import { testApp } from "./test/helpers.ts";
import { upsertSource } from "./src/sources/store.ts";
import { search } from "./src/search/search.ts";
import { closeReadProcess } from "./src/search/read-process.ts";
import { createHash } from "node:crypto";
const app = testApp();
for (let i=0; i<300; i++) upsertSource(app, { spaceId:"personal", kind:"doc", uri:"sample/"+i, title:"示例"+i, text:"分组 "+(i%10)+" 测试资料 "+i });
const times:number[]=[];
const digest=createHash("sha256");
for(let i=0;i<220;i++){
  const start=performance.now();
  const hits=await search(app,"分组 "+(i%10),{spaces:["personal"],limit:10});
  if(i>=20) times.push(performance.now()-start);
  digest.update(JSON.stringify(hits.map(({sourceId,...hit})=>hit)));
}
times.sort((a,b)=>a-b);
console.log(times[100],times[190],digest.digest("hex"));
closeReadProcess(app);
app.db.close();

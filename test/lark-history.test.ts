import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { testApp } from "./helpers.ts";
import { all, one, run } from "../src/core/db.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { historyPage, historyScan } from "../src/channels/lark-history.ts";
import { backfillTick, backfillStatus, pollLark, requestBackfill, setSubscriptions } from "../src/channels/lark-personal.ts";
import { persistChatMessages, storeMessages, type LarkMessage } from "../src/channels/lark-messages.ts";
import { upsertSource } from "../src/sources/store.ts";

const at = Date.now()-10*86400_000;
const msg = (id:string, time=at):LarkMessage => ({message_id:id,chat_id:"oc_history",msg_type:"text",content:id,create_time:String(time),sender:{id:"ou_other",name:"小王"}});
const setup = () => {
  const app = testApp();
  Object.assign(app.config.lark.capture,{mode:"subscribed",attachments:false,docs:false,calendar:false,minutes:false});
  app.config.lark.capture.backfill = {days:0,policies:[],pagesPerMinute:60,concurrency:1};
  requestBackfill(app,"oc_history",0);
  const input = {chatId:"oc_history",name:"历史群",spaceId:"personal",target:Date.parse("2010-01-01"),ingest:false};
  return {app,input};
};
afterEach(()=>setLarkCliForTests(null));

describe("remote-evidence history traversal",()=>{
  it("continues past a fully known page, preserves equal timestamps and resumes after pagination failure",async()=>{
    const {app,input}=setup();
    persistChatMessages(app,{...input,messages:[msg("om_known")]});
    let fail=true;
    const calls:string[][]=[];
    setLarkCliForTests(async args=>{
      calls.push(args);
      if (!args.includes("--page-token")) return {data:{messages:[msg("om_known")],has_more:true,page_token:"next"}};
      if(fail) throw new Error("temporary page failure");
      return {data:{messages:[msg("om_same_time"),msg("om_older",at-1000)],has_more:false}};
    });
    await historyPage(app,input);
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    expect(historyScan(app,"oc_history")?.token).toBe("next");
    await expect(historyPage(app,input)).rejects.toThrow("temporary");
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    expect(historyScan(app,"oc_history")?.token).toBe("next");
    fail=false;
    await historyPage(app,input);
    expect(backfillStatus(app,"oc_history")).toMatchObject({pending:false,evidence:"remote-exhausted"});
    expect(all(app.db,"select 1 from lark_messages where chat_id='oc_history'")).toHaveLength(3);
    expect(calls.map(a=>a[a.indexOf("--end")+1])).toEqual(Array(3).fill(calls[0][calls[0].indexOf("--end")+1]));
    expect(calls[2][calls[2].indexOf("--page-token")+1]).toBe("next");
    expect(one<{oldest_ms:number}>(app.db,"select oldest_ms from lark_cursors where chat_id='oc_history'")!.oldest_ms).toBe(at-1000);
  });

  it.each([undefined,true])("does not pretend an empty ambiguous or malformed page is exhaustion (%s)",async more=>{
    const {app,input}=setup();
    setLarkCliForTests(async()=>({data:{messages:[],has_more:more}}));
    await expect(historyPage(app,input)).rejects.toThrow(/has_more|令牌/);
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    expect(historyScan(app,"oc_history")?.evidence).toBeUndefined();
  });

  it("terminates on a real empty last page without fabricating oldest=target",async()=>{
    const {app,input}=setup();
    const before=one<{oldest_ms:number}>(app.db,"select oldest_ms from lark_cursors where chat_id='oc_history'")!.oldest_ms;
    setLarkCliForTests(async()=>({data:{messages:[],has_more:false}}));
    await historyPage(app,input);
    expect(backfillStatus(app,"oc_history").pending).toBe(false);
    expect(one<{oldest_ms:number}>(app.db,"select oldest_ms from lark_cursors where chat_id='oc_history'")!.oldest_ms).toBe(before);
    // Re-request through the supported API; leave other queued groups untouched.
    requestBackfill(app,"oc_another",0);
    requestBackfill(app,"oc_history",0);
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    expect(backfillStatus(app,"oc_another").pending).toBe(true);
  });

  it("revalidates old false-complete cursors and keeps existing queue requests",()=>{
    const {app}=setup();
    run(app.db,"update lark_cursors set oldest_ms=backfill_to_ms where chat_id='oc_history'");
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    expect(one(app.db,"select 1 from lark_cursors where chat_id='oc_history'")).toBeTruthy();
  });

  it("traverses topics including roots older than the target, saves each page and retries the exact failing token",async()=>{
    const {app,input}=setup();
    input.target=Date.now()-365*86400_000;
    run(app.db,"update lark_cursors set backfill_to_ms=? where chat_id='oc_history'",input.target);
    let fail=true;
    const calls:string[][]=[];
    setLarkCliForTests(async args=>{
      calls.push(args);
      if(args[1]==="+chat-messages-list") return {data:{messages:[{...msg("om_old_root",Date.now()-400*86400_000),thread_id:"omt_history"}],has_more:false}};
      if(!args.includes("--page-token")) return {data:{messages:[msg("om_reply")],has_more:true,page_token:"reply-next"}};
      if(fail) throw new Error("topic interruption");
      return {data:{messages:[msg("om_reply_same_time"),msg("om_too_old",Date.now()-400*86400_000)],has_more:false}};
    });
    await historyPage(app,input);
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    expect(Date.parse(calls[0][calls[0].indexOf("--start")+1])).toBeLessThan(input.target);
    await historyPage(app,input);
    await expect(historyPage(app,input)).rejects.toThrow("topic interruption");
    expect(one(app.db,"select 1 from lark_messages where message_id='om_reply'")).toBeTruthy();
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    fail=false;
    await historyPage(app,input);
    expect(backfillStatus(app,"oc_history").pending).toBe(false);
    expect(all(app.db,"select 1 from lark_messages")).toHaveLength(2);
    expect(one(app.db,"select thread_id from lark_messages where message_id='om_reply_same_time'")).toMatchObject({thread_id:"omt_history"});
  });

  it("fills resources on known IDs, preserves legacy text lines and does not checkpoint a failed attachment",async()=>{
    const {app,input}=setup();
    app.config.lark.capture.attachments=true;
    const src=upsertSource(app,{spaceId:"personal",kind:"chat",uri:"lark:oc_history",title:"历史群",text:"[旧行] 小王: 图片 (om_known_image)"});
    let fail=true;
    setLarkCliForTests(async(_args,cwd)=>{
      if(!fail){mkdirSync(`${cwd}/lark-im-resources`,{recursive:true});writeFileSync(`${cwd}/lark-im-resources/img_example.png`,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));}
      return {data:{messages:[{...msg("om_known_image"),msg_type:"image",resources:[{key:"img_example",type:"image",...(fail?{error:true}:{local_path:"lark-im-resources/img_example.png"})}]}],has_more:false}};
    });
    await expect(historyPage(app,input)).rejects.toThrow("附件下载未完成");
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    fail=false;
    await historyPage(app,input);
    expect(backfillStatus(app,"oc_history").pending).toBe(false);
    expect(one<{resources:string}>(app.db,"select resources from lark_messages where message_id='om_known_image'")!.resources).toContain('"file"');
    expect(one<{text:string}>(app.db,"select text from sources where id=?",src.id)!.text.match(/\(om_known_image\)/g)).toHaveLength(1);
    expect(all(app.db,"select 1 from sources where uri like 'lark:oc_history%'")).toHaveLength(1);
  });

  it("pulls history apart from the live poll, fairly and with the configured concurrency, and notices rate limits",async()=>{
    const {app}=setup();
    requestBackfill(app,"oc_second",0);
    setSubscriptions(app,[{chatId:"oc_live",name:"活跃群",spaceId:"personal"}]);
    const reads:string[]=[];
    setLarkCliForTests(async args=>{
      if(args[0]==="auth") return {data:{identities:{user:{openId:"ou_owner"}}}};
      if(args[1]==="+messages-search") return {data:{messages:[],has_more:false}};
      if(args[1]==="+chat-messages-list"){
        const id=args[args.indexOf("--chat-id")+1];reads.push(id);
        return {data:{messages:[],has_more:id!=="oc_live",page_token:String(reads.length)}};
      }
      return {data:{}};
    });
    await pollLark(app);
    expect(reads).toEqual(["oc_live"]); // the poll no longer spends time on history
    expect(await backfillTick(app)).toMatchObject({pages:1,rateLimited:false,left:2});
    expect(await backfillTick(app)).toMatchObject({pages:1,left:2});
    expect(reads).toEqual(["oc_live","oc_history","oc_second"]);
    app.config.lark.capture.backfill.concurrency=2;
    await backfillTick(app);
    expect(reads.slice(3).sort()).toEqual(["oc_history","oc_second"]);
    expect(backfillStatus(app,"oc_history").pending).toBe(true);
    const token=historyScan(app,"oc_history")!.token;
    setLarkCliForTests(async()=>{throw new Error("HTTP 429 Too Many Requests");});
    expect(await backfillTick(app)).toMatchObject({pages:2,rateLimited:true,left:2});
    expect(historyScan(app,"oc_history")!.token).toBe(token); // a failed page keeps its place
  });

  it("lets the assistant set the pace and reports overall progress",async()=>{
    const {app}=setup();
    const { callTool } = await import("../src/agents/tools.ts");
    const r=await callTool({app,runId:null,spaceId:"personal",spaces:null,tools:null,actor:"user"},"set_lark_backfill",{pages_per_minute:120,concurrency:4});
    expect(r.isError).toBe(false);
    expect(app.config.lark.capture.backfill).toMatchObject({pagesPerMinute:120,concurrency:4});
    expect(r.text).toContain("要回溯 1 个会话");
    expect(r.text).toContain("未开始 1");
  });
  it("repairs an orphan known ID before advancing next, with exactly one database row and source line on replay",async()=>{
    const {app,input}=setup();
    const orphan=msg("om_orphan");
    storeMessages(app,"oc_history",[orphan],{});
    expect(one(app.db,"select source_id,line,archive from lark_messages where message_id='om_orphan'")).toEqual({source_id:null,line:null,archive:null});
    expect(one(app.db,"select 1 from sources where instr(text,'(om_orphan)')>0")).toBeUndefined();
    const tokens:(string|undefined)[]=[];
    setLarkCliForTests(async args=>{
      const token=args.includes("--page-token")?args[args.indexOf("--page-token")+1]:undefined;
      tokens.push(token);
      return {data:token?{messages:[],has_more:false}:{messages:[orphan],has_more:true,page_token:"next"}};
    });
    for(let replay=0;replay<2;replay++) {
      if(replay) requestBackfill(app,"oc_history",0);
      await historyPage(app,input);
      const repaired=one<{source_id:string;line:number;archive:string}>(app.db,"select source_id,line,archive from lark_messages where message_id='om_orphan'")!;
      expect(repaired.line).toBe(1);
      expect(repaired.archive).toBe(new Date(at).toISOString().slice(0,7));
      expect(one(app.db,"select kind,uri from sources where id=?",repaired.source_id)).toEqual({kind:"chat",uri:`lark:oc_history@${repaired.archive}`});
      expect(historyScan(app,"oc_history")).toMatchObject({phase:"main",token:"next"});
      expect(backfillStatus(app,"oc_history").pending).toBe(true);
      await historyPage(app,input);
      expect(backfillStatus(app,"oc_history")).toMatchObject({pending:false,evidence:"remote-exhausted"});
      expect(all(app.db,"select 1 from lark_messages where message_id='om_orphan'")).toHaveLength(1);
      expect(all<{text:string}>(app.db,"select text from sources where instr(text,'(om_orphan)')>0").flatMap(r=>r.text.split("\n").filter(l=>l.endsWith("(om_orphan)")))).toHaveLength(1);
    }
    expect(tokens).toEqual([undefined,"next",undefined,"next"]);
  });

  it("restores ingest intent on automatic revalidation without resetting its fixed window, token, phase or forty queued targets",async()=>{
    const {app,input}=setup();
    for(let i=1;i<40;i++) requestBackfill(app,`oc_queue_${i}`,365);
    // Old code left an ended timestamp but no remote exhaustion evidence.
    run(app.db,"update lark_cursors set oldest_ms=backfill_to_ms,backfill_ingest=0 where chat_id='oc_history'");
    const queued=all(app.db,"select chat_id,backfill_to_ms from lark_cursors order by chat_id");
    expect(queued).toHaveLength(40);
    setLarkCliForTests(async args=>{
      if(args[0]==="auth") return {data:{identities:{user:{openId:"ou_owner"}}}};
      if(args[1]==="+messages-search") return {data:{messages:[],has_more:false}};
      if(args[1]==="+chat-messages-list") {
        expect(args[args.indexOf("--chat-id")+1]).toBe("oc_history");
        return {data:{messages:[msg("om_root")],has_more:true,page_token:"next"}};
      }
      return {data:{}};
    });
    await backfillTick(app); // automatic revalidation of the old ended request
    const fixed=historyScan(app,"oc_history")!;
    expect(fixed).toMatchObject({phase:"main",token:"next",target:input.target});
    expect(one(app.db,"select backfill_ingest from lark_cursors where chat_id='oc_history'")).toEqual({backfill_ingest:0});
    // The original tree predates main's chat_ids/files schema; verify its shared internal entry here.
    requestBackfill(app,"oc_history",0,true);
    expect(historyScan(app,"oc_history")).toEqual(fixed);
    expect(all(app.db,"select chat_id,backfill_to_ms from lark_cursors order by chat_id")).toEqual(queued);
    expect(one(app.db,"select backfill_ingest from lark_cursors where chat_id='oc_history'")).toEqual({backfill_ingest:1});
    setLarkCliForTests(async args=>{
      if(args[0]==="auth") return {data:{identities:{user:{openId:"ou_owner"}}}};
      if(args[1]==="+messages-search") return {data:{messages:[],has_more:false}};
      if(args[1]==="+chat-messages-list") {
        if(args[args.indexOf("--chat-id")+1]!=="oc_history") return {data:{messages:[],has_more:true,page_token:"other-next"}};
        expect(args[args.indexOf("--page-token")+1]).toBe("next");
        expect(Date.parse(args[args.indexOf("--end")+1])).toBe(Math.ceil(fixed.end/1000)*1000+1000);
        return {data:{messages:[msg("om_tail",at-1000)],has_more:false}};
      }
      return {data:{}};
    });
    // Normal fair scheduling visits the other 39 requests, then resumes the fixed active window.
    for(let round=0;round<40 && backfillStatus(app,"oc_history").pending;round++) await backfillTick(app);
    expect(backfillStatus(app,"oc_history").pending).toBe(false);
    const runs=all<{input:string}>(app.db,"select input from runs where kind='ingest'");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0].input).sourceIds).toContain(historyScan(app,"oc_history")!.touched[0]);
    expect(all(app.db,"select chat_id,backfill_to_ms from lark_cursors order by chat_id")).toEqual(queued);
  });

  it("keeps a permanent attachment denial observable and incomplete across attempts",async()=>{
    const {app,input}=setup();
    app.config.lark.capture.attachments=true;
    setLarkCliForTests(async()=>({data:{messages:[{...msg("om_denied"),resources:[{key:"img_denied",type:"image",error:true}]}],has_more:false}}));
    for(let attempt=0;attempt<3;attempt++) {
      await expect(historyPage(app,input)).rejects.toThrow("附件下载未完成");
      expect(backfillStatus(app,"oc_history").pending).toBe(true);
      expect(historyScan(app,"oc_history")).toMatchObject({phase:"main",error:expect.stringContaining("附件下载未完成")});
      expect(historyScan(app,"oc_history")?.evidence).toBeUndefined();
    }
    expect(all(app.db,"select 1 from lark_messages where message_id='om_denied'")).toHaveLength(1);
  });

});

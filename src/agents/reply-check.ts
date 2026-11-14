import { one } from "../core/db.ts";
import { mayStayQuiet, quietReason } from "./quiet.ts";
import { replyProblem, reviseNote, type ReplyContext } from "./reply-quality.ts";
import { getRun, setRunOutput, type RunContext } from "./runs.ts";

/** Tools that arrange for the turn to come back: after one of them “我去看看” is a true statement. */
const FOLLOW_UP = ["wake_later", "wake_on_message", "delegate_code", "continue_code_run", "review_branch", "fix_review", "run_agent", "continue_agent_work", "ask_agent", "ask_user", "generate_wiki", "digest_sources", "split_requirements"];

function turnContext(ctx: Pick<RunContext, "app" | "run">): ReplyContext {
  const { app, run } = ctx;
  const acted = !!one(app.db, "select 1 from run_events where run_id = ? and type = 'tool-write' limit 1", run.id);
  const followUp = !!one(app.db, `select 1 from run_events where run_id = ? and type = 'tool-write' and json_extract(data, '$.name') in (${FOLLOW_UP.map(() => "?").join(",")}) limit 1`, run.id, ...FOLLOW_UP);
  return { acted, followUp };
}

/**
 * Before a turn's reply is posted: one that says nothing (reply-quality.ts) goes back to the agent
 * once, with what is wrong and what to do instead. What it writes then is sent, whatever it is, except
 * an internal marker, which is never a reply: where nobody waits on the turn that counts as staying
 * quiet. `rerun` gives the agent one more turn in the same session and returns its reply.
 */
export async function reviseHollow(ctx: Pick<RunContext, "app" | "run" | "event">, draft: string, rerun: (prompt: string) => Promise<string>): Promise<string> {
  const { app } = ctx;
  const runId = ctx.run.id;
  if (!app.config.replies.check || quietReason(app, runId)) return draft;
  const problem = replyProblem(draft, turnContext(ctx));
  if (!problem) return draft;
  let quietAllowed = false;
  try { quietAllowed = mayStayQuiet(app, getRun(app, runId)); } catch { /* the run is gone: nothing to post anyway */ }
  ctx.event("status", { text: `回复先不发，退回重写一次：${problem.why}` });
  let next = "";
  try {
    next = (await rerun(reviseNote(problem, quietAllowed))).trim();
  } catch (e) {
    ctx.event("status", { text: `重写这条回复时出错（${(e as Error).message}），按原样处理` });
  }
  const wentQuiet = !!quietReason(app, runId);
  const still = next ? replyProblem(next, turnContext(ctx)) : problem;
  const marker = (next ? still?.kind : problem.kind) === "marker";
  setRunOutput(app, runId, { replyCheck: { kind: problem.kind, revised: !!next && !still, quiet: wentQuiet } });
  if (wentQuiet) return next || draft;
  if (marker) {
    // A marker is never sent. Nobody waiting: the same as staying quiet. Somebody waiting: say that no answer came.
    if (quietAllowed) {
      setRunOutput(app, runId, { stayQuiet: "回复只有一个表示不说话的标记" });
      return next || draft;
    }
    return "（这一轮没有给出回答）";
  }
  return next || draft;
}

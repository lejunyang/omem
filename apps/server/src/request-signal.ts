import type {FastifyRequest,FastifyReply} from "fastify";

const signals=new WeakMap<FastifyRequest,AbortSignal>();
/** Stop long retrieval work when its HTTP reader disconnects. Normal response
 * completion removes listeners without aborting completed work. */
export function requestSignal(request:FastifyRequest,reply:FastifyReply){
  const existing=signals.get(request);if(existing)return existing;
  const controller=new AbortController();signals.set(request,controller.signal);
  const abort=()=>controller.abort(new Error("Search request disconnected"));
  const close=()=>{if(!reply.raw.writableFinished)abort();clean();};
  const clean=()=>{request.raw.off("aborted",abort);reply.raw.off("close",close);reply.raw.off("finish",clean);};
  request.raw.once("aborted",abort);reply.raw.once("close",close);reply.raw.once("finish",clean);
  if(request.raw.aborted||reply.raw.destroyed)abort();
  return controller.signal;
}

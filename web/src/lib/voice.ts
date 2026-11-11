import { get, post } from "../api";

/**
 * Talking with a voice model in the browser (core/voice.ts on the server). Both APIs run over
 * WebRTC — the microphone as an audio track, the model's voice as the remote track, JSON events on
 * the `oai-events` data channel — but they connect and report differently:
 *
 * - Realtime: omem hands out a client secret, the browser posts its SDP offer to OpenAI with it.
 *   Your words arrive whole (`conversation.item.input_audio_transcription.completed`), the model's as
 *   deltas of its audio transcript; a tool call is `response.function_call_arguments.done`, answered
 *   with a `function_call_output` item and `response.create`.
 * - GPT-Live: the browser posts its SDP offer to omem, which opens the session with the key. Both
 *   sides stream as `session.input_transcript.delta` / `session.output_transcript.delta` (no "done":
 *   a turn ends when the other side starts); tool calls come from the delegated Responses model inside
 *   `response.event`, answered with `response.item.create` and `response.create`.
 *
 * Tools run on omem (`/api/voice/tool`), in the spaces the user can read. A plugin page's conversation
 * (`plugin`: views/Plugin.vue runs it for the page in its sandboxed frame) goes through the plugin's
 * own routes with the plugin's instructions and has no tools.
 */
export type VoiceTurn = { role: "user" | "assistant"; text: string; final: boolean };
export type VoiceState = "connecting" | "live" | "ended" | "failed";
export type VoiceStatus = { ready: boolean; detail: string; api: "live" | "realtime"; model: string | null };
export type VoiceHandle = { stop(): void; mute(on: boolean): void; transcript: () => VoiceTurn[]; api: string; model: string; startedAt: string };

export const voiceStatus = () => get<VoiceStatus>("/api/voice");

export async function startVoice(o: {
  space?: string;
  /** A plugin page's conversation: its routes and instructions, no tools. */
  plugin?: { id: string; instructions: string };
  onTurns(turns: VoiceTurn[]): void;
  onState(s: VoiceState, detail?: string): void;
  onTool?(name: string, phase: "start" | "end"): void;
}): Promise<VoiceHandle> {
  const base = o.plugin ? `/api/plugins/${o.plugin.id}/voice` : "/api/voice";
  const extra = o.plugin ? { instructions: o.plugin.instructions } : {};
  const status = await get<VoiceStatus>(base);
  if (!status.ready) throw new Error(status.detail);
  o.onState("connecting");
  const turns: VoiceTurn[] = [];
  const emit = () => o.onTurns(turns.map((t) => ({ ...t })));
  /** Add text to the current turn of `role`, or start one when the other side spoke last. */
  const append = (role: VoiceTurn["role"], delta: string, final = false) => {
    let last = turns.at(-1);
    if (!last || last.role !== role || last.final) {
      if (last && !last.final) last.final = true;
      last = { role, text: "", final: false };
      turns.push(last);
    }
    last.text += delta;
    if (final) last.final = true;
    emit();
  };
  /** A whole utterance (Realtime's user transcript arrives after the model may have started answering). */
  const place = (role: VoiceTurn["role"], text: string) => {
    const open = turns.findLastIndex((t) => !t.final && t.role !== role);
    const turn = { role, text, final: true };
    if (open >= 0) turns.splice(open, 0, turn);
    else turns.push(turn);
    emit();
  };

  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new Error(`打不开麦克风（${(e as Error).message}）：在浏览器地址栏允许这个网站使用麦克风`);
  }
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0];
  };
  for (const t of mic.getTracks()) pc.addTrack(t, mic);
  const dc = pc.createDataChannel("oai-events");
  dc.onopen = () => o.onState("live");
  const send = (ev: Record<string, unknown>) => dc.readyState === "open" && dc.send(JSON.stringify(ev));

  const runTool = async (name: string, argsJson: string) => {
    if (o.plugin) return `这次对话不能用工具 ${name}`;
    o.onTool?.(name, "start");
    let args: unknown = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {}
    try {
      const r = await post<{ text: string; isError: boolean }>("/api/voice/tool", { name, args, space: o.space });
      return r.text.slice(0, 12_000);
    } catch (e) {
      return `工具出错：${(e as Error).message}`;
    } finally {
      o.onTool?.(name, "end");
    }
  };

  let ended = false;
  const startedAt = new Date().toISOString();
  const stop = () => {
    if (ended) return;
    ended = true;
    if (status.api === "live") send({ type: "session.close" });
    for (const t of mic.getTracks()) t.stop();
    dc.close();
    pc.close();
    audio.srcObject = null;
    for (const t of turns) t.final = true;
    emit();
    o.onState("ended");
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      o.onState("failed", "连接断开了");
      stop();
    }
  };

  dc.onmessage = async (m) => {
    let ev: any;
    try {
      ev = JSON.parse(m.data);
    } catch {
      return;
    }
    if (ev.type === "error") o.onState("live", ev.error?.message ?? ev.message ?? "语音模型报错");
    if (status.api === "realtime") {
      if (ev.type === "conversation.item.input_audio_transcription.completed") place("user", String(ev.transcript ?? ""));
      else if (ev.type === "response.output_audio_transcript.delta" || ev.type === "response.output_text.delta") append("assistant", String(ev.delta ?? ""));
      else if (ev.type === "response.output_audio_transcript.done" || ev.type === "response.output_text.done") {
        const last = turns.at(-1);
        if (last?.role === "assistant") (last.final = true), emit();
      } else if (ev.type === "response.function_call_arguments.done") {
        const output = await runTool(ev.name, ev.arguments);
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output } });
        send({ type: "response.create" });
      }
    } else {
      if (ev.type === "session.input_transcript.delta") append("user", String(ev.delta ?? ""));
      else if (ev.type === "session.output_transcript.delta") append("assistant", String(ev.delta ?? ""));
      else if (ev.type === "session.closed") stop();
      else if (ev.type === "response.event" && ev.event?.type === "response.output_item.done" && ev.event.item?.type === "function_call") {
        const item = ev.event.item;
        const output = await runTool(item.name, item.arguments);
        send({ type: "response.item.create", item: { type: "function_call_output", call_id: item.call_id, output } });
        send({ type: "response.create" });
      }
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let answer: string;
    let model = status.model ?? "";
    if (status.api === "realtime") {
      const s = await post<{ secret: string; callsUrl: string; model: string }>(`${base}/realtime/secret`, extra);
      model = s.model;
      const r = await fetch(s.callsUrl, { method: "POST", body: offer.sdp, headers: { authorization: `Bearer ${s.secret}`, "content-type": "application/sdp" } });
      if (!r.ok) throw new Error(`连接语音模型失败：${r.status} ${(await r.text()).slice(0, 200)}`);
      answer = await r.text();
    } else {
      const s = await post<{ sdp: string; model: string }>(`${base}/live/sdp`, { ...extra, sdp: offer.sdp });
      model = s.model;
      answer = s.sdp;
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    return {
      stop,
      mute: (on) => mic.getAudioTracks().forEach((t) => (t.enabled = !on)),
      transcript: () => turns.map((t) => ({ ...t })),
      api: status.api,
      model,
      startedAt,
    };
  } catch (e) {
    stop();
    o.onState("failed", (e as Error).message);
    throw e;
  }
}

/** Save a finished conversation with the assistant (a plugin keeps its own). */
export const saveVoice = (h: VoiceHandle) =>
  post<{ id: string }>("/api/voice/sessions", {
    api: h.api,
    model: h.model,
    startedAt: h.startedAt,
    transcript: h.transcript().map(({ role, text }) => ({ role, text })),
  });

/**
 * Hold-to-talk for a text box: record with MediaRecorder, then `/api/voice/transcribe`.
 * Returns a stop function that resolves to the text.
 */
export async function recordSpeech(): Promise<{ stop(): Promise<string>; cancel(): void }> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const rec = new MediaRecorder(mic, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  const done = () => new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    if (rec.state !== "inactive") rec.stop();
    else resolve();
  });
  const release = () => mic.getTracks().forEach((t) => t.stop());
  return {
    async stop() {
      await done();
      release();
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      if (!blob.size) return "";
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await post<{ text: string }>("/api/voice/transcribe", { audio: btoa(bin), mime: blob.type });
      return r.text;
    },
    cancel() {
      void done().then(release);
    },
  };
}

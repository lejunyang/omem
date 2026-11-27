import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "./app.ts";
import { baseOf, categoryStatus, keyOf } from "./ai-keys.ts";
import { HttpError, sha256 } from "./util.ts";
import { estimatedAiTokens, MINUTE_LIMIT_EXHAUSTED, requestWithAiLimit, settleAiUsage } from "./ai-request.ts";

/**
 * Image generation (settings → AI → 图片生成, docs/v2/ai-models.md): OpenAI's Images API,
 * `POST {base}/images/generations` → `data[0].b64_json`. The picture is kept like any stored file
 * (files/<sha16>.png, served at /api/files/<name>), so it can go into a Wiki page or be sent to
 * Feishu with lark_send_file.
 */
export type GeneratedImage = { name: string; path: string; url: string; bytes: number; model: string; revisedPrompt?: string };

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
export function setImageFetchForTests(f: Fetch | null) {
  fetcher = f ?? ((...a) => fetch(...a));
}

export function imageReady(app: App) {
  return categoryStatus(app.config, "image", app.home).ready;
}

export async function generateImage(app: App, o: { prompt: string; size?: string; quality?: string; background?: string; signal?: AbortSignal }): Promise<GeneratedImage> {
  const st = categoryStatus(app.config, "image", app.home);
  if (!st.ready) throw new HttpError(409, `图片生成模型不可用：${st.detail}（设置 → 后端与模型 → 图片生成）`);
  const p = app.config.ai.providers.find((x) => x.id === st.provider)!;
  const cfg = app.config.ai.image;
  const size = o.size || cfg.size;
  const quality = o.quality || cfg.quality;
  const body = { model: st.model, prompt: o.prompt, n: 1, ...(size ? { size } : {}), ...(quality ? { quality } : {}), ...(o.background ? { background: o.background } : {}), output_format: "png" };
  const deadline = Date.now() + 180_000;
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(o.signal ? [o.signal] : [])]);
  const encoded = JSON.stringify(body);
  const { response: r, errorText, settle, minuteRetriesExhausted } = await requestWithAiLimit(app, p, st.model!, () => estimatedAiTokens(encoded, body, 0), { signal, deadline },
    () => fetcher(`${baseOf(p)}/images/generations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${keyOf(p.id, app.home)}` }, body: encoded, signal }));
  const text = errorText ?? await r.text();
  if (!r.ok) throw new HttpError(502, `图片模型返回 ${r.status}：${text.slice(0, 300)}${minuteRetriesExhausted ? ` ${MINUTE_LIMIT_EXHAUSTED}` : ""}`);
  let data: { data?: { b64_json?: string; revised_prompt?: string }[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, `图片模型返回的不是 JSON：${text.slice(0, 200)}`);
  }
  settleAiUsage(settle, data);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new HttpError(502, "图片模型没有返回图片");
  const buf = Buffer.from(b64, "base64");
  const name = `${sha256(buf).slice(0, 16)}.png`;
  mkdirSync(app.filesDir, { recursive: true });
  const path = join(app.filesDir, name);
  writeFileSync(path, buf);
  return { name, path, url: `/api/files/${name}`, bytes: buf.length, model: st.model!, ...(data.data?.[0]?.revised_prompt ? { revisedPrompt: data.data[0].revised_prompt } : {}) };
}

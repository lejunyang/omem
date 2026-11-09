// 页面桥：ISOLATED world 内容脚本，和页面钩子成对注册（只在已授权站点）。
// 读 storage 里的 Mock 规则交给钩子；规则变了重发；把「JS 修改响应」和「已 Mock」转给后台。
import { normalizeMockGroups, normalizeMockRules, MOCK_GROUP_STORAGE_KEY, MOCK_RULE_STORAGE_KEY } from "../shared/mock-rules";
import {
  HOOK_EVENT_MOCKED,
  HOOK_EVENT_READY,
  HOOK_EVENT_RULES,
  HOOK_EVENT_SCRIPT,
  HOOK_EVENT_SCRIPT_RESULT,
  type HookRulesPayload
} from "../shared/page-hook-protocol";

let payload: string | null = null;

async function loadRules(): Promise<void> {
  const items = await chrome.storage.local.get([MOCK_RULE_STORAGE_KEY, MOCK_GROUP_STORAGE_KEY]);
  const groups = normalizeMockGroups(items[MOCK_GROUP_STORAGE_KEY]);
  const enabledGroups = new Set(groups.filter((group) => group.enabled).map((group) => group.id));
  const rules = normalizeMockRules(items[MOCK_RULE_STORAGE_KEY]).filter((rule) => rule.enabled && enabledGroups.has(rule.groupId));
  const next: HookRulesPayload = { rules, groups, scriptBridge: true };
  payload = JSON.stringify(next);
  push();
}

function push(): void {
  if (payload) document.dispatchEvent(new CustomEvent(HOOK_EVENT_RULES, { detail: payload }));
}

// 两段脚本都在 document_start，但先后不保证：钩子先到时它发 ready，桥收到后补发规则。
document.addEventListener(HOOK_EVENT_READY, push);

document.addEventListener(HOOK_EVENT_MOCKED, (event) => {
  const detail = (event as CustomEvent).detail;
  if (typeof detail !== "string") return;
  try {
    const { method, url } = JSON.parse(detail) as { method: string; url: string };
    void chrome.runtime.sendMessage({ type: "advanced-network:hook-mocked", method, url }).catch(() => undefined);
  } catch {
    // 忽略页面伪造的坏数据。
  }
});

document.addEventListener(HOOK_EVENT_SCRIPT, (event) => {
  const detail = (event as CustomEvent).detail;
  if (typeof detail !== "string") return;
  let request: { id: string; ruleId: string; input: unknown };
  try {
    request = JSON.parse(detail);
  } catch {
    return;
  }
  const reply = (body: unknown) => document.dispatchEvent(new CustomEvent(HOOK_EVENT_SCRIPT_RESULT, { detail: JSON.stringify(body) }));
  // 只转发规则 id：脚本内容由后台从 storage 读取，页面不能借这条路在沙箱里跑任意代码。
  chrome.runtime
    .sendMessage({ type: "advanced-network:hook-run-script", ruleId: request.ruleId, input: request.input })
    .then((response: { ok?: boolean; result?: unknown; error?: string } | undefined) =>
      reply({ id: request.id, ok: Boolean(response?.ok), result: response?.result, error: response?.error })
    )
    .catch((error: unknown) => reply({ id: request.id, ok: false, error: String(error) }));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (MOCK_RULE_STORAGE_KEY in changes || MOCK_GROUP_STORAGE_KEY in changes)) void loadRules();
});

void loadRules();

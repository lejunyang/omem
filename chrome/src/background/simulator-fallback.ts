import { normalizeDeviceProfile, toUserAgentOverrideParams } from "../shared/device-emulation";

// 居中模拟器的「不用 CDP」实现：只作用于模拟器自己的标签页（tabIds 条件），用 declarativeNetRequest 会话规则
// 1) 给这个标签页的所有请求换 User-Agent；2) 去掉子 frame 文档上禁止嵌入的响应头。
// DNR 不能只删 CSP 里的 frame-ancestors 一项，只能整条去掉 CSP；只影响模拟器里的内页，原标签页不受影响。
// 改请求头需要目标站点的访问权限，界面在打开前申请。

const RULE_ID_BASE = 4_000_000;

/** 每个标签页两条规则，id 由 tabId 推出，重复配置时先删后加。 */
export function simulatorRuleIds(tabId: number): [number, number] {
  const base = RULE_ID_BASE + (tabId % 1_000_000) * 2;
  return [base, base + 1];
}

export function buildSimulatorRules(tabId: number, userAgent: string): chrome.declarativeNetRequest.Rule[] {
  const [uaRuleId, frameRuleId] = simulatorRuleIds(tabId);
  const rules: chrome.declarativeNetRequest.Rule[] = [
    {
      id: frameRuleId,
      priority: 1,
      condition: { tabIds: [tabId], resourceTypes: ["sub_frame" as chrome.declarativeNetRequest.ResourceType] },
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        responseHeaders: [
          { header: "x-frame-options", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
          { header: "content-security-policy", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation }
        ]
      }
    }
  ];
  if (userAgent) {
    rules.push({
      id: uaRuleId,
      priority: 1,
      condition: { tabIds: [tabId] },
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{ header: "user-agent", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: userAgent }]
      }
    });
  }
  return rules;
}

export async function configureSimulatorFallback(sender: chrome.runtime.MessageSender, profileInput: unknown): Promise<{ ok: true; mode: "dnr" }> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number" || sender.url?.split("?")[0] !== chrome.runtime.getURL("simulator.html")) {
    throw new Error("只能在设备模拟器页面中应用此设置。");
  }
  const profile = normalizeDeviceProfile(profileInput);
  if (!profile) throw new Error("设备配置无效。");
  const { userAgent } = toUserAgentOverrideParams(profile);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: simulatorRuleIds(tabId),
    addRules: buildSimulatorRules(tabId, userAgent)
  });
  return { ok: true, mode: "dnr" };
}

export async function clearSimulatorFallback(tabId: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: simulatorRuleIds(tabId) }).catch(() => undefined);
}

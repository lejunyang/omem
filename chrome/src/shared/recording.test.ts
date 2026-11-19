import { describe, expect, it } from "vitest";
import { harToRequest } from "../panel/recording-bridge";
import {
  BODY_LIMIT,
  clipBody,
  devtoolsType,
  findPartner,
  isSensitiveField,
  MAX_UPLOAD_IMAGES,
  mergeRequests,
  mergesWith,
  planUpload,
  redactBody,
  redactHeaders,
  redactUrl,
  type RecordedRequest,
  type RecordedStep,
  type RecordingSession,
  stepTitle,
  webRequestType,
  wantsBody
} from "./recording";

const request = (patch: Partial<RecordedRequest>): RecordedRequest => ({ id: "r", tabId: 1, at: 1000, method: "GET", url: "https://a.test/api/x", type: "XHR", source: "webRequest", ...patch });
const step = (patch: Partial<RecordedStep>): RecordedStep => ({ id: "s", at: 1000, tabId: 1, kind: "action", action: { kind: "click", label: "开通" }, ...patch });
const session: RecordingSession = { id: "x", goal: "开通退款", tabIds: [1], startedAt: 0, status: "stopped", startUrl: "https://a.test/", startTitle: "后台" };

describe("isSensitiveField", () => {
  it("同 aad：密码、文件、隐藏输入框不记值", () => {
    expect(isSensitiveField({ type: "password" })).toBe(true);
    expect(isSensitiveField({ type: "hidden" })).toBe(true);
    expect(isSensitiveField({ type: "text", label: "商户号" })).toBe(false);
  });

  it("autocomplete 和名字看起来是密码、验证码、卡号的也不记", () => {
    expect(isSensitiveField({ type: "text", autocomplete: "one-time-code" })).toBe(true);
    expect(isSensitiveField({ type: "text", autocomplete: "section-pay cc-number" })).toBe(true);
    expect(isSensitiveField({ type: "text", name: "api_key" })).toBe(true);
    expect(isSensitiveField({ type: "text", label: "短信验证码" })).toBe(true);
    expect(isSensitiveField({ type: "text", placeholder: "请输入登录密码" })).toBe(true);
    expect(isSensitiveField({ type: "text", id: "user_pwd" })).toBe(true);
    expect(isSensitiveField({ type: "email", autocomplete: "email", label: "邮箱" })).toBe(false);
  });
});

describe("遮盖", () => {
  it("地址：去掉账号密码和密钥参数，片段只留前端路由", () => {
    expect(redactUrl("https://u:p@a.test/cb?code=xyz&q=1#frag")).toBe("https://a.test/cb?code=%5BREDACTED%5D&q=1");
    expect(redactUrl("https://a.test/app#/orders/7?access_token=t")).toBe("https://a.test/app#/orders/7");
    expect(redactUrl("https://a.test/login#access_token=t")).toBe("https://a.test/login");
    const once = redactUrl("https://a.test/x?token=t&page=2");
    expect(redactUrl(once)).toBe(once);
    expect(redactUrl("不是地址")).toBe("[REDACTED URL]");
  });

  it("请求头：authorization、cookie、带 token 的换成占位", () => {
    expect(redactHeaders([{ name: "Authorization", value: "Bearer x" }, { name: "Cookie", value: "sid=1" }, { name: "X-CSRF-Token", value: "t" }, { name: "Content-Type", value: "application/json" }])).toEqual({
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      "X-CSRF-Token": "[REDACTED]",
      "Content-Type": "application/json"
    });
    expect(redactHeaders([])).toBeUndefined();
  });

  it("请求体：JSON 和表单留下不敏感的部分，别的整个不要；再遮一次不变", () => {
    expect(redactBody('{"merchant":"B-1001","password":"p","nested":[{"refresh_token":"r"}]}')).toBe('{"merchant":"B-1001","password":"[REDACTED]","nested":[{"refresh_token":"[REDACTED]"}]}');
    expect(redactBody("user=wang&pwd=123")).toBe("user=wang&pwd=[REDACTED]");
    expect(redactBody(redactBody("user=wang&pwd=123"))).toBe("user=wang&pwd=[REDACTED]");
    expect(redactBody("<html>…</html>")).toBe("[REDACTED OPAQUE BODY]");
    expect(redactBody("")).toBeUndefined();
  });

  it("先遮盖再截断，截断时标出来", () => {
    const long = JSON.stringify({ list: "x".repeat(BODY_LIMIT + 10), token: "t" });
    const clipped = clipBody(long);
    expect(clipped.truncated).toBe(true);
    expect(clipped.body).toHaveLength(BODY_LIMIT);
    expect(clipped.body).not.toContain('"token":"t"');
  });
});

describe("请求的类型", () => {
  it("webRequest 和 DevTools 的类型换成 CDP 的说法（omem 按它分出静态资源和埋点）", () => {
    expect(webRequestType("xmlhttprequest")).toBe("XHR");
    expect(webRequestType("main_frame")).toBe("Document");
    expect(webRequestType("ping")).toBe("Ping");
    expect(webRequestType("whatever")).toBe("Other");
    expect(devtoolsType("fetch")).toBe("Fetch");
    expect(devtoolsType("preflight")).toBe("Preflight");
    expect(devtoolsType(undefined)).toBe("Other");
  });

  it("只读接口和文档的文字响应体", () => {
    expect(wantsBody("XHR", "application/json")).toBe(true);
    expect(wantsBody("Document", "text/html")).toBe(true);
    expect(wantsBody("Script", "application/javascript")).toBe(false);
    expect(wantsBody("Fetch", "image/png")).toBe(false);
  });
});

describe("webRequest 和 DevTools 记录的合并", () => {
  it("后到的找先到的：方法、地址、标签页相同，开始时间差 3 秒内，来源不同", () => {
    const web = request({ id: "wr-1", at: 1000, status: 200, requestHeaders: { a: "1" } });
    const dev = request({ id: "dt-1", at: 1004, source: "devtools", responseBody: '{"ok":true}', type: "Fetch" });
    expect(findPartner([web], dev)).toBe(web);
    expect(findPartner([web], { ...dev, at: 5000 })).toBeUndefined();
    expect(findPartner([web], { ...dev, method: "POST" })).toBeUndefined();
    expect(findPartner([web], { ...dev, tabId: 2 })).toBeUndefined();
    // 哪边先到都一样：保留先到的 id，类型和请求头以 webRequest 为准，补上响应体
    for (const merged of [mergeRequests(web, dev), mergeRequests(dev, web)]) {
      expect(merged).toMatchObject({ type: "XHR", status: 200, requestHeaders: { a: "1" }, responseBody: '{"ok":true}', source: "devtools" });
    }
    expect(mergeRequests(web, dev).id).toBe("wr-1");
    expect(mergeRequests(dev, web).id).toBe("dt-1");
    // 已经有响应体的不再合并第二条 DevTools 记录
    expect(findPartner([mergeRequests(web, dev)], { ...dev, id: "dt-2" })).toBeUndefined();
  });

  it("DevTools 的 HAR 换成录制的请求：遮盖地址、请求头和请求体", () => {
    const record = harToRequest(
      {
        startedDateTime: "2026-11-20T08:00:00.000Z",
        time: 85.4,
        _resourceType: "fetch",
        request: { method: "post", url: "https://a.test/api/grant?token=t", headers: [{ name: "Authorization", value: "Bearer x" }], postData: { text: '{"merchant":"B-1001","otp":"1234"}' } },
        response: { status: 200, content: { mimeType: "application/json" } }
      },
      7
    );
    expect(record).toMatchObject({
      tabId: 7,
      at: Date.parse("2026-11-20T08:00:00.000Z"),
      method: "POST",
      url: "https://a.test/api/grant?token=%5BREDACTED%5D",
      type: "Fetch",
      status: 200,
      durationMs: 85,
      requestHeaders: { Authorization: "[REDACTED]" },
      requestBody: '{"merchant":"B-1001","otp":"[REDACTED]"}',
      source: "devtools"
    });
  });
});

describe("步骤", () => {
  it("连续在同一个输入框里打字只算一步", () => {
    const typed = step({ action: { kind: "input", label: "商户号", selector: "input#m", value: "B-1" } });
    expect(mergesWith(typed, { at: 2000, tabId: 1, kind: "action", action: { kind: "input", label: "商户号", selector: "input#m", value: "B-1001" } })).toBe(true);
    expect(mergesWith(typed, { at: 2000, tabId: 1, kind: "action", action: { kind: "input", label: "金额", selector: "input#a", value: "3" } })).toBe(false);
    expect(mergesWith(typed, { at: 2000, tabId: 1, kind: "action", action: { kind: "click", label: "开通" } })).toBe(false);
    expect(mergesWith(undefined, { at: 2000, tabId: 1, kind: "action", action: { kind: "input", label: "商户号" } })).toBe(false);
  });

  it("侧栏里的说法和 omem 读录制时一致", () => {
    expect(stepTitle(step({}))).toBe("点击「开通」");
    expect(stepTitle(step({ action: { kind: "input", label: "密码", protected: true, value: null } }))).toBe("填写「密码」（受保护，不记内容）");
    expect(stepTitle(step({ action: { kind: "navigate", url: "https://a.test/x", title: "商户详情" } }))).toBe("打开页面「商户详情」");
    expect(stepTitle(step({ kind: "mark", action: { kind: "mark", label: "可退金额", note: "这里看的是还能退多少" } }))).toBe("标记「可退金额」：这里看的是还能退多少");
  });
});

describe("planUpload", () => {
  it("步骤按时间排，请求去掉本地 id，标签页写成 tab", () => {
    const plan = planUpload(session, [step({ id: "b", at: 2000 }), step({ id: "a", at: 1000, screenshot: "a" })], [request({ id: "wr-1", tabId: 3 })]);
    expect(plan.body.steps.map((s) => s.at)).toEqual([1000, 2000]);
    expect(plan.body.steps[0].screenshot).toBe("a");
    expect(plan.body.network[0]).toMatchObject({ tab: 3, method: "GET" });
    expect(plan.body.network[0]).not.toHaveProperty("id");
    expect(plan.imageKeys).toEqual(["a"]);
  });

  it("截图最多 80 张：标记的都留，其余按时间均匀挑", () => {
    const steps = Array.from({ length: 200 }, (_, i) => step({ id: `s${i}`, at: i, screenshot: `s${i}`, kind: i % 50 === 0 ? "mark" : "action" }));
    const plan = planUpload(session, steps, []);
    expect(plan.imageKeys).toHaveLength(MAX_UPLOAD_IMAGES);
    for (const key of ["s0", "s50", "s100", "s150"]) expect(plan.imageKeys).toContain(key);
    // 没挑上的步骤不带截图键（omem 只收带键的截图）
    expect(plan.body.steps.filter((s) => s.screenshot)).toHaveLength(MAX_UPLOAD_IMAGES);
  });

  it("请求太多时先丢静态资源", () => {
    const many = [...Array.from({ length: 4990 }, (_, i) => request({ id: `x${i}`, at: i })), ...Array.from({ length: 20 }, (_, i) => request({ id: `img${i}`, at: 10 + i, type: "Image" }))];
    const plan = planUpload(session, [], many);
    expect(plan.body.network).toHaveLength(5000);
    expect(plan.body.network.filter((r) => r.type === "Image")).toHaveLength(10);
  });
});

import { get, type Def, type WhoInput } from "./engine.ts";

/**
 * Platforms Nango's catalog does not have, written from each platform's published documents.
 * WeChat, QQ and Weibo only say who someone is; the others also give content to read. Their
 * callback domain must be registered with the platform (WeChat and QQ require an ICP-filed domain).
 */
const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const person = (externalId: unknown, name: unknown, avatar?: unknown, email?: unknown) => {
  const id = s(externalId);
  if (!id) throw Object.assign(new Error("平台没有返回账号 id"), { statusCode: 400 });
  return { externalId: id, name: s(name) || id, avatar: s(avatar) || null, email: s(email) || null };
};

export const CHINA: Def[] = [
  {
    id: "wechat",
    label: "微信",
    group: "社交媒体",
    docs: "https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html",
    mode: "oauth2",
    config: [],
    authUrl: "https://open.weixin.qq.com/connect/qrconnect",
    authFragment: "wechat_redirect",
    tokenUrl: "https://api.weixin.qq.com/sns/oauth2/access_token",
    refreshUrl: "https://api.weixin.qq.com/sns/oauth2/refresh_token",
    tokenMethod: "GET",
    pkce: false,
    defaultScopes: ["snsapi_login"],
    authNames: { client_id: "appid" },
    names: { client_id: "appid", client_secret: "secret", redirect_uri: null },
    base: "https://api.weixin.qq.com",
    query: { access_token: "${accessToken}" },
    who: {
      get: async (w: WhoInput) => {
        const j = await w.call(`https://api.weixin.qq.com/sns/userinfo?openid=${encodeURIComponent(s(w.raw.openid))}`);
        // unionid is the same across the apps under one WeChat Open Platform account; openid is per app.
        return person(j.unionid || w.raw.unionid || j.openid || w.raw.openid, j.nickname, j.headimgurl);
      },
    },
  },
  {
    id: "qq",
    label: "QQ",
    group: "社交媒体",
    docs: "https://wiki.connect.qq.com/",
    mode: "oauth2",
    config: [],
    authUrl: "https://graph.qq.com/oauth2.0/authorize",
    tokenUrl: "https://graph.qq.com/oauth2.0/token",
    tokenMethod: "GET",
    tokenParams: { fmt: "json", need_openid: "1" },
    refreshParams: { fmt: "json" },
    pkce: false,
    defaultScopes: ["get_user_info"],
    base: "https://graph.qq.com",
    query: { access_token: "${accessToken}" },
    who: {
      get: async (w: WhoInput) => {
        const me = await w.call("https://graph.qq.com/oauth2.0/me?unionid=1&fmt=json");
        const openid = s(me.openid);
        const info = await w.call(`https://graph.qq.com/user/get_user_info?oauth_consumer_key=${encodeURIComponent(w.cfg.clientId ?? "")}&openid=${encodeURIComponent(openid)}`).catch(() => ({}));
        return person(me.unionid || openid, info.nickname, info.figureurl_qq_2 || info.figureurl_qq_1);
      },
    },
  },
  {
    id: "weibo",
    label: "微博",
    group: "社交媒体",
    docs: "https://open.weibo.com/wiki/授权机制说明",
    mode: "oauth2",
    config: [],
    authUrl: "https://api.weibo.com/oauth2/authorize",
    tokenUrl: "https://api.weibo.com/oauth2/access_token",
    pkce: false,
    base: "https://api.weibo.com",
    query: { access_token: "${accessToken}" },
    who: {
      get: async (w: WhoInput) => {
        const uid = s(w.raw.uid);
        const j = await w.call(`https://api.weibo.com/2/users/show.json?uid=${encodeURIComponent(uid)}`).catch(() => ({}));
        return person(uid, j.screen_name, j.avatar_large);
      },
    },
  },
  {
    id: "dingtalk",
    label: "钉钉",
    group: "聊天与通讯",
    docs: "https://open.dingtalk.com/document/orgapp/tutorial-obtaining-user-personal-information",
    mode: "oauth2",
    config: [],
    authUrl: "https://login.dingtalk.com/oauth2/auth",
    authParams: { prompt: "consent" },
    tokenUrl: "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
    json: true,
    pkce: false,
    defaultScopes: ["openid"],
    names: { client_id: "clientId", client_secret: "clientSecret", grant_type: "grantType", redirect_uri: null, refresh_token: "refreshToken" },
    paths: { token: "accessToken", refresh: "refreshToken", expires: "expireIn" },
    base: "https://api.dingtalk.com",
    headers: { "x-acs-dingtalk-access-token": "${accessToken}" },
    who: { get: async (w: WhoInput) => { const j = await w.call("https://api.dingtalk.com/v1.0/contact/users/me"); return person(j.unionId, j.nick, j.avatarUrl, j.email); } },
  },
  {
    id: "douyin",
    label: "抖音",
    group: "社交媒体",
    docs: "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token",
    mode: "oauth2",
    config: [],
    authUrl: "https://open.douyin.com/platform/oauth/connect/",
    tokenUrl: "https://open.douyin.com/oauth/access_token/",
    refreshUrl: "https://open.douyin.com/oauth/refresh_token/",
    pkce: false,
    scopeSep: ",",
    defaultScopes: ["user_info"],
    authNames: { client_id: "client_key" },
    names: { client_id: "client_key" },
    paths: { token: "data.access_token", refresh: "data.refresh_token", expires: "data.expires_in", refreshExpires: "data.refresh_expires_in", scope: "data.scope" },
    base: "https://open.douyin.com",
    headers: { "access-token": "${accessToken}" },
    who: {
      get: async (w: WhoInput) => {
        const openid = s(get(w.raw, "data.open_id"));
        const j = await w.call("https://open.douyin.com/oauth/userinfo/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: w.tokens.accessToken, open_id: openid }).toString() });
        return person(get(j, "data.union_id") || openid, get(j, "data.nickname"), get(j, "data.avatar"));
      },
    },
  },
  {
    id: "gitee",
    label: "Gitee",
    group: "代码与开发",
    docs: "https://gitee.com/api/v5/swagger",
    mode: "oauth2",
    config: [],
    authUrl: "https://gitee.com/oauth/authorize",
    tokenUrl: "https://gitee.com/oauth/token",
    pkce: false,
    defaultScopes: ["user_info", "projects", "pull_requests", "issues", "notes"],
    base: "https://gitee.com/api/v5",
    query: { access_token: "${accessToken}" },
    who: { get: async (w: WhoInput) => { const j = await w.call("https://gitee.com/api/v5/user"); return person(j.id, j.name || j.login, j.avatar_url, j.email); } },
  },
  {
    id: "baidu-pan",
    label: "百度网盘",
    group: "文档与知识库",
    docs: "https://pan.baidu.com/union/doc/",
    mode: "oauth2",
    config: [],
    authUrl: "https://openapi.baidu.com/oauth/2.0/authorize",
    tokenUrl: "https://openapi.baidu.com/oauth/2.0/token",
    tokenMethod: "GET",
    pkce: false,
    scopeSep: ",",
    defaultScopes: ["basic", "netdisk"],
    base: "https://pan.baidu.com",
    query: { access_token: "${accessToken}" },
    headers: { "user-agent": "pan.baidu.com" },
  },
  {
    id: "alipan",
    label: "阿里云盘",
    group: "文档与知识库",
    docs: "https://www.yuque.com/aliyundrive/zpfszx",
    mode: "oauth2",
    config: [],
    authUrl: "https://openapi.alipan.com/oauth/authorize",
    tokenUrl: "https://openapi.alipan.com/oauth/access_token",
    json: true,
    defaultScopes: ["user:base", "file:all:read"],
    base: "https://openapi.alipan.com",
    readPost: /^\/adrive\/v1\.0\/(openFile\/(list|get|search|getDownloadUrl)|user\/getDriveInfo)/,
  },
  {
    id: "yuque",
    label: "语雀",
    group: "文档与知识库",
    docs: "https://www.yuque.com/yuque/developer/api",
    mode: "key",
    config: [{ key: "host", label: "语雀地址", optional: true, hint: "团队空间填 <空间>.yuque.com；默认 www.yuque.com" }],
    defaults: { host: "www.yuque.com" },
    base: "https://${connectionConfig.host}/api/v2",
    credentials: [{ key: "apiKey", label: "Token", secret: true, hint: "语雀 → 账户设置 → Token（个人 Token 需要会员；团队 Token 在空间设置里）" }],
    headers: { "x-auth-token": "${apiKey}" },
    verify: { path: "/user" },
  },
];

/**
 * Where HTTP rules act on this machine (`enforcedBy.http` of `GET /api/security/operation-rules`,
 * src/agents/operation-policy.ts: `browser` when aad is installed, `egress` when members' sandboxes can
 * go through the proxy), as the sentence under an HTTP rule. Before the server says (an older one, or not
 * loaded yet): the browser, as before. Pure.
 */
export function httpPlaces(points: string[] | undefined): string {
  const browser = "Agent 用 aad 操作的浏览器（页面的请求发出前先问，要带请求闸门的 aad 版本）";
  const egress = "成员沙箱的出网代理（命令行里的 curl、别的程序经它出网，见下面的“出网代理”；HTTPS 只看得到主机，要按路径判定的域名在那里另开解密）";
  const at = points ?? ["browser"];
  if (at.includes("browser") && at.includes("egress")) return `在两处生效：${browser}，和${egress}。两处都不经过的请求管不到。`;
  if (at.includes("egress")) return `在${egress}生效。这台没有装 aad，浏览器里的请求现在管不到。`;
  if (at.includes("browser")) return `在${browser}里生效。这台的出网代理用不了，命令行里的 curl、别的程序发出的请求管不到。`;
  return "这台现在没有地方执行 HTTP 规则：没有装 aad，出网代理也用不了。规则先存着，不会拦任何请求。";
}

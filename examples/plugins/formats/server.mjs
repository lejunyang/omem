export default function register(api) {
  api.sourceParser({
    id: "jsonl", label: "逐行 JSON 记录",
    match: { extensions: [".jsonl"], mimeTypes: ["application/x-ndjson"], urlPatterns: ["https://*/*.jsonl"] },
    async parse(_ctx, { bytes }) {
      const records = new TextDecoder().decode(bytes).trim().split(/\r?\n/).map(line => JSON.parse(line));
      const text = [];
      const items = [];
      for (const record of records) {
        const title = String(record.title);
        const start = text.length + 1;
        text.push(...title.split(/\r\n?|\n/), ...String(record.body).split(/\r\n?|\n/));
        items.push({ title, lines: [start, text.length] });
      }
      return { text: text.join("\n"), display: { kind: "records", items } };
    },
  });
  api.wikiPageKind({
    kind: "api-reference", label: "接口说明", describe: "说明调用一个接口需要哪些参数，以及调用后会收到什么。",
    template: "## 用途\n说明调用场景。\n## 请求\n说明参数。\n## 返回\n说明结果。",
    upkeep: { everyDays: 30, onSourcesChanged: true },
    async check(_ctx, { body }) {
      const headings = body.split("\n").map(line => line.trim());
      return ["请求", "返回"].filter(name => !headings.includes("## " + name)).map(name => ({ message: "缺少小节：" + name }));
    },
  });
}

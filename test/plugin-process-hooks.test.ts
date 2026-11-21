import { expect, it } from "vitest";
import { z } from "zod";
import { manifestSchema } from "../src/plugins/registry.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";

it("checks every process capability against its declaration", () => {
  const api = registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", permissions: { events: ["item.status"] } }), []);
  expect(() => api.subscribe({ id: "facts", events: ["item.created"], async handle() {} })).toThrow("permissions.events");
  expect(() => api.itemProvider({ id: "items", label: "事项", statuses: {}, async pull() { return { items: [], done: true }; } })).toThrow("permissions.itemProvider");
  expect(() => api.metricProvider({ id: "count", label: "计数", querySchema: z.object({}), async collect() { return []; } })).toThrow("permissions.metricProvider");
});

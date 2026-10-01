import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const schema = z.object({ rules: z.array(z.object({ prefix:z.string().min(1), weight:z.number().positive().max(1) })).default([]) });
/** Repository-specific preferences never become a global rule for personal data. */
export function loadReviewSearchPolicy(root: string) {
  const path=join(root,"config/review-search.json");
  const {rules}=schema.parse(existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{});
  rules.sort((a,b)=>b.prefix.length-a.prefix.length);
  return (path: string, query: string, category?: string) => {
    if (/测试|\btests?\b/i.test(query) && /(?:^|\/)tests?\//.test(path)) return 1;
    // An explicit category, path or historical question overrides defaults.
    if (category || /历史|调研|原型|旧版|早期|\bhistory\b|\bresearch\b|\bprototype\b/i.test(query) || query.toLowerCase().includes(path.toLowerCase())) return 1;
    return rules.find(rule=>path.startsWith(rule.prefix))?.weight ?? 1;
  };
}

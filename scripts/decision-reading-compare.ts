/** New repository questions; no evidence annotations enter inference. */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Store } from "../apps/server/src/store.js";
import { UnifiedRetrieval } from "../apps/server/src/retrieval/unified.js";
import { decodeUnit } from "../apps/server/src/retrieval/units.js";
import {
  passageState,
  passagePolicy,
} from "../apps/server/src/decision/passages.js";
import { passageQuestions } from "../apps/server/src/decision/questions.js";
import { stableDigest } from "../apps/server/src/storage/digest.js";
import type { RetrievalHit } from "../apps/server/src/retrieval/port.js";
import type { DecisionResult } from "../apps/server/src/decision/service.js";
import { beginReviewRun } from "./review-retention.js";

const root = process.cwd();
const casesPath =
  process.env.osdk_arg_cases ??
  ".repo-review/knowledge/verification/decision-reading-questions.json";
const specification = z
  .object({
    cases: z
      .array(
        z.object({
          id: z.string(),
          query: z.string(),
          path: z.string(),
          symbol: z.string().optional(),
          needle: z.string(),
        }),
      )
      .min(1),
  })
  .parse(JSON.parse(readFileSync(casesPath, "utf8")));
const directory = join(
  root,
  ".repo-review/runtime/decision-reading/comparison",
);
mkdirSync(directory, { recursive: true });
const finish = beginReviewRun(
  join(directory, "library"),
  "decision-reading-comparison",
);
const store = new Store(join(directory, "library/data")),
  retrieval = new UnifiedRetrieval(store.db);
const cohort: {
  id: string;
  questionId: string;
  role: string;
  state: ReturnType<typeof passageState>;
  inputDigest: string;
  characters: number;
}[] = [];
try {
  const paths = [...new Set(specification.cases.map((c) => c.path))];
  for (const path of paths)
    store.capture(
      {
        source: "file",
        externalId: path,
        title: path,
        context: { connector: {kind:"file",path} },
        parts: [{ type: "text", text: readFileSync(path, "utf8") }],
      },
      { learning: false, notify: false },
    );
  await retrieval.indexBatch(0);
  const units = store.db
    .prepare("SELECT * FROM retrieval_units ORDER BY owner,id")
    .all()
    .map(decodeUnit);
  for (const c of specification.cases) {
    const same = units.filter((u) => u.title === c.path);
    const useful = c.symbol
      ? same.find((u) => u.headingPath.at(-1) === c.symbol)
      : same
          .filter((u) => u.text.includes(c.needle))
          .sort((a, b) => b.text.length - a.text.length)[0];
    if (!useful?.text.includes(c.needle))
      throw Error("Registered evidence is missing: " + c.id);
    const weak = same.find(
      (u) =>
        u.id !== useful.id &&
        !u.text.includes(c.needle) &&
        u.text.length > 100 &&
        u.text.length < 5000,
    );
    const unrelated = units.find(
      (u) =>
        u.title !== c.path &&
        u.text.length > 100 &&
        u.text.length < 2000 &&
        u.title === paths.find((p) => p !== c.path),
    );
    for (const [role, unit] of [
      ["useful", useful],
      ["same-source", weak],
      ["other-source", unrelated],
    ] as const) {
      if (!unit) continue;
      const state = passageState(c.query, {
        ...unit,
        score: 1,
        routes: [],
      } as RetrievalHit);
      cohort.push({
        id: c.id + ":" + role,
        questionId: c.id,
        role,
        state,
        inputDigest: stableDigest(state),
        characters: unit.text.length,
      });
    }
  }
} finally {
  await retrieval.close();
  store.close();
  finish();
  rmSync(join(directory, "library/data"), { recursive: true, force: true });
}
const inputs = {
  questions: passageQuestions,
  budgetMs: 8000,
  warmState: {
    user_question: "这段内容是否说明如何保存设置？",
    material: "点击保存即可保留当前设置。",
  },
  items: cohort,
};
const inputPath = join(directory, "inputs.json");
writeFileSync(inputPath, JSON.stringify(inputs, null, 2));
const report: any = {
  recordedAt: new Date().toISOString(),
  questionsDigest: stableDigest(specification),
  inputDigest: stableDigest(inputs),
  method:
    "Identical native production states, sequential models, no host result cache. Warm 8000ms budget repeats exactly the same states. Same-source and other-source labels require human checking; they are not ground truth.",
  cohort: cohort.map(({ state, ...c }) => c),
  models: [],
};
for (const size of ["0.8b", "2b", "4b"]) {
  const alias =
    size === "0.8b" ? "decision-startlux08" : "decision-startlux" + size;
  const { model } = JSON.parse(
    execFileSync("osdk", ["model", "show", alias, "--json"], {
      encoding: "utf8",
    }),
  );
  const output = join(directory, size + ".json");
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(
      resolve(".osdk/runtime/decision/venv/bin/python"),
      [
        "-u",
        resolve("scripts/startlux/compare.py"),
        inputPath,
        JSON.stringify({
          size,
          alias,
          revision: model.revision,
          path: model.snapshot_path,
        }),
        output,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          PYTHONPATH: [
            resolve(".osdk/runtime/decision/upstream"),
            resolve("scripts/startlux"),
          ].join(":"),
        },
      },
    );
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  if (exitCode !== 0)
    throw Error("Native comparison process failed: " + exitCode);
  const result = JSON.parse(readFileSync(output, "utf8"));
  delete result.model.path;
  result.items = result.items.map((item: any) => ({
    ...item,
    policy: passagePolicy({ ...item, model: result.model } as DecisionResult),
  }));
  report.models.push(result);
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log("Comparison: " + join(directory, "results.json"));

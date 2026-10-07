import { taskFlag } from "./task-args.js";
/** A production npm install, not a link to the development node_modules. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const root = process.cwd(),
  pkg = JSON.parse(await readFile("package.json", "utf8"));
const tarball = resolve(".release", `${pkg.name}-${pkg.version}.tgz`);
if (!existsSync(tarball)) throw Error("先运行 osdk run package");
const files = (await exec("tar", ["-tzf", tarball])).stdout
  .split("\n")
  .filter(Boolean);
assert(files.length > 0);
assert(
  !files.some((p) =>
    /(?:^|\/)(?:\.repo-review|\.omem|\.git|node_modules|\.osdk|omem\.local\.json)(?:\/|$)/.test(
      p,
    ),
  ),
);
assert(!files.some((p) => /\.(?:sqlite|db|safetensors|jsonl)$/.test(p)));
const schedulesReference = "skills/omem-cli/references/schedules.md";
const dependenciesReference = "skills/omem-cli/references/dependencies.md";
assert(
  files.includes(`package/${schedulesReference}`),
  "The tarball must include the conversation and schedule reference",
);
assert(
  files.includes(`package/${dependenciesReference}`),
  "The tarball must include optional dependency installation guidance",
);
const temp = await mkdtemp(join(tmpdir(), "omem-npm-")),
  prefix = join(temp, "install"),
  cwd = join(temp, "outside"),
  data = join(temp, "data");
await mkdir(cwd);
await mkdir(prefix);
await writeFile(
  join(prefix, "package.json"),
  JSON.stringify({ private: true }),
);
const node = (await exec("node", ["-p", "process.execPath"])).stdout.trim();
const bin = join(prefix, "node_modules/.bin/omem");
const installedCli = join(
  prefix,
  "node_modules/omem/dist/apps/server/src/cli.js",
);
const optional = taskFlag("optional");
const optionalChecks: string[] = [];
const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
await new Promise<void>((r) => server.close(() => r()));
const env = {
  ...process.env,
  OMEM_DATA_DIR: data,
  OMEM_PORT: String(port),
  PATH: dirname(node) + delimiter + process.env.PATH,
};
delete env.OMEM_CONFIG;
delete env.OMEM_URL;
delete env.OMEM_TOKEN;
async function cli(
  args: string[],
  ok = true,
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
) {
  try {
    return (
      await exec(
        options.env ? node : bin,
        options.env ? [installedCli, ...args] : args,
        {
          cwd,
          env: options.env ?? env,
          timeout: options.timeout ?? (args[0] === "ask" ? 0 : 90_000),
          maxBuffer: 2_000_000,
        },
      )
    ).stdout;
  } catch (error) {
    if (ok) throw error;
    return error as { code: number; stdout: string; stderr: string };
  }
}

// Small synthetic documents created with Python's standard library. They do not
// reuse private originals, require another fixture package, or run OCR.
async function createDocumentFixtures(python: string) {
  const docx = join(cwd, "release-checklist.docx");
  const pdf = join(cwd, "release-checklist.pdf");
  await exec(
    python,
    [
      "-c",
      String.raw`
import sys, zipfile
files = {
"[Content_Types].xml": '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>''',
"_rels/.rels": '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>''',
"word/_rels/document.xml.rels": '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''',
"word/styles.xml": '''<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>''',
"word/document.xml": '''<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>发布检查表</w:t></w:r></w:p><w:p><w:r><w:t>发布前先完成回滚方案。</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>负责方</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>确认事项</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>发布负责人</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>检查回滚方案</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'''
}
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for path, content in files.items(): archive.writestr(path, content.encode("utf-8"))
`,
      docx,
    ],
    { cwd, env, timeout: 30_000 },
  );
  const stream =
    "BT /F1 18 Tf 60 720 Td (Emergency release checklist) Tj 0 -30 Td /F1 12 Tf (Confirm rollback plan before deployment.) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(pdf, content);
  return { docx, pdf };
}
try {
  console.log(
    "Installing tarball and production dependencies in an isolated directory...",
  );
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      tarball,
    ],
    { cwd, env, timeout: 600_000, maxBuffer: 10_000_000 },
  );
  console.log("Checking installed help, package assets and initialization...");
  for (const args of [
    [],
    ["--help"],
    ["messages", "--help"],
    ["data", "archive", "--help"],
    ["requirements", "track", "--help"],
    ["requirements", "follow", "--help"],
    ["develop", "start", "--help"],
    ["develop", "apply", "--help"],
    ["knowledge", "write", "--help"],
    ["doctor", "--help"],
    ["setup", "--help"],
    ["setup", "decisions", "--model", "9b", "--help"],
    ["--version"],
  ])
    await cli(args);
  const scheduleCommands = [
    "list",
    "show",
    "add",
    "configure",
    "pause",
    "resume",
    "run",
    "delete",
  ];
  const scheduleHelp = String(await cli(["schedules", "--help"]));
  for (const command of scheduleCommands) {
    assert.match(scheduleHelp, new RegExp(`\\b${command}\\b`));
    assert.match(String(await cli(["schedules", command, "--help"])), /Usage:/);
  }
  assert.match(String(await cli(["messages", "chats", "--help"])), /Usage:/);
  const autoWatchCommands = ["status", "configure", "run"];
  const autoWatchHelp = String(await cli(["messages", "auto-watch", "--help"]));
  for (const command of autoWatchCommands) {
    assert.match(autoWatchHelp, new RegExp(`\\b${command}\\b`));
    assert.match(
      String(await cli(["messages", "auto-watch", command, "--help"])),
      /Usage:/,
    );
  }
  assert(!existsSync(data), "Help must not create data or load configuration");
  const setupHelp = String(await cli(["setup", "--help"]));
  for (const size of ["2b", "4b", "9b", "both", "all"])
    assert.match(setupHelp, new RegExp(`\\b${size}\\b`));
  assert.match(String(await cli(["doctor", "--help"])), /--verify-models/);
  assert.match(String(await cli(["doctor", "--help"])), /--local/);
  const emptyPath = join(temp, "no-optional-tools");
  await mkdir(emptyPath);
  const missingOsdk = (await cli(["setup", "embedding"], false, {
    env: { ...env, PATH: emptyPath },
  })) as { code: number; stdout: string; stderr: string };
  assert.equal(missingOsdk.code, 1);
  assert.match(missingOsdk.stderr, /one-sdk/);
  assert.match(missingOsdk.stderr, /osdk --version/);
  assert(
    !existsSync(data),
    "Missing osdk must not create an optional environment",
  );
  const remoteSetup = (await cli(
    ["--url", "https://omem-install.invalid", "setup", "embedding"],
    false,
  )) as { code: number; stderr: string };
  assert.equal(remoteSetup.code, 1);
  assert.match(remoteSetup.stderr, /--url|服务机器|远端/);
  assert(
    !existsSync(data),
    "Remote setup refusal must happen before preparing local resources",
  );
  assert.equal(((await cli(["nonexistent"], false)) as any).code, 2);
  const first = JSON.parse((await cli(["init", "--json"])) as string);
  assert.equal(first.created, true);
  const second = JSON.parse((await cli(["init", "--json"])) as string);
  assert.equal(second.created, false);
  assert.equal(first.dataDir, data);
  await cli(["config", "validate"]);
  await cli(["skills", "install", join(temp, "skills")]);
  assert(existsSync(join(temp, "skills/omem-cli/references/workflows.md")));
  assert(existsSync(join(temp, "skills/omem-cli/references/development.md")));
  const packagedSchedules = await readFile(
    join(prefix, "node_modules/omem", schedulesReference),
    "utf8",
  );
  assert.equal(
    packagedSchedules,
    await readFile(join(root, schedulesReference), "utf8"),
    "The installed reference must match the current packaged source",
  );
  assert.equal(
    await readFile(join(temp, schedulesReference), "utf8"),
    packagedSchedules,
    "skills install must copy the complete schedule reference",
  );
  assert.match(
    await readFile(join(temp, "skills/omem-cli/SKILL.md"), "utf8"),
    /references\/schedules\.md/,
  );
  const packagedDependencies = await readFile(
    join(prefix, "node_modules/omem", dependenciesReference),
    "utf8",
  );
  assert.equal(
    packagedDependencies,
    await readFile(join(root, dependenciesReference), "utf8"),
  );
  assert.equal(
    await readFile(join(temp, dependenciesReference), "utf8"),
    packagedDependencies,
    "skills install must copy the complete optional dependency reference",
  );
  assert.match(
    await readFile(join(temp, "skills/omem-cli/SKILL.md"), "utf8"),
    /references\/dependencies\.md/,
  );
  const initialDoctor = JSON.parse(
    String(await cli(["doctor", "--local", "--json"])),
  );
  const initial9b = initialDoctor.optional.checks.find(
    (check: { id: string }) => check.id === "model.decision-startlux9b",
  );
  assert(initial9b, "Installed doctor must describe the optional 9B model");
  assert.equal(initial9b.enabled, false);
  assert.equal(
    initial9b.installed,
    false,
    "Initialization must not install 9B or claim another workspace's models",
  );
  const importPath = join(
    prefix,
    "node_modules/omem/dist/apps/server/src/agent-runtime/bundles.js",
  );
  await exec(
    node,
    [
      "--input-type=module",
      "-e",
      `const {RoleBundleRegistry}=await import(${JSON.stringify(importPath)}); const r=new RoleBundleRegistry(); r.load('daily-assistant'); r.load('knowledge-researcher'); r.load('knowledge-writer'); r.load('knowledge-verifier'); r.load('requirement-tracker'); r.load('implementation-planner'); const {decisionModelAliases}=await import(${JSON.stringify(join(prefix, "node_modules/omem/dist/apps/server/src/cli/setup.js"))}); const {default:assert}=await import('node:assert/strict'); assert.deepEqual(decisionModelAliases(),['decision-startlux2b']); assert.deepEqual(decisionModelAliases('9b'),['decision-startlux9b']); assert.deepEqual(decisionModelAliases('both'),['decision-startlux2b','decision-startlux4b']); assert.deepEqual(decisionModelAliases('all'),['decision-startlux2b','decision-startlux4b','decision-startlux9b']);`,
    ],
    { cwd, env },
  );
  let documents: Awaited<ReturnType<typeof createDocumentFixtures>> | undefined;
  if (optional) {
    console.log(
      "Preparing real installed Docling and small model dependencies with osdk; StartLux weights are not downloaded...",
    );
    const before = JSON.parse(await readFile(first.config, "utf8"));
    for (const component of ["documents", "document-models", "embedding"]) {
      console.log(`Preparing installed optional capability: ${component}`);
      const prepared = JSON.parse(
        String(
          await cli(["setup", component, "--json"], true, { timeout: 600_000 }),
        ),
      );
      assert.equal(prepared.status, "prepared");
      assert.equal(prepared.component, component);
      assert.equal(prepared.configurationChanged, false);
      optionalChecks.push(`installed setup ${component}`);
    }
    assert.deepEqual(
      JSON.parse(await readFile(first.config, "utf8")),
      before,
      "Preparing dependencies must preserve capability switches and personal configuration",
    );
    const checked = JSON.parse(
      String(
        await cli(["doctor", "--local", "--verify-models", "--json"], true, {
          timeout: 600_000,
        }),
      ),
    );
    assert.equal(checked.optional.verifyModels, true);
    assert.equal(checked.optional.healthy, true);
    for (const id of [
      "documents.python",
      "model.docling-layout",
      "model.docling-tables",
      "model.memory-zh",
    ]) {
      const check = checked.optional.checks.find(
        (item: { id: string }) => item.id === id,
      );
      assert.equal(
        check?.state,
        "verified",
        `${id} must pass real installed dependency verification`,
      );
    }
    const python = checked.optional.checks.find(
      (item: { id: string }) => item.id === "documents.python",
    ).path;
    documents = await createDocumentFixtures(python);
    before.retrieval.enabled = true;
    await writeFile(first.config, JSON.stringify(before, null, 2) + "\n", {
      mode: 0o600,
    });
    optionalChecks.push(
      "installed local model file verification; no model inference in doctor",
    );
  }
  console.log("Starting installed PM2 service, importing and searching...");
  const service = JSON.parse(
    (await cli(["service", "start", "--json"])) as string,
  );
  assert.equal(service.state, "online");
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  await writeFile(
    join(cwd, "notes.md"),
    "# 发布约定\n\n发布前需要完成回滚方案，并由负责人确认。\n",
  );
  await cli(["import", "file", "notes.md", "--json"]);
  const hits = JSON.parse(
    (await cli(["search", "回滚方案", "--json"])) as string,
  );
  assert(hits.length > 0);
  await cli([
    "import",
    "text",
    "周五前补充设计稿",
    "--title",
    "项目安排",
    "--json",
  ]);
  if (documents) {
    console.log(
      "Importing synthetic DOCX and text PDF through the installed service...",
    );
    for (const [format, path] of Object.entries(documents)) {
      const imported = JSON.parse(
        String(
          await cli(["import", "file", path, "--json"], true, {
            timeout: 240_000,
          }),
        ),
      );
      const revision = JSON.parse(
        String(
          await cli(["sources", "revision", imported.revision.id, "--json"]),
        ),
      );
      assert.equal(revision.context.document.parser, "docling");
      const markdown = revision.parts
        .filter((part: { type: string }) => part.type === "text")
        .map((part: { text: string }) => part.text)
        .join("\n");
      const documentUrl = `http://127.0.0.1:${port}/api/revisions/${encodeURIComponent(revision.id)}/document`;
      const originalResponse = await fetch(documentUrl + "/original");
      assert.equal(originalResponse.status, 200);
      assert.deepEqual(
        Buffer.from(await originalResponse.arrayBuffer()),
        await readFile(path),
        "Installed parser must preserve original bytes",
      );
      const structureResponse = await fetch(documentUrl + "/structure");
      assert.equal(structureResponse.status, 200);
      const structure = (await structureResponse.json()) as {
        pageCount: number;
        blocks: { label: string; provenance: { page_no: number }[] }[];
      };
      if (format === "docx") {
        assert.match(markdown, /^#{1,6}\s+发布检查表/m);
        assert.match(markdown, /发布负责人/);
        assert.match(markdown, /检查回滚方案/);
        assert(
          structure.blocks.some((block) => block.label === "table"),
          "DOCX table must remain a structured table",
        );
      } else {
        assert.match(markdown, /Confirm rollback plan before deployment/i);
        assert.equal(structure.pageCount, 1);
        assert(
          structure.blocks.some((block) =>
            block.provenance.some((position) => position.page_no === 1),
          ),
          "Text PDF must preserve page provenance",
        );
      }
      optionalChecks.push(
        `installed ${format.toUpperCase()} import, preserved original and structure`,
      );
    }
    const deadline = Date.now() + 60_000;
    let semantic;
    while (Date.now() < deadline) {
      const health = JSON.parse(String(await cli(["status", "--json"])));
      semantic = health.retrieval.semantic;
      if (semantic.state === "ready" || semantic.state === "degraded") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(
      semantic?.state,
      "ready",
      `Installed embedding must load and index; ${JSON.stringify(semantic)}`,
    );
    assert(semantic.indexed > 0);
    assert.equal(semantic.pending, 0);
    const semanticHits = JSON.parse(
      String(await cli(["search", "发布前要准备回滚方案", "--json"])),
    );
    assert(semanticHits.length > 0);
    optionalChecks.push(
      "installed Chinese embedding loaded, indexed and used by HTTP search",
    );
  }
  await cli(["doctor", "--json"]);
  const scope = JSON.parse(
    (await cli([
      "contexts",
      "create",
      "发布项目",
      "--description",
      "发布约定",
      "--json",
    ])) as string,
  );
  assert(scope.id);
  assert.deepEqual(
    JSON.parse((await cli(["requirements", "list", "--json"])) as string),
    [],
  );
  assert.equal(
    ((await cli(["data", "backup", join(temp, "busy-backup")], false)) as any)
      .code,
    1,
  );
  if (taskFlag("agent")) {
    console.log("Checking installed CLI with real Traex ACP / gpt-5.6-sol...");
    const answer = JSON.parse(
      (await cli([
        "ask",
        "发布前需要完成什么？请根据已有材料直接回答。",
        "--research",
        "--json",
      ])) as string,
    );
    assert.equal(answer.turn.inputMessageRefs.status, "done");
    assert.match(answer.turn.result, /回滚/);
    console.log("Real Agent answered from the installed library.");
  }
  const state = JSON.parse(
    (await cli(["messages", "status", "--json"])) as string,
  );
  assert(!state.settings?.enabled);
  await cli(["service", "stop", "--json"]);
  const stopped = (await cli(["service", "status", "--json"], false)) as any;
  assert.equal(stopped.code, 1);
  const backup = join(temp, "backup"),
    restored = join(temp, "restored");
  await cli(["data", "backup", backup, "--json"]);
  await cli(["data", "restore", backup, "--to", restored, "--json"]);
  const storage = JSON.parse(
    (await cli(["--data-dir", restored, "data", "info", "--json"])) as string,
  );
  assert(storage.database.counts.sources >= 2);
  await cli([
    "data",
    "archive",
    "--before",
    "2020-01-01",
    "--to",
    join(temp, "cold"),
    "--apply",
    "--json",
  ]);
  console.log(
    JSON.stringify(
      {
        passed: true,
        files: files.length,
        platform: `${process.platform}/${process.arch}`,
        optional,
        checks: [
          "production install",
          "nested help and exit codes",
          "schedule and automatic watch help",
          "idempotent init",
          "packaged roles and skills",
          "complete schedule reference installation",
          "complete optional dependency reference installation",
          "optional setup help and 9B selection without downloading weights",
          "missing osdk guidance and remote setup refusal",
          "read-only local dependency diagnostics",
          "Web assets",
          "PM2 start/stop",
          "file/text capture",
          "Chinese search",
          "collector remains disabled",
          "requirement roles and project CLI",
          "live-library maintenance refusal",
          "offline backup, restore and cold-store setup",
          ...optionalChecks,
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  // Only the daemon created for this disposable library; never the user's PM2_HOME.
  const home = join(data, "service/pm2");
  if (existsSync(join(home, "pm2.pid"))) {
    await exec(node, [join(prefix, "node_modules/pm2/bin/pm2"), "kill"], {
      cwd,
      env: { ...env, PM2_HOME: home },
      timeout: 30_000,
    }).catch((e) => {
      console.error("Temporary PM2 cleanup failed", e.message);
      process.exitCode = 1;
    });
  }
  if (!process.exitCode) await rm(temp, { recursive: true, force: true });
  else console.error(`保留失败现场：${temp}`);
}

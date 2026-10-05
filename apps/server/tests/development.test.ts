import { RoleBundleRegistry } from "../src/agent-runtime/bundles.js";
import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { developmentProjectSchema } from "../../../packages/contracts/src/development.js";
import {
  codeTools,
  fingerprint,
  git,
  runCommand,
  saveJson,
  snapshotCommit,
} from "../src/development/workspace.js";
import { DevelopmentRunner } from "../src/development/runner.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { requirementBrief } from "../src/knowledge/requirements.js";
import { RequirementTasks } from "../src/knowledge/requirement-tasks.js";
import { stableDigest } from "../src/storage/digest.js";
const directories: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0))
    rmSync(d, { recursive: true, force: true });
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-dev-test-"));
  directories.push(dir);
  const root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "Follow project conventions");
  writeFileSync(join(root, "src/AGENTS.md"), "Do not mutate arguments");
  writeFileSync(join(root, "src/a.js"), "export const value = 1;\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  const project = developmentProjectSchema.parse({
    name: "Test",
    repository: root,
    commands: [
      {
        name: "check",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        purpose: "test",
      },
    ],
  });
  const store = new Store(join(dir, "data"));
  stores.push(store);
  const repository = new KnowledgeRepository(store);
  const captured = store.capture(
    {
      source: "manual",
      externalId: "r",
      title: "Requirement",
      parts: [
        {
          type: "text",
          text: "Ming will implement the new function. No due date agreed.",
        },
      ],
      context: {},
    },
    { learning: false, notify: false },
  );
  const material = repository.materials()[0]!;
  const publish = (
    title = "Implement function",
    status: "open" | "done" = "open",
  ) =>
    repository.publish({
      version: 1,
      document: {
        key: "requirement:test",
        title: "Test",
        summary: "Goal",
        category: "Test",
        sections: [
          {
            key: "goal",
            title: "Goal",
            body: "Implementation is required.[[c1]]",
          },
        ],
        questions: [],
        citations: [
          {
            key: "c1",
            label: "Requirement",
            reason: "Goal",
            relation: "supports",
            target: {
              kind: "material",
              key: material.key,
              startLine: 1,
              endLine: 1,
            },
            quote: material.text,
          },
        ],
        requirement: {
          objective: "Implement function",
          nonGoals: [],
          criteria: [
            {
              id: "function",
              description: "Return new value",
              status: "missing",
              evidence: ["c1"],
            },
          ],
          actions: [
            {
              id: "implement",
              title,
              detail: "Read the project rules",
              owner: "Ming",
              waitingOn: null,
              dueAt: null,
              dueExpression: null,
              status,
              certainty: "confirmed",
              evidence: ["c1"],
            },
          ],
        },
      },
      dependencies: [
        { kind: "material", key: material.key, digest: material.digest },
      ],
      generation: {
        model: "fixture",
        effort: null,
        at: new Date().toISOString(),
        trace: {},
      },
      review: {
        model: "fixture",
        at: new Date().toISOString(),
        trace: {},
        verdict: "accepted",
      },
      reading: requirementBrief({
        key: "requirement:test",
        title: "Test",
        goal: "Implement function",
        contextIds: undefined,
      }),
    });
  const article = publish();
  return { dir, root, project, store, repository, publish, article };
}
it("requires applicable nested rules before edits and provides read-only review tools", async () => {
  const { dir, root, project } = await setup(),
    base = (await git(root, "rev-parse", "HEAD")).trim();
  const tools = codeTools({
    root,
    base,
    project,
    readOnly: false,
    logs: join(dir, "logs"),
    onCheck: () => {},
  });
  const call = (name: string, args: any) =>
    tools.find((t) => t.name === name)!.run(args, {} as any);
  const hash = stableDigest(readFileSync(join(root, "src/a.js"), "utf8"));
  expect(() =>
    call("write_code", {
      path: "src/a.js",
      expectedHash: hash,
      text: "export const value = 2;",
    }),
  ).toThrow("project_rules");
  await call("project_rules", { path: "src/a.js" });
  await call("write_code", {
    path: "src/a.js",
    expectedHash: hash,
    text: "export const value = 2;",
  });
  expect(() =>
    call("write_code", { path: "src/a.js", expectedHash: hash, text: "old" }),
  ).toThrow("文件已变化");
  expect(
    codeTools({
      root,
      base,
      project,
      readOnly: true,
      logs: join(dir, "logs"),
      onCheck: () => {},
    }).some((t) => t.name === "write_code"),
  ).toBe(false);
  symlinkSync(dir, join(root, "escape"));
  expect(() =>
    call("read_code", { path: "escape/repo/AGENTS.md", startLine: 1 }),
  ).toThrow("符号链接");
  const result = await runCommand(root, project, "check", join(dir, "logs"));
  expect(result.exitCode).toBe(3);
});
it("applies only the reviewed isolated checkout and protects a changed source worktree", async () => {
  const { dir, root, project, store } = await setup(),
    runner = new DevelopmentRunner(join(dir, "data"));
  await runner.register("test", project);
  const run = await runner.create("test", "requirement:test", store);
  writeFileSync(join(run.checkout, "src/a.js"), "export const value = 2;\n");
  run.head = await snapshotCommit(run.checkout, "implementation");
  run.state = "ready";
  run.reviewedFingerprint = await fingerprint(run.checkout);
  runner.save(run);
  writeFileSync(
    join(run.directory, "changes.patch"),
    "malicious or stale exported patch",
  );
  await runner.apply(run.id);
  expect(readFileSync(join(root, "src/a.js"), "utf8")).toContain("2");
  expect(await git(root, "log", "-1", "--format=%s")).toContain("initial");
  await expect(
    runner.create("test", "requirement:test", store),
  ).rejects.toThrow("未提交");
});
it("maintains one linked task across accepted requirement updates and preserves manual correction", async () => {
  const { store, article, publish } = await setup(),
    service = new RequirementTasks(store);
  service.follow(article.document.key, "implement", article.revision);
  service.sync(article);
  expect(store.tasks()).toHaveLength(1);
  expect(store.tasks()[0]!.ownerId).toBe("owner");
  expect(store.tasks()[0]!.detail).toContain("Ming");
  service.sync(publish("Implement the new API"));
  expect(store.tasks()).toHaveLength(1);
  expect(store.tasks()[0]!.title).toContain("new API");
  const task = store.tasks()[0]!;
  store.setTaskStatus(String(task.id), "cancelled", Number(task.version));
  service.sync(publish("Implement the API", "done"));
  expect(store.tasks()[0]!.status).toBe("cancelled");
  expect(service.board(article.document.key).links[0]!.error).toContain("修改");
});

it("loads executable coding and independent review roles with their actual schemas", () => {
  const registry = new RoleBundleRegistry();
  expect(registry.load("coding-agent").manifest.output_schema).toBe(
    "ImplementationResult.v1",
  );
  expect(registry.load("code-reviewer").manifest.output_schema).toBe(
    "ImplementationReview.v1",
  );
});

it("sends failures back for repair and gives the independent reviewer no developer self-assessment",async()=>{
 const {dir,root,store,project}=await setup();
 const {RoleRuntimeGateway}=await import("../src/agent-runtime/gateway.js");
 const {profileSchema}=await import("../../../packages/contracts/src/index.js");
 const {vi}=await import("vitest");
 project.commands=[{name:"behavior",command:process.execPath,args:["-e","import('./src/a.js').then(m=>process.exit(m.value===2?0:1))"],cwd:".",purpose:"test",required:true,timeoutMs:10000}];
 const runner=new DevelopmentRunner(join(dir,"data"));await runner.register("repair",project);const run=await runner.create("repair","requirement:test",store);
 let writes=0,reviews=0;
 const spy=vi.spyOn(RoleRuntimeGateway.prototype,"run").mockImplementation(async input=>{
   let result:unknown;
   if(input.roleId==="coding-agent"){
     writes++;if(writes===2)writeFileSync(join(run.checkout,"src/a.js"),"export const value=2;\n");
     if(writes===2)expect(input.context.task?.review).toHaveProperty("verdict","changes_requested");
     result={schema_version:1,summary:"AUTHOR CLAIM SHOULD NOT BIAS REVIEW",criteria:[{id:"function",status:"implemented",note:"Implemented"}],blockers:[]};
   }else{
     reviews++;expect(JSON.stringify(input.context)).not.toContain("AUTHOR CLAIM");
     result={schema_version:1,verdict:reviews===1?"changes_requested":"accepted",summary:reviews===1?"Behavior is wrong":"Behavior matches",criteria:[{id:"function",status:reviews===1?"failed":"passed",detail:"Ran the registered behavior check"}],findings:reviews===1?[{priority:"high",path:"src/a.js",line:1,issue:"Returns old value",change:"Return 2"}]:[]};
   }
   return {result:input.validateOutput?.(result)??result,trace:{roleId:input.roleId}} as any;
 });
 try{
   const result=await runner.execute(run.id,store,profileSchema.parse({id:"traex",name:"Fixture",transport:"acp",command:"traex",args:[]}));
   expect(result.state).toBe("ready");expect(writes).toBe(2);expect(reviews).toBe(2);
   expect(result.checks.map(c=>c.exitCode)).toEqual([1,0]);
   expect(readFileSync(join(root,"src/a.js"),"utf8")).toContain("1");
 }finally{spy.mockRestore();}
});

import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  inspectOptionalWorkspace,
  optionalManifestName,
  prepareOptionalWorkspace,
} from "../src/cli/optional-workspace.js";
import { decisionModelAliases } from "../src/cli/setup.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const paths = [
  "scripts/document-parser/convert.py",
  "scripts/document-parser/pyproject.toml",
  "scripts/document-parser/uv.lock",
  "scripts/startlux/worker.py",
  "scripts/startlux/selection.py",
  "scripts/startlux/pyproject.toml",
  "scripts/startlux/uv.lock",
  "scripts/startlux/upstream.json",
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omem-optional-test-"));
  temporary.push(root);
  const assetRoot = join(root, "package");
  const cwd = join(root, "personal", "optional");
  await mkdir(join(assetRoot, "config"), { recursive: true });
  await writeFile(
    join(assetRoot, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  await writeFile(
    join(assetRoot, "config/models.toml"),
    '[models.example]\nsource="hf:example/model@one"\ninclude=["*.json"]\nexclude=[]\nfamily="example"\n',
  );
  for (const path of paths) {
    await mkdir(dirname(join(assetRoot, path)), { recursive: true });
    await writeFile(join(assetRoot, path), `original ${path}`);
  }
  const calls: string[][] = [];
  // Verify the ownership/commit policy separately from real osdk compatibility.
  // This fake only applies the one alias requested by the installer.
  const run = async (_command: string, args: string[], target: string) => {
    calls.push(args);
    const config = parse(await readFile(join(target, "osdk.toml"), "utf8"));
    const name = args[2]!,
      declaration: Record<string, string | string[]> = { source: args[3]! };
    for (let index = 4; index < args.length; index += 2) {
      const field = args[index]!.slice(2).replaceAll("-", "_"),
        value = args[index + 1]!;
      if (field === "include" || field === "exclude")
        declaration[field] = [
          ...((declaration[field] ?? []) as string[]),
          value,
        ];
      else declaration[field] = value;
    }
    declaration.include ??= [];
    declaration.exclude ??= [];
    (config.models as Record<string, unknown>)[name] = declaration;
    await writeFile(join(target, "osdk.toml"), stringify(config));
  };
  return { cwd, assetRoot, development: false, run, calls };
}

it("prepares fresh assets, upgrades owned models, and leaves customized resources intact", async () => {
  const f = await fixture();
  expect((await inspectOptionalWorkspace(f)).state).toBe("missing");
  await prepareOptionalWorkspace(f);
  expect(f.calls).toEqual([]);
  expect((await inspectOptionalWorkspace(f)).state).toBe("current");
  await writeFile(
    join(f.cwd, "scripts/startlux/worker.py"),
    "my custom worker",
  );
  const installed = await readFile(join(f.cwd, "osdk.toml"), "utf8");
  await writeFile(
    join(f.cwd, "osdk.toml"),
    `${installed}\n[settings]\njobs=7\n[models.private]\nsource="hf:private/custom@revision"\n`,
  );
  await writeFile(
    join(f.assetRoot, "config/models.toml"),
    '[models.example]\nsource="hf:example/model@two"\ninclude=["*.json"]\nexclude=[]\nfamily="example"\n[models.next]\nsource="hf:example/next@one"\ninclude=[]\nexclude=[]\n',
  );
  await writeFile(
    join(f.assetRoot, "scripts/startlux/worker.py"),
    "new package worker",
  );
  await writeFile(
    join(f.assetRoot, "scripts/document-parser/convert.py"),
    "new package converter",
  );
  expect((await inspectOptionalWorkspace(f)).state).toBe("update-available");
  const after = await prepareOptionalWorkspace(f);
  expect(f.calls.map((call) => call[2])).toEqual(["example", "next"]);
  const config = parse(await readFile(join(f.cwd, "osdk.toml"), "utf8"));
  expect(config.settings).toEqual({ jobs: 7 });
  expect(
    (config.models as Record<string, { source: string }>).private?.source,
  ).toBe("hf:private/custom@revision");
  expect(
    (config.models as Record<string, { source: string }>).example?.source,
  ).toBe("hf:example/model@two");
  expect(
    await readFile(join(f.cwd, "scripts/startlux/worker.py"), "utf8"),
  ).toBe("my custom worker");
  expect(
    await readFile(
      join(f.cwd, ".omem-updates/scripts/startlux/worker.py"),
      "utf8",
    ),
  ).toBe("new package worker");
  expect(
    await readFile(join(f.cwd, "scripts/document-parser/convert.py"), "utf8"),
  ).toBe("new package converter");
  expect(after.preserved).toEqual(["scripts/startlux/worker.py"]);
  expect(after.state).toBe("current");
});

it("preserves customized model declarations, including private endpoints, and offers the new template", async () => {
  const f = await fixture();
  await prepareOptionalWorkspace(f);
  const custom =
    '# private comments\n[models.example]\nsource="hf:mine/model@custom"\ninclude=["*.json"]\nexclude=[]\nendpoint="https://my-mirror.example"\nwhen={os="linux"}\n';
  await writeFile(join(f.cwd, "osdk.toml"), custom);
  await writeFile(
    join(f.assetRoot, "config/models.toml"),
    '[models.example]\nsource="hf:example/model@two"\ninclude=["*.json"]\nexclude=[]\nfamily="example"\n',
  );
  const after = await prepareOptionalWorkspace(f);
  expect(f.calls).toEqual([]);
  expect(await readFile(join(f.cwd, "osdk.toml"), "utf8")).toBe(custom);
  expect(after.preserved).toEqual(["models.example"]);
  expect(
    await readFile(join(f.cwd, ".omem-updates/osdk.toml"), "utf8"),
  ).toContain("hf:example/model@two");
});

it("recognizes pre-manifest defaults and does not overwrite private legacy aliases", async () => {
  const f = await fixture();
  await mkdir(f.cwd, { recursive: true });
  await writeFile(
    join(f.cwd, "osdk.toml"),
    '[models.docling-layout]\nsource="hf:docling-project/docling-layout-heron@8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"\ninclude=["*.json","*.safetensors"]\nexclude=[]\nkind="other"\nfamily="docling"\n[models.docling-layout.views]\n[models.example]\nsource="hf:mine/model@custom"\n',
  );
  await writeFile(
    join(f.assetRoot, "config/models.toml"),
    '[models.docling-layout]\nsource="hf:docling-project/docling-layout-heron@new"\ninclude=["*.json","*.safetensors"]\nexclude=[]\nkind="other"\nfamily="docling"\n[models.docling-layout.views]\n[models.example]\nsource="hf:example/model@two"\n',
  );
  expect((await inspectOptionalWorkspace(f)).state).toBe("legacy");
  const after = await prepareOptionalWorkspace(f);
  expect(f.calls.map((call) => call[2])).toEqual(["docling-layout"]);
  expect(after.preserved).toContain("models.example");
});

it("leaves working configuration and the baseline unchanged when a declaration command fails", async () => {
  const f = await fixture();
  await prepareOptionalWorkspace(f);
  const original = await readFile(join(f.cwd, "osdk.toml"), "utf8");
  const manifest = await readFile(join(f.cwd, optionalManifestName), "utf8");
  await writeFile(
    join(f.assetRoot, "config/models.toml"),
    '[models.example]\nsource="hf:example/model@two"\n',
  );
  await expect(
    prepareOptionalWorkspace({
      ...f,
      run: async () => {
        throw Error("osdk failed");
      },
    }),
  ).rejects.toThrow("osdk failed");
  expect(await readFile(join(f.cwd, "osdk.toml"), "utf8")).toBe(original);
  expect(await readFile(join(f.cwd, optionalManifestName), "utf8")).toBe(
    manifest,
  );
});

it("defaults to only 2b and downloads larger choices only when requested", () => {
  expect(decisionModelAliases()).toEqual(["decision-startlux2b"]);
  expect(decisionModelAliases("4b")).toEqual(["decision-startlux4b"]);
  expect(decisionModelAliases("9b")).toEqual(["decision-startlux9b"]);
  expect(decisionModelAliases("both")).toEqual([
    "decision-startlux2b",
    "decision-startlux4b",
  ]);
  expect(decisionModelAliases("all")).toEqual([
    "decision-startlux2b",
    "decision-startlux4b",
    "decision-startlux9b",
  ]);
});

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";
import { parseConfig, type Config } from "../config.js";
import { assetPath, configPath, defaultDataDir } from "../paths.js";

export type SetupConfigurationChanges = {
  embedding?: boolean;
  embeddingModel?: string;
  decisions?: "off" | "auto" | "2b" | "4b" | "9b";
};
export type SetupConfigurationSnapshot = {
  path: string;
  /** The original bytes are the comparison baseline, never a logging value. */
  raw: string | null;
  template: string;
  config: Config;
};

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Use the same schema as the service before changing any personal setting. */
function validateConfiguration(raw: string) {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw Error("配置文件不是有效 JSON；请先修复配置，再运行 omem setup。");
  }
  return parseConfig(input);
}

export async function readSetupConfigurationSnapshot(
  options: { path?: string } = {},
): Promise<SetupConfigurationSnapshot> {
  const path = options.path ?? configPath();
  const raw = await readExisting(path);
  const template =
    raw ?? (await readFile(assetPath("config", "omem.default.json"), "utf8"));
  const config = validateConfiguration(template);
  const dataDir = defaultDataDir();
  return {
    path,
    raw,
    template,
    config: {
      ...config,
      configFile: path,
      dataDir,
      agentCwd: join(dataDir, "agent-workspace"),
      token: process.env.OMEM_TOKEN,
      host: process.env.OMEM_HOST || "127.0.0.1",
      port: Number(process.env.OMEM_PORT || 4317),
    },
  };
}

/** Patch only the chosen leaf so unrelated values and formatting stay intact. */
function patchField(
  raw: string,
  path: readonly string[],
  value: unknown,
): string {
  const source = ts.parseJsonText("config.json", raw);
  const root = (source.statements[0] as ts.ExpressionStatement | undefined)
    ?.expression;
  if (!root || !ts.isObjectLiteralExpression(root))
    throw Error("配置文件的顶层必须是 JSON 对象。");

  function visit(
    object: ts.ObjectLiteralExpression,
    keys: readonly string[],
  ): string {
    const [key, ...rest] = keys;
    const property = [...object.properties]
      .reverse()
      .find(
        (entry): entry is ts.PropertyAssignment =>
          ts.isPropertyAssignment(entry) &&
          ts.isStringLiteral(entry.name) &&
          entry.name.text === key,
      );
    if (property) {
      if (rest.length) {
        if (!ts.isObjectLiteralExpression(property.initializer))
          throw Error(`配置 ${path.join(".")} 的父级不是对象。`);
        return visit(property.initializer, rest);
      }
      return (
        raw.slice(0, property.initializer.getStart(source)) +
        JSON.stringify(value) +
        raw.slice(property.initializer.end)
      );
    }

    let nested = value;
    for (const segment of [...rest].reverse()) nested = { [segment]: nested };
    const encoded = `${JSON.stringify(key)}: ${JSON.stringify(nested)}`;
    const start = object.getStart(source);
    const close = object.end - 1;
    const body = raw.slice(start + 1, close);
    const last = object.properties.at(-1);
    if (!body.includes("\n")) {
      const trailing = body.match(/\s*$/)?.[0] ?? "";
      const insert = last ? last.end : start + 1;
      return (
        raw.slice(0, insert) +
        (last ? ", " : "") +
        encoded +
        trailing +
        raw.slice(close)
      );
    }
    const newline = raw.includes("\r\n") ? "\r\n" : "\n";
    const closeIndent = raw.slice(raw.lastIndexOf("\n", close) + 1, close);
    const beforeLast = last
      ? raw.slice(
          raw.lastIndexOf("\n", last.getStart(source)) + 1,
          last.getStart(source),
        )
      : "";
    const indent =
      last && /^[\t ]*$/.test(beforeLast) ? beforeLast : `${closeIndent}  `;
    const insert = last ? last.end : start + 1;
    return (
      raw.slice(0, insert) +
      (last ? "," : "") +
      newline +
      indent +
      encoded +
      raw.slice(insert)
    );
  }
  return visit(root, path);
}

export async function applySetupConfiguration(
  snapshot: SetupConfigurationSnapshot,
  changes: SetupConfigurationChanges,
  options: { createIfMissing?: boolean } = {},
) {
  let next = snapshot.template;
  if (changes.embedding !== undefined)
    next = patchField(next, ["retrieval", "enabled"], changes.embedding);
  if (changes.embeddingModel !== undefined)
    next = patchField(next, ["retrieval", "osdkModel"], changes.embeddingModel);
  if (changes.decisions !== undefined)
    next = patchField(next, ["decisions", "mode"], changes.decisions);
  validateConfiguration(next);
  if (
    (changes.embedding === undefined &&
      changes.embeddingModel === undefined &&
      changes.decisions === undefined &&
      !(snapshot.raw === null && options.createIfMissing)) ||
    next === snapshot.raw
  )
    return { changed: false, path: snapshot.path };

  await mkdir(dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(snapshot.path),
    `.omem-setup-${randomUUID()}.json`,
  );
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    if ((await readExisting(snapshot.path)) !== snapshot.raw)
      throw Error(
        "安装期间配置已被修改，未覆盖。请重新运行 omem setup 核对选择。",
      );
    if (snapshot.raw === null) {
      // link is create-if-absent: another initializer cannot be overwritten.
      try {
        await link(temporary, snapshot.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw Error(
            "安装期间配置已被创建，未覆盖。请重新运行 omem setup 核对选择。",
          );
        throw error;
      }
    } else {
      await rename(temporary, snapshot.path);
    }
    return { changed: true, path: snapshot.path };
  } finally {
    await rm(temporary, { force: true });
  }
}

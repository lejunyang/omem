import { readSandboxConfig } from "./sandbox-config-file.ts";

export function sandboxNpmrc(path: string): Buffer {
  const original = readSandboxConfig(path);
  const text = original.toString("utf8");
  let continued = false;
  const clean = text.split(/(?<=\n)/).filter(line => {
    const key = line.split("=", 1)[0]!.trim().replace(/^[;#\s"']+|["']+$/g, "");
    const secret = /(?:^|:)(?:_?auth(?:token)?|_?password|username|token(?:helper)?|cert(?:file)?|key(?:file)?)(?:\[\])?$/i.test(key);
    const drop = continued || secret;
    continued = drop && /\\\s*$/.test(line);
    return !drop;
  }).join("").replace(/(https?:\/\/)[^\s/@]+@/gi, "$1");
  return clean === text ? original : Buffer.from(clean);
}

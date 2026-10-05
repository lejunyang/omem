import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir(".release", { recursive: true });
const output = execFileSync(
  "npm",
  ["pack", "--json", "--pack-destination", ".release"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const [manifest] = JSON.parse(output.slice(output.indexOf("[")));
await writeFile(
  ".release/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      file: ".release/" + manifest.filename,
      bytes: manifest.size,
      files: manifest.files.length,
      integrity: manifest.integrity,
      manifest: ".release/manifest.json",
    },
    null,
    2,
  ),
);

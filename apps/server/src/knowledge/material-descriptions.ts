import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { materialDescriptionSchema } from "../../../../packages/contracts/src/material-description.js";
import { stableDigest } from "../storage/digest.js";
import type { KnowledgeRepository } from "./repository.js";

const artifactSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    digest: z.string(),
    description: materialDescriptionSchema,
    generation: z.object({
      at: z.string(),
      trace: z.record(z.string(), z.unknown()),
    }),
  })
  .strict();
export type MaterialDescriptionArtifact = z.infer<typeof artifactSchema>;
export function publishMaterialDescription(
  directory: string,
  artifact: MaterialDescriptionArtifact,
) {
  artifactSchema.parse(artifact);
  mkdirSync(join(directory, "history"), { recursive: true });
  const path = join(directory, stableDigest(artifact.key) + ".json");
  if (existsSync(path)) {
    const previous = readFileSync(path, "utf8");
    writeFileSync(
      join(directory, "history", stableDigest(previous) + ".json"),
      previous,
    );
  }
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
}
export function restoreMaterialDescriptions(
  repository: KnowledgeRepository,
  directory: string,
) {
  if (!existsSync(directory)) return { restored: 0, unavailable: 0 };
  let restored = 0,
    unavailable = 0;
  for (const file of readdirSync(directory).filter((f) =>
    f.endsWith(".json"),
  )) {
    const artifact = artifactSchema.parse(
      JSON.parse(readFileSync(join(directory, file), "utf8")),
    );
    const material = repository.resolveMaterial(
      artifact.key,
      artifact.digest,
    )?.material;
    if (!material) {
      unavailable++;
      continue;
    }
    const previous = repository.store.descriptions.get(material.revisionId);
    if (
      previous?.author === "user" ||
      (previous &&
        stableDigest(previous.description) ===
          stableDigest(artifact.description))
    )
      continue;
    repository.store.descriptions.save(
      material.revisionId,
      artifact.description,
      "model",
      previous?.version ?? 0,
      artifact.generation.trace,
    );
    restored++;
  }
  return { restored, unavailable };
}

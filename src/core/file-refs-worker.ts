import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
import { backfillFileRefs } from "./file-refs.ts";

const db = new DatabaseSync(workerData);
try {
  db.exec("pragma busy_timeout=5000");
  backfillFileRefs(db);
} finally { db.close(); }

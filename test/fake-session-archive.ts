import { appendFileSync } from "node:fs";

const [log, sessionId] = process.argv.slice(2);
if (process.env.FAKE_ARCHIVE_FAIL === "1") process.exit(1);
appendFileSync(log, sessionId + "\n");

import { appendFileSync, existsSync } from "node:fs";

const [log, sessionId] = process.argv.slice(2);
if (process.env.FAKE_ARCHIVE_FAIL === "1" || (process.env.FAKE_ARCHIVE_FAIL_FILE && existsSync(process.env.FAKE_ARCHIVE_FAIL_FILE))) process.exit(1);
appendFileSync(log, sessionId + "\n");

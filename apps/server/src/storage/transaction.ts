import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Let service operations compose existing repositories atomically. Inner
 * failures roll back only their savepoint; the caller can still roll back all. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const savepoint = db.isTransaction
    ? `omem_${randomUUID().replaceAll("-", "")}`
    : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    if (savepoint) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } else db.exec("ROLLBACK");
    throw error;
  }
}

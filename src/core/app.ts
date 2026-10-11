import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, omemHome, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { ensureLibraryRepo } from "./git.ts";

export type AppEvent =
  | { type: "run"; runId: string; status: string }
  | { type: "run-event"; runId: string; seq: number; event: { type: string; data: unknown; at: string } }
  | { type: "notification"; id: string; title: string; body: string; link?: string | null }
  | { type: "changed"; entity: "source" | "page" | "memory" | "item" | "card" | "space"; id: string; spaceId?: string };

/** Shared process context. Services take it instead of importing globals. */
export class App {
  readonly events = new EventEmitter();
  readonly libraryDir: string;
  readonly filesDir: string;
  readonly runsDir: string;
  baseUrl = "";
  /** Token that internal tools (MCP bridge) use to call back into the API. */
  internalToken = "";

  readonly home: string;
  readonly config: Config;
  readonly db: Db;

  constructor(home: string, config: Config, db: Db) {
    this.home = home;
    this.config = config;
    this.db = db;
    this.events.setMaxListeners(100);
    this.libraryDir = join(home, "library");
    this.filesDir = join(home, "files");
    this.runsDir = join(home, "runs");
    for (const dir of [this.libraryDir, this.filesDir, this.runsDir]) mkdirSync(dir, { recursive: true });
    ensureLibraryRepo(this.libraryDir);
  }

  emit(event: AppEvent) {
    this.events.emit("event", event);
  }

  static open(home = omemHome()) {
    mkdirSync(home, { recursive: true });
    const config = loadConfig(home);
    const db = openDb(join(home, "omem.db"));
    return new App(home, config, db);
  }
}

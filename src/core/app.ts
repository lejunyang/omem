import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, omemHome, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { disableGitFsmonitor, ensureLibraryRepo } from "./git.ts";
import { useKeyHome } from "./ai-keys.ts";

export type AppEvent =
  | { type: "run"; runId: string; status: string }
  | { type: "run-event"; runId: string; seq: number; event: { type: string; data: unknown; at: string } }
  | { type: "notification"; id: string; title: string; body: string; link?: string | null }
  | { type: "changed"; entity: "source" | "page" | "memory" | "item" | "card" | "space" | "requirement" | "code-task" | "rule"; id: string; spaceId?: string }
  | { type: "ask"; id: string; status: string; conversationId: string | null }
  | { type: "ui"; id: string; conversationId: string }
  | { type: "plugin"; plugin: string; conversationId: string; blockId?: string; settings?: boolean };

/** Shared process context. Services take it instead of importing globals. */
export class App {
  readonly events = new EventEmitter();
  readonly libraryDir: string;
  readonly filesDir: string;
  readonly runsDir: string;
  baseUrl = "";
  /** The HTTPS (HTTP/2) listener for browsers, when `https` is configured (server/secure.ts); "" otherwise. */
  secureUrl = "";
  /** Token that internal tools (MCP bridge) use to call back into the API. */
  internalToken = "";

  readonly home: string;
  readonly config: Config;
  readonly db: Db;

  constructor(home: string, config: Config, db: Db) {
    // Absolute: paths under it are handed to processes (git) that run in other directories.
    this.home = resolve(home);
    useKeyHome(this.home);
    this.config = config;
    this.db = db;
    const close = db.close.bind(db);
    db.close = () => { close(); this.events.emit("close"); };
    this.events.setMaxListeners(100);
    this.libraryDir = join(this.home, "library");
    this.filesDir = join(this.home, "files");
    this.runsDir = join(this.home, "runs");
    for (const dir of [this.libraryDir, this.filesDir, this.runsDir]) mkdirSync(dir, { recursive: true });
    ensureLibraryRepo(this.libraryDir);
  }

  emit(event: AppEvent) {
    this.events.emit("event", event);
  }

  static open(home = omemHome()) {
    disableGitFsmonitor();
    mkdirSync(home, { recursive: true });
    const config = loadConfig(home);
    const db = openDb(join(home, "omem.db"));
    return new App(home, config, db);
  }
}

// Repositories the tests create themselves (execFileSync("git", …)) must not start fsmonitor daemons either.
import { disableGitFsmonitor } from "../src/core/git.ts";

disableGitFsmonitor();

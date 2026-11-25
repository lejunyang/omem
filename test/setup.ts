// Repositories the tests create themselves (execFileSync("git", …)) must not start fsmonitor daemons either.
import { disableGitFsmonitor } from "../src/core/git.ts";

disableGitFsmonitor();

// Whatever Doubao CLI this machine has installed must not change which path the tests take.
import { ignoreInstalledDoubaoForTests } from "../src/agents/doubao-cli.ts";
ignoreInstalledDoubaoForTests();

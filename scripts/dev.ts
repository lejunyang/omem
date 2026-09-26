import { spawn } from "node:child_process";
const children = [
  spawn("npm", ["run", "dev:server"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn("npm", ["run", "dev:web"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
];
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
  });
for (const c of children)
  c.on("exit", (code) => {
    if (code) for (const other of children) other.kill("SIGTERM");
  });

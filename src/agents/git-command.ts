export function remoteGit(args: string[]) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) { i++; continue; }
    if (!arg.startsWith("-")) return ["push", "fetch", "pull", "clone", "ls-remote"].includes(arg);
  }
  return false;
}

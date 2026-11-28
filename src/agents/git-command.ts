export function remoteGit(args: string[]) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) { i++; continue; }
    if (arg.startsWith("-")) continue;
    let next = i + 1;
    if (arg === "remote") {
      while (["-v", "--verbose"].includes(args[next])) next++;
      return args[next] === "update";
    }
    if (arg === "submodule") {
      while (["-q", "--quiet"].includes(args[next])) next++;
      if (args[next] !== "update") return false;
      for (let j = next + 1; j < args.length; j++) {
        const option = args[j];
        if (option === "--" || !option.startsWith("-")) break;
        if (option === "--remote") return true;
        if (["--reference", "--depth", "--jobs", "-j", "--filter"].includes(option)) j++;
      }
      return false;
    }
    return ["push", "fetch", "pull", "clone", "ls-remote"].includes(arg);
  }
  return false;
}

/** osdk declared arguments, with direct Bun CLI compatibility. */
export const taskFlag = (name: string) => ["1", "true"].includes(process.env[`osdk_arg_${name.replaceAll("-", "_")}`] ?? process.env[`osdk_arg_${name}`] ?? "") || process.argv.includes(`--${name}`);
export const taskTargets = () => [process.env.osdk_arg_target ?? "", ...process.argv.filter(a => a.startsWith("--only=") || a.startsWith("--target=")).map(a => a.slice(a.indexOf("=") + 1))].filter(Boolean);

process.env.OMEM_REPO_ROOT ??= process.cwd();
process.env.OMEM_DEV_MODE = "personal";
await import("./dev-review.js");
export {};

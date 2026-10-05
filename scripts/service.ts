import { taskFlag } from "./task-args.js";
import {
  manageService,
  formatServiceStatus,
} from "../apps/server/src/service-manager.js";
const action = process.argv[2] ?? "status";
if (!["start", "stop", "restart", "status"].includes(action))
  throw Error("支持 start、stop、restart、status");
const result = await manageService(
  action as "start" | "stop" | "restart" | "status",
);
console.log(
  taskFlag("json")
    ? JSON.stringify(result, null, 2)
    : formatServiceStatus(result),
);
if (action !== "stop" && (result.state !== "online" || !result.health.healthy))
  process.exitCode = 1;

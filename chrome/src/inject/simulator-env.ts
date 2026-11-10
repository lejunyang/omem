// 居中模拟器不用 CDP 时的环境脚本：MAIN world，document_start，所有已授权站点的所有 frame 都会加载，
// 但只有「模拟器标签页里的直接子 frame、且 frame 名带参数」时才生效，普通页面里什么都不做。
import { parseSimulatorFrameName } from "../shared/device-simulator";
import { installSimulatorEnvironment } from "../shared/simulator-environment";

const params = parseSimulatorFrameName(window.name);
const parentOrigin = location.ancestorOrigins?.[0] ?? "";
if (params && window.parent === window.top && window !== window.top && parentOrigin.startsWith("chrome-extension://")) {
  installSimulatorEnvironment(params.environment);
  const override = (key: string, value: string) => {
    if (!value) return;
    try {
      Object.defineProperty(navigator, key, { configurable: true, get: () => value });
    } catch {
      // 不可配置时保留原值。
    }
  };
  // 请求头里的 UA 由后台的 DNR 规则改；这里改脚本读到的 navigator.userAgent。
  override("userAgent", params.userAgent);
  override("appVersion", params.userAgent.replace(/^Mozilla\//, ""));
  override("platform", params.platform);
}

import type { MockScriptInput, MockScriptOutput } from "./shared/mock-script";

interface RunMockScriptMessage {
  type: "advanced-network:run-mock-script";
  id: string;
  script: string;
  input: MockScriptInput;
}

interface SandboxResponseMessage {
  type: "advanced-network:mock-script-ready" | "advanced-network:mock-script-result";
  id: string;
  ok: boolean;
  result?: MockScriptOutput;
  error?: string;
}

const SANDBOX_TIMEOUT_MS = 1000;
let sandboxReady = false;
let sandboxReadyResolver: (() => void) | null = null;
const pendingRequests = new Map<
  string,
  {
    resolve: (value: SandboxResponseMessage) => void;
    timeoutId: number;
  }
>();

chrome.runtime.onMessage.addListener((message: RunMockScriptMessage, _sender, sendResponse) => {
  if (message.type !== "advanced-network:run-mock-script") {
    return false;
  }

  void runInSandbox(message)
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  return true;
});

window.addEventListener("message", (event: MessageEvent<SandboxResponseMessage>) => {
  const message = event.data;
  if (event.source !== getSandboxWindow()) {
    return;
  }

  if (message?.type === "advanced-network:mock-script-ready") {
    sandboxReady = true;
    sandboxReadyResolver?.();
    sandboxReadyResolver = null;
    return;
  }

  if (message?.type !== "advanced-network:mock-script-result") {
    return;
  }

  const pending = pendingRequests.get(message.id);
  if (!pending) {
    return;
  }

  window.clearTimeout(pending.timeoutId);
  pendingRequests.delete(message.id);
  pending.resolve(message);
});

async function runInSandbox(message: RunMockScriptMessage): Promise<{
  ok: boolean;
  result?: MockScriptOutput;
  error?: string;
}> {
  const sandboxWindow = await waitForSandboxWindow();
  const response = await new Promise<SandboxResponseMessage>((resolve) => {
    const timeoutId = window.setTimeout(() => {
      pendingRequests.delete(message.id);
      resolve({
        type: "advanced-network:mock-script-result",
        id: message.id,
        ok: false,
        error: "Mock script execution timed out."
      });
    }, SANDBOX_TIMEOUT_MS);

    pendingRequests.set(message.id, { resolve, timeoutId });
    sandboxWindow.postMessage(message, "*");
  });

  return response.ok
    ? {
        ok: true,
        result: response.result
      }
    : {
        ok: false,
        error: response.error
      };
}

async function waitForSandboxWindow(): Promise<Window> {
  const sandbox = document.querySelector<HTMLIFrameElement>("#mock-sandbox");
  if (!sandbox?.contentWindow) {
    throw new Error("Mock sandbox iframe is missing.");
  }

  if (sandboxReady) {
    return sandbox.contentWindow;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.clearInterval(pingIntervalId);
      reject(new Error("Mock sandbox iframe did not load."));
    }, SANDBOX_TIMEOUT_MS);
    const pingIntervalId = window.setInterval(() => {
      sandbox.contentWindow?.postMessage({ type: "advanced-network:mock-script-ping" }, "*");
    }, 50);
    sandboxReadyResolver = () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(pingIntervalId);
      resolve();
    };
    sandbox.contentWindow?.postMessage({ type: "advanced-network:mock-script-ping" }, "*");
  });

  return sandbox.contentWindow;
}

function getSandboxWindow(): Window | null {
  return document.querySelector<HTMLIFrameElement>("#mock-sandbox")?.contentWindow ?? null;
}

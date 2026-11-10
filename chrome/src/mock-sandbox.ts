import {
  normalizeMockScriptResult,
  type MockScriptInput,
  type MockScriptOutput
} from "./shared/mock-script";

interface RunMockScriptMessage {
  type: "advanced-network:run-mock-script";
  id: string;
  script: string;
  input: MockScriptInput;
}

interface PingMessage {
  type: "advanced-network:mock-script-ping";
}

type AsyncFunctionConstructor = new (...args: string[]) => (
  input: MockScriptInput
) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {
  // Intentionally empty; used only to obtain the async function constructor in sandbox.
}).constructor as AsyncFunctionConstructor;

window.addEventListener("message", (event: MessageEvent<RunMockScriptMessage | PingMessage>) => {
  const message = event.data;
  if (message?.type === "advanced-network:mock-script-ping") {
    notifyReady();
    return;
  }

  if (message?.type !== "advanced-network:run-mock-script") {
    return;
  }

  void executeScript(message)
    .then((result) =>
      window.parent.postMessage(
        {
          type: "advanced-network:mock-script-result",
          id: message.id,
          ok: true,
          result
        },
        "*"
      )
    )
    .catch((error) =>
      window.parent.postMessage(
        {
          type: "advanced-network:mock-script-result",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        "*"
      )
    );
});

notifyReady();

function notifyReady(): void {
  window.parent.postMessage({ type: "advanced-network:mock-script-ready" }, "*");
}

async function executeScript(message: RunMockScriptMessage): Promise<MockScriptOutput> {
  const fallback: MockScriptOutput = {
    status: message.input.response.status,
    headers: message.input.response.headers,
    body: message.input.response.body
  };
  const runner = new AsyncFunction(
    "input",
    `
const request = input.request;
const response = input.response;
${message.script}
if (typeof mock === "function") {
  return await mock(input);
}
return undefined;
`
  );

  const result = await runner(message.input);
  return normalizeMockScriptResult(result, fallback);
}

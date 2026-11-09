import "./test-page.css";

const output = document.querySelector<HTMLPreElement>("#output");

bind("fetchUsers", () => fetchJson("/fixtures/users.json"));
bind("fetchMissing", () => fetchJson("/fixtures/missing.json"));
bind("xhrUsers", () => xhr("/fixtures/users.json"));
bind("runAll", async () => {
  await fetchJson("/fixtures/users.json");
  await fetchJson("/fixtures/missing.json");
  await xhr("/fixtures/users.json");
});

function bind(id: string, handler: () => Promise<void>): void {
  const button = document.getElementById(id);
  if (!button) {
    throw new Error(`Missing button #${id}.`);
  }

  button.addEventListener("click", () => {
    void handler().catch((error) => log(`Error: ${formatError(error)}`));
  });
}

async function fetchJson(url: string): Promise<void> {
  const response = await fetch(`${url}?ts=${Date.now()}`, {
    headers: {
      "x-advanced-network-demo": "fetch"
    }
  });
  const text = await response.text();
  log(`fetch ${url} -> ${response.status}\n${text}`);
}

async function xhr(url: string): Promise<void> {
  const text = await new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", `${url}?xhr=1&ts=${Date.now()}`);
    request.setRequestHeader("x-advanced-network-demo", "xhr");
    request.addEventListener("load", () => resolve(`${request.status}\n${request.responseText}`));
    request.addEventListener("error", () => reject(new Error("XHR failed")));
    request.send();
  });

  log(`xhr ${url} -> ${text}`);
}

function log(text: string): void {
  if (!output) {
    return;
  }

  output.textContent = `${new Date().toLocaleTimeString()}\n${text}\n\n${output.textContent ?? ""}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

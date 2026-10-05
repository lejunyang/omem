import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function serverAddress() {
  const host =
    process.env.OMEM_HOST === "0.0.0.0"
      ? "127.0.0.1"
      : process.env.OMEM_HOST || "127.0.0.1";
  return (
    process.env.OMEM_URL || `http://${host}:${process.env.OMEM_PORT || 4317}`
  );
}

/** Node HTTP has no hidden five-minute response-header timeout for active Agent turns. */
export async function requestJson(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<any> {
  const url = new URL(path, serverAddress());
  if (!["http:", "https:"].includes(url.protocol))
    throw Error("服务地址必须使用 http 或 https");
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        signal,
        headers: {
          Accept: "application/json",
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
          ...(process.env.OMEM_TOKEN
            ? { Authorization: `Bearer ${process.env.OMEM_TOKEN}` }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if ((response.statusCode ?? 500) >= 400)
              reject(
                Error(
                  `HTTP ${response.statusCode}: ${value.error || value.message || JSON.stringify(value)}`,
                ),
              );
            else resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    if (timeoutMs)
      request.setTimeout(timeoutMs, () =>
        request.destroy(Error("服务长时间未响应；请运行 omem status 检查")),
      );
    request.on("error", (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
          ? Error(
              `无法连接 ${url.origin}；请先运行 omem service start 或检查 --url`,
            )
          : error,
      ),
    );
    request.end(data);
  });
}

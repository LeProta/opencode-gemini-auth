import { readResponseText } from "./bounded";

type BunRequestInit = RequestInit & { proxy?: string };

export function geminiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const proxy = process.env.OPENCODE_GEMINI_AUTH_PROXY;
  if (!proxy) {
    return fetch(input, init);
  }

  return fetch(input, {
    ...(init ?? {}),
    proxy,
  } as BunRequestInit);
}

const MAX_UPSTREAM_JSON_BYTES = 4 * 1024 * 1024;

/** JSON call to a Google API: bounded read, no redirects, timeout. */
export async function upstreamJson(
  url: string,
  { token, ua, body, method = "POST", timeoutMs = 15_000, extraHeaders }: {
    token?: string;
    ua: string;
    extraHeaders?: Record<string, string>;
    body?: unknown;
    method?: string;
    timeoutMs?: number;
  },
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "*/*", "User-Agent": ua, ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await geminiFetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readResponseText(res, MAX_UPSTREAM_JSON_BYTES, "Google API response");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { GEMINI_REDIRECT_URI } from "../constants";

export interface OAuthCallbackResponse {
  /**
   * Whether the callback succeeded and completed OAuth authentication.
   */
  ok: boolean;
  /**
   * HTTP status code to send back to the browser (defaults to 200 when `ok`, 400 otherwise).
   */
  status?: number;
  /**
   * Optional complete HTML document to render in the browser response.
   */
  html?: string;
  /**
   * Optional short failure explanation rendered in the fallback error page when `!ok`.
   */
  message?: string;
  /**
   * Whether this callback ends the listener wait (`true` by default). When `false`, the
   * listener sends the error response to the browser and continues waiting for another redirect.
   */
  terminal?: boolean;
}

export interface OAuthListenerOptions {
  /**
   * How long to wait for the OAuth redirect before timing out (in milliseconds).
   */
  timeoutMs?: number;
  /**
   * Optional override for the OAuth redirect URI (e.g. port 0 in tests).
   */
  redirectUri?: string;
  /**
   * Optional async handler invoked before writing the HTTP response so validation
   * and token exchange complete before reporting success to the browser.
   */
  onCallback?: (url: URL) => Promise<OAuthCallbackResponse> | OAuthCallbackResponse;
}

export interface OAuthListener {
  /**
   * Bound TCP port of the local HTTP listener.
   */
  readonly port: number;
  /**
   * Bound redirect URI matching the listening socket.
   */
  readonly redirectUri: string;
  /**
   * Resolves with the callback URL once Google redirects back to the local server.
   */
  waitForCallback(): Promise<URL>;
  /**
   * Cleanly stop listening for callbacks.
   */
  close(): Promise<void>;
}

const defaultRedirectUri = new URL(GEMINI_REDIRECT_URI);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderFailureResponse(message?: string): string {
  const detail = escapeHtml(
    message?.trim() || "Authentication could not be completed. Return to Opencode and try again.",
  );
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Opencode Gemini OAuth Failed</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: "Roboto", "Google Sans", arial, sans-serif;
        background: #f1f3f4;
        color: #202124;
      }
      main {
        width: min(448px, calc(100% - 3rem));
        background: #ffffff;
        border-radius: 28px;
        padding: 2.5rem 2.75rem;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.3), 0 2px 6px rgba(60, 64, 67, 0.15);
      }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; font-weight: 500; color: #c5221f; }
      p { margin: 0; font-size: 0.95rem; line-height: 1.5; color: #3c4043; word-break: break-word; }
      @media (prefers-color-scheme: dark) {
        body { background: #1f1f1f; color: #e8eaed; }
        main { background: #2d2e30; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
        h1 { color: #f28b82; }
        p { color: #bdc1c6; }
      }
    </style>
  </head>
  <body>
    <main role="main">
      <h1>Authentication failed</h1>
      <p>${detail}</p>
    </main>
  </body>
</html>`;
}

export interface OAuthCallbackRequestHandlerDeps {
  getOrigin: () => string;
  callbackPath: string;
  successResponse?: string;
  onCallback?: (url: URL) => Promise<OAuthCallbackResponse> | OAuthCallbackResponse;
  deliverCallback: (url: URL) => void;
  failPendingWaiters: (error: Error) => void;
}

/**
 * Builds the HTTP request handler used by `startOAuthListener` so callback
 * validation, HTML response rendering, and completion signaling stay testable
 * without opening external network sockets.
 */
export function createOAuthCallbackRequestHandler(
  deps: OAuthCallbackRequestHandlerDeps,
): (request: Pick<IncomingMessage, "url">, response: Pick<ServerResponse, "writeHead" | "end">) => void {
  const successHtml = deps.successResponse ?? "<!DOCTYPE html><html><body>You're connected to Opencode</body></html>";

  return (request, response) => {
    const finishResponse = (
      statusCode: number,
      headers: Record<string, string>,
      body: string,
      afterFlush?: () => void,
    ) => {
      response.writeHead(statusCode, { Connection: "close", ...headers });
      response.end(body, () => {
        afterFlush?.();
      });
    };

    if (!request.url) {
      finishResponse(400, { "Content-Type": "text/plain; charset=utf-8" }, "Invalid request");
      return;
    }

    const url = new URL(request.url, deps.getOrigin());
    if (url.pathname !== deps.callbackPath) {
      finishResponse(404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }

    const hasCode = !!url.searchParams.get("code");
    const hasState = !!url.searchParams.get("state");
    const hasError = !!url.searchParams.get("error");
    if (!hasError && (!hasCode || !hasState)) {
      finishResponse(
        400,
        { "Content-Type": "text/plain; charset=utf-8" },
        "Ignoring incomplete OAuth callback. Return to the Google sign-in flow.",
      );
      return;
    }

    if (!deps.onCallback) {
      finishResponse(200, { "Content-Type": "text/html; charset=utf-8" }, successHtml, () => {
        deps.deliverCallback(url);
      });
      return;
    }

    void (async () => {
      try {
        const reply = await deps.onCallback!(url);
        const status = reply.status ?? (reply.ok ? 200 : 400);
        const body = reply.html ?? (reply.ok ? successHtml : renderFailureResponse(reply.message));
        const shouldDeliver = reply.terminal !== false;
        finishResponse(status, { "Content-Type": "text/html; charset=utf-8" }, body, () => {
          if (shouldDeliver) {
            deps.deliverCallback(url);
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishResponse(
          500,
          { "Content-Type": "text/html; charset=utf-8" },
          renderFailureResponse(message),
          () => {
            deps.failPendingWaiters(error instanceof Error ? error : new Error(message));
          },
        );
      }
    })();
  };
}

/**
 * Starts a lightweight HTTP server that listens for the Gemini OAuth redirect
 * and resolves with the captured callback URL.
 */
export async function startOAuthListener(
  { timeoutMs = 5 * 60 * 1000, redirectUri: redirectUriOverride, onCallback }: OAuthListenerOptions = {},
): Promise<OAuthListener> {
  const parsedRedirectUri = redirectUriOverride ? new URL(redirectUriOverride) : defaultRedirectUri;
  const callbackPath = parsedRedirectUri.pathname || "/";
  const requestedPort = parsedRedirectUri.port
    ? Number.parseInt(parsedRedirectUri.port, 10)
    : parsedRedirectUri.protocol === "https:"
    ? 443
    : 80;
  let boundPort = requestedPort;
  let origin = `${parsedRedirectUri.protocol}//${parsedRedirectUri.host}`;

  const callbackQueue: URL[] = [];
  const callbackWaiters: Array<{
    resolve: (url: URL) => void;
    reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | undefined;

const successResponse = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Opencode Gemini OAuth</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: "Roboto", "Google Sans", arial, sans-serif;
        background: #f1f3f4;
        color: #202124;
      }
      main {
        width: min(448px, calc(100% - 3rem));
        background: #ffffff;
        border-radius: 28px;
        padding: 2.5rem 2.75rem;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.3), 0 2px 6px rgba(60, 64, 67, 0.15);
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
      }
      .logo {
        width: 40px;
        height: 40px;
        display: inline-flex;
      }
      .logo svg {
        width: 100%;
        height: 100%;
      }
      .brand {
        font-size: 1.1rem;
        font-weight: 500;
        letter-spacing: 0.01em;
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 1.75rem;
        font-size: 1.05rem;
        line-height: 1.6;
        color: #3c4043;
      }
      .note {
        margin: 1.5rem 0 0;
        font-size: 0.92rem;
        color: #5f6368;
      }
      .action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.65rem 1.85rem;
        border-radius: 999px;
        background: #1a73e8;
        color: #ffffff;
        font-weight: 500;
        font-size: 0.95rem;
        letter-spacing: 0.02em;
        text-decoration: none;
        transition: box-shadow 0.2s ease, transform 0.2s ease;
      }
      .action:hover {
        transform: translateY(-1px);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(60, 64, 67, 0.15);
      }
      .action:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.3);
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #131314;
          color: #e8eaed;
        }
        main {
          background: #202124;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4);
        }
        p {
          color: #e8eaed;
        }
        .note {
          color: #bdc1c6;
        }
        .action {
          background: #8ab4f8;
          color: #202124;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 46 46" xmlns="http://www.w3.org/2000/svg" role="img">
            <title>Gemini linked to Opencode</title>
            <path fill="#4285F4" d="M43.6 23.5c0-1.5-.1-3-.4-4.4H23v8.3h11.6c-.5 2.8-2 5.1-4.2 6.7v5.5h6.8c4-3.7 6.4-9.1 6.4-16.1z"/>
            <path fill="#34A853" d="M23 45c5.8 0 10.6-1.9 14.1-5.2l-6.8-5.5c-1.9 1.3-4.3 2-7.3 2-5.6 0-10.4-3.7-12.1-8.7H3.8v5.6C7.3 39.9 14.6 45 23 45z"/>
            <path fill="#FBBC04" d="M10.9 28.6c-.5-1.3-.8-2.7-.8-4.1 0-1.5.3-2.8.8-4.1v-5.6H3.8C2.3 17.7 1.5 20.2 1.5 24s.8 6.3 2.3 9.2l6.9-5.6z"/>
            <path fill="#EA4335" d="M23 9.5c3.2 0 6 .9 8.3 2.7l6.2-6.2C33.6 2.2 28.8 0 23 0 14.6 0 7.3 5.1 3.8 12.4l7.1 5.6c1.7-5 6.5-8.5 12.1-8.5z"/>
          </svg>
        </span>
        <span class="brand">Gemini linked to Opencode</span>
      </header>
      <h1>You're connected to Opencode</h1>
      <p>Your Google account is now linked to Opencode. You can close this window and continue in the CLI.</p>
      <a class="action" href="javascript:window.close()">Close window</a>
      <p class="note">Need to reconnect later? Re-run the authentication command in Opencode.</p>
    </main>
  </body>
</html>`;

  const deliverCallback = (url: URL) => {
    const waiter = callbackWaiters.shift();
    if (waiter) {
      waiter.resolve(url);
      return;
    }
    callbackQueue.push(url);
  };

  const failPendingWaiters = (error: Error) => {
    if (terminalError) {
      return;
    }
    terminalError = error;
    while (callbackWaiters.length > 0) {
      callbackWaiters.shift()?.reject(error);
    }
  };

  const timeoutHandle = setTimeout(() => {
    failPendingWaiters(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();

  const server = createServer(
    createOAuthCallbackRequestHandler({
      getOrigin: () => origin,
      callbackPath,
      successResponse,
      onCallback,
      deliverCallback,
      failPendingWaiters,
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("error", handleError);
      reject(error);
    };
    server.once("error", handleError);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", handleError);
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
        const responseHost = parsedRedirectUri.hostname || "127.0.0.1";
        origin = `${parsedRedirectUri.protocol}//${responseHost}:${boundPort}`;
      }
      resolve();
    });
  });

  const resolvedRedirectUri = new URL(callbackPath, origin).toString();

  server.on("error", (error) => {
    failPendingWaiters(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    port: boundPort,
    redirectUri: resolvedRedirectUri,
    waitForCallback: async () => {
      if (callbackQueue.length > 0) {
        return callbackQueue.shift() as URL;
      }
      if (terminalError) {
        throw terminalError;
      }
      return await new Promise<URL>((resolve, reject) => {
        callbackWaiters.push({ resolve, reject });
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeIdleConnections?.();
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          failPendingWaiters(new Error("OAuth listener closed before callback"));
          resolve();
        });
      }),
  };
}

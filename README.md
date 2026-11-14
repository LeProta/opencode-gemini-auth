# Google subscription OAuth for OpenCode

Use your **Google AI Pro / Ultra** subscription with OpenCode's built-in **Google**
provider, the way [ex-machina/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth)
does for Claude Pro/Max: same provider, same model ids (`google/gemini-3.8-flash`,
`google/gemini-2.5-pro`, …), same effort variants, signed in with Google OAuth instead
of an API key.

Requests go through the Antigravity (Cloud Code) surface the Antigravity app uses, so
they draw on the subscription quota, not on API credit.

> [!WARNING]
> This uses the Antigravity app's public OAuth client outside the official app. Google's
> [Antigravity terms](https://antigravity.google/terms) (section 6, read 2026-11-14) say
> that using third-party software or tools to access the service breaks the agreement and
> may get the Antigravity and/or Gemini CLI account suspended or terminated. Nothing in
> this plugin, including the client version it reports, makes this use permitted or
> protects the account, and Google may change the surface at any time. Use at your own
> discretion; an API key is the supported, low-risk option.

## Version support

| Component | Verified with |
|-----------|---------------|
| OpenCode  | v2 plugin API (`plugins` key), desktop/CLI 2.2.7 |
| Bun       | 1.4.4 (the runtime embedded in OpenCode 2.2.7) |
| Node      | imports cleanly (`bun run smoke:node-import`) |

OpenCode v1 (`plugin` key) is not supported.

## Versioning

Both LeProta OAuth plugins use `MAJOR.MINOR.PATCH` in `package.json` and
`vMAJOR.MINOR.PATCH` for GitHub tags. Increment the major for incompatible changes,
the minor for compatible features, and the patch for fixes or documentation updates.
Each plugin advances independently; matching numbers do not imply matching features.
Fork versions are independent of upstream versions and client versions sent to APIs.

Version `2.3.0` changed the sign-in: Google's page shows a code that you paste into
OpenCode, on a desktop as over SSH, as with the Claude login. The plugin no longer listens
on `localhost:51121` and no longer opens the browser itself. Connections already stored
keep working.

Version `2.3.1` rebuilds the headers of each model request from the Antigravity client
profile, so headers added by OpenCode or its SDK no longer reach Google, and only reports a
client version that is a plain `x.y.z`, whether it comes from the override, the cache or
Google's manifest.

Since `2.1.2` it also fixes: classifying a 429/5xx answer over 1 MB could hold the response forever;
reasoning was turned off when the request asked for it without a level or budget; two cache writes
made together lost one; a response arriving after a plugin reload stayed wrapped; the
first request of the day waited for Google's version manifest. The sign-in now uses PKCE.
A refresh token Google refuses with `invalid_grant` (expired or revoked) is not sent
again until OpenCode restarts or you sign in again; network errors and other answers
are still retried. Token answers that are not tokens (RFC 6749 Appendix A) or carry an
unusable expiry are refused, and a token refresh no longer waits for the version manifest.

## Install

```bash
opencode plugin add github:LeProta/opencode-gemini-auth#v2.3.1
```

Pin a tag: `github:LeProta/opencode-gemini-auth` alone follows `main`. To update, change
the tag (or run `opencode plugin update`); to roll back, install the previous tag.

`dist/` is committed because OpenCode installs GitHub plugins without building them.

## Sign in

```bash
opencode auth login google --method antigravity
```

or **Google → Google AI Pro/Ultra** in `/connect`. It works like the Claude Pro/Max login,
on a desktop as over SSH:

1. OpenCode shows Google's sign-in address. Open it and sign in.
2. Google sends you to its **Google Antigravity Authentication** page
   (`https://antigravity.google/oauth-callback`), which shows a code.
3. Paste that code into OpenCode.

This is the code mode of the Antigravity CLI (the one it uses over SSH). The plugin starts
no local server and does not wait for a `localhost` redirect.

The page shows the code without the `state`, so the code is bound to the sign-in with PKCE
(S256), as Google's
[desktop-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
asks: the client secret is public, so a code alone must not be enough to get tokens. A code
from another sign-in is refused by Google, and a pasted address that carries a `state` is
checked against this sign-in before anything is sent.

## What it does while this login is Google's active connection

- **Models**: the Google models your subscription serves stay listed under their usual
  ids; the others are hidden. The list is your account's catalog (kept per account, so
  switching accounts switches the list) and refreshes live.
- **Effort variants**: OpenCode's `low` / `medium` / `high` variants pick the matching
  upstream id (`gemini-3.8-flash` + `low` → `gemini-3.8-flash-low`); without a variant
  the strongest effort is used.
- **Reasoning** is streamed and shown by OpenCode.
- **Prices** are zeroed (usage is covered by the subscription).
- **Retries**: 429 / 503 honour Google's `RetryInfo`, wait out cooldowns and stop on
  terminal quota or capacity errors. Retry state is kept per session, agent and model.
- **Quota**: `/gquota` (and the `google_quota` tool) shows the weekly and 5-hour pools.
- **Tokens**: OpenCode refreshes the access token through the plugin; a token revoked
  early (401) is refreshed once, the request replayed, and the new token reused.

With an API key connected instead, the plugin leaves the Google provider alone.

## Configuration

| Variable | Effect |
|----------|--------|
| `OPENCODE_ANTIGRAVITY_VERSION` | Forces the Antigravity client version reported upstream (`x.y.z`). A malformed value is ignored with an error line. Default: read live from Google's updater manifest (cached 6 h), then a bundled fallback. |
| `OPENCODE_ANTIGRAVITY_UPDATE_CHECK=0` | Turns off the daily CLIProxyAPI change check. |
| `OPENCODE_GEMINI_MAX_RETRY_MS` | Longest server-requested retry delay to wait for. |
| `OPENCODE_GEMINI_AUTH_PROXY` | HTTP proxy for the plugin's own requests. |
| `OPENCODE_GEMINI_DEBUG=1` | Logs each request's URL, status, timing, trace id, masked headers, the model mapping and the final `generationConfig` to the plugin's log directory. No prompt, answer or tool result. |
| `OPENCODE_GEMINI_DEBUG_CONTENT=1` | With `OPENCODE_GEMINI_DEBUG=1`: also logs request and response body previews and a 4 KB raw response excerpt. These contain your prompts and answers (tokens stay redacted): turn it on only to diagnose a problem. |

The log directory and its files are created for your user only (`0700` / `0600`) on
Linux and macOS; on Windows they inherit the permissions of the OpenCode data directory.

## How it works

`src/index.ts` registers the `antigravity` OAuth method on OpenCode's `google`
integration and three session hooks on the Google provider:

1. **http.request** — maps the model id on the account's catalog, rewrites the Gemini
   API call into an Antigravity envelope (`src/transform.ts`, `src/wire.ts`), and sends
   it to `daily-cloudcode-pa.googleapis.com` only (any other origin is refused,
   redirects too). The envelope and the headers are built by the plugin: nothing the
   caller put there is forwarded. Thought signatures returned by Google are opaque and go
   back unchanged; Google has no request signature to compute (nothing like Claude Code's
   `cch`).
2. **http.response** — 401 replay, quota classification, then unwraps the envelope back
   into Gemini API responses; SSE is transformed at the consumer's pace with bounded
   buffers.
3. **retry** — OpenCode's retry decision, using Google's delays.

Every network read is size-bounded (`src/bounded.ts`); token responses are validated
before they reach OpenCode's credential store.

### Keeping up with Google

The client version is read live from Google's updater manifest. The rest of the wire
format lives in `src/wire.ts`, mirrored from
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI); the last reviewed commit of
each mirrored file is in `src/upstream.ts`. At startup (at most once a day) the plugin
checks GitHub and warns when one of them changed. It never downloads or runs code.

```bash
bun run check:cliproxy               # unreviewed commits, with diff links
bun run check:cliproxy -- --accept   # after porting them into src/wire.ts and testing
```

## Development

```bash
bun install
bun run check     # tsc + Biome lint + bun test
bun run bundle    # rebuild dist/ (commit it)
```

Run them with the Bun that OpenCode embeds (see Version support): with Bun 1.3.14 on
Windows `AbortSignal.timeout()` never fires in an idle `bun test` and `bounded.test.ts`
hangs. Tests use a temporary `OPENCODE_DATA_DIR` (`src/test-preload.ts`), never your real
plugin cache.

## Publishing

Bump `version` in `package.json`, `bun run check && bun run bundle`, commit `dist/`, tag
`vX.Y.Z` and push `main` and the tag. The plugin is installed from the GitHub tag; it is
not published to npm (the `opencode-gemini-auth` package there belongs to the upstream
project). CI (`.github/workflows/ci.yml`) runs the checks and fails when `dist/` does not
match the sources.

Credits: request handling started from
[opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth); stable
protocol helpers are vendored from
[dsh-gemini-oauth-bridge](https://github.com/hyqhyq3/dsh-gemini-oauth-bridge).

## License

MIT

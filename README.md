# Google subscription OAuth for OpenCode

Use your **Google AI Pro / Ultra** subscription with OpenCode's built-in **Google**
provider, the way the Claude subscription plugins do for Anthropic: same provider,
same model ids (`google/gemini-3.8-flash`, `google/gemini-2.5-pro`, …), same effort
variants, but signed in with Google OAuth instead of an API key.

Requests go through the Antigravity (Cloud Code) surface the Antigravity app uses, so
they draw on the subscription quota, not on API credit.

> [!WARNING]
> This uses the Antigravity app's public OAuth client outside the official app. Google
> does not sanction it, may restrict the account, or may change the surface at any time.
> Use at your own discretion; an API key is the low-risk option.

Requires **OpenCode V2** (the plugin ships only the V2 `./server` entry point).

## Install

```bash
opencode plugin add github:LeProta/opencode-gemini-auth
```

or, for a local checkout, `"plugins": ["file:///path/to/opencode-gemini-auth"]` in `opencode.json`.

`dist/` is committed, so nothing needs building to install. After changing the code, run
`bun run bundle` (or `npx tsup`) and commit `dist/`.

## Sign in

```bash
opencode auth login google --method antigravity
```

or **Google → OAuth with Google (AI Pro/Ultra)** in `/connect`. The browser callback
listens on `localhost:51121` (fixed by Google for this client); in a headless shell you
can paste the redirect URL or the code instead.

## What it does while the OAuth login is Google's active connection

- **Models**: the Google models your subscription serves stay listed under their usual
  ids and names; the others (e.g. Gemini 4 Argon, 3.1 Pro preview on a Pro account) are
  hidden. The list comes from your account's catalog and refreshes live.
- **Effort variants**: OpenCode's native `low` / `medium` / `high` variants pick the
  matching upstream id (`gemini-3.8-flash` + `low` → `gemini-3.8-flash-low`); without a
  variant the strongest effort is used.
- **Reasoning** is streamed and shown by OpenCode.
- **Prices** are zeroed (usage is covered by the subscription).
- **Retries**: 429 / 503 honour Google's `RetryInfo`, wait out cooldowns and stop on
  terminal quota.
- **Quota**: `/gquota` (and the `google_quota` tool) shows the weekly and 5-hour pools.

With an API key connected instead, the plugin leaves the Google provider alone.

## Keeping up with Google

The Antigravity client version (User-Agent) is read live from Google's updater
manifest. The rest of the wire format lives in `src/antigravity/wire.ts`, mirrored from
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI); the last reviewed commit of
each mirrored file is in `src/antigravity/upstream.ts`. At startup (at most once a day)
the plugin checks GitHub and warns when one of them changed. It never downloads or runs
code itself.

```bash
npm run check:cliproxy               # unreviewed commits, with diff links
npm run check:cliproxy -- --accept   # after porting them into wire.ts and testing
```

Set `OPENCODE_ANTIGRAVITY_UPDATE_CHECK=0` to turn the check off.

## Debugging

`OPENCODE_GEMINI_DEBUG=1` logs each request (redacted), the model mapping, the final
`generationConfig` and a raw response excerpt to the plugin's log directory.

## Development

```bash
bun test ./src/antigravity/models.test.ts   # run test files one by one on Windows
npx tsc --noEmit -p .
npx tsup
```

Credits: request handling started from
[opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth); stable
protocol helpers are vendored from
[dsh-gemini-oauth-bridge](https://github.com/hyqhyq3/dsh-gemini-oauth-bridge).

## License

MIT

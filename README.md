# Gemini OAuth Plugin for Opencode

![License](https://img.shields.io/npm/l/opencode-gemini-auth)
![Version](https://img.shields.io/npm/v/opencode-gemini-auth)

> [!WARNING]
> Google deprecated Gemini Code Assist consumer account access on June 18,
> 2026. The Gemini CLI OAuth flow no longer works for Gemini Code Assist for
> individuals, Google AI Pro, or Google AI Ultra accounts: Google stopped
> serving requests for these tiers and removed the "Login with Google" option.
> Google says Gemini Code Assist Standard and Enterprise subscriptions remain
> unchanged. The manual API key flow is also unaffected.
>
> Google has also stated that using Gemini CLI OAuth with third-party software
> is a policy-violating use case and may trigger abuse detection or account
> restrictions. Use this plugin at your own discretion. For the lowest-risk
> option, use Opencode with your own Gemini API key instead.
>
> Deprecation details: https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
> Policy discussion: https://github.com/google-gemini/gemini-cli/discussions/22970

**Authenticate the Opencode CLI with an eligible organization-backed Google
account.** Gemini CLI OAuth is now limited to Gemini Code Assist Standard and
Enterprise subscriptions. Personal plans and the free tier must use the native
Gemini API-key flow instead of this plugin.

## Prerequisites

- [Opencode CLI](https://opencode.ai) installed.
- A Gemini Code Assist Standard or Enterprise subscription. Consumer Google
  accounts are no longer supported by this OAuth flow.

## Installation

Add the plugin to your OpenCode configuration file
(`~/.config/opencode/opencode.json` or similar).

OpenCode V1:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

OpenCode V2:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-gemini-auth@latest"]
}
```

> [!IMPORTANT]
> Explicitly configure a Google Cloud `projectId` if you're using an
> organization-backed Gemini Code Assist subscription
> (`Standard`/`Enterprise`) or a company, school, or Google Workspace account.
> Most individual Google accounts should not need this. `Google AI Plus` is not
> a Gemini Code Assist subscription tier. You can still set `projectId` to
> force a specific project.

### OpenCode V2 Compatibility

OpenCode V2 loads the package's native `./server` entrypoint (`id: "Gemini OAuth Plugin"`,
targeting `@opencode/plugin@2.0.14` with runtime guards for `connection.status` on `2.0.31+`):

- **OAuth & Multi-Account Isolation**: Registers `gemini-cli` OAuth via `integration.transform`
  with an optional `projectId` form field in `/connect`, stores credential metadata (`email`,
  `projectId`, `managedProjectId`), formats connection labels, isolates project caches per
  account/connection, and shares cross-process locked token refresh with exponential/terminal
  backoff and `ctx.storage` persistence.
- **Provider Costs & Reloading**: Zeroes Google model billing costs (`model.cost = []`) via
  `provider.transform` only when the active `google` connection uses `gemini-cli` OAuth, and
  automatically reloads providers on `credential.updated` / `credential.switched` events.
- **Requests, 401 Replay & Retries**: Rewrites Cloud Code Assist requests (`settings.thinkingConfig`
  supported under `providers.google.settings` and model `settings`), replays once on HTTP `401`
  after forced token refresh, and honors Gemini quota/capacity fail-fast rules and `RetryInfo`
  delays via `session.hook("retry")` (configurable via `OPENCODE_GEMINI_MAX_RETRY_MS`, default
  `60000`).
- **Quota Inspection**: Registers both the `gemini_quota` tool and the `/gquota` command
  (`ctx.session.synthetic`) in V2 as well as V1.

TUI toast notifications (`MODEL_CAPACITY_EXHAUSTED` warning toasts and `OPENCODE_GEMINI_TEST_TOAST`)
remain V1-only.

## Usage

1. **Login**: Run `opencode auth login` on V1 or open `/connect` in OpenCode V2.

2. **Select Provider**: Choose **Google** from the list.
3. **Authenticate**: Select **OAuth with Google (Gemini CLI)** (and optionally enter a `projectId`
   in OpenCode V2 when using Standard, Enterprise, or Workspace accounts).
   - A browser window will open for you to approve the access.
   - The plugin spins up a temporary local server to capture the callback.
   - If the local server fails (e.g., port in use or headless environment),
     you can manually paste the callback URL or just the authorization code.

Once authenticated, Opencode will use your Google account for Gemini requests.

Check your current Gemini Code Assist quota buckets in both V1 and V2 with:

```bash
/gquota
```

## Antigravity (Google AI Pro / Ultra)

Gemini CLI OAuth no longer serves consumer subscriptions. This fork adds a second
provider, `google-antigravity`, that logs in through the **Antigravity** OAuth client
and talks to `daily-cloudcode-pa.googleapis.com` the way
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) does: `antigravity/hub/<version>
(aidev_client; …)` User-Agent with the live Hub version, `requestType: "agent"` envelope,
per-conversation `sessionId`, `loadCodeAssist`/`onboardUser` registration, and model
discovery via `fetchAvailableModels`. Stable helpers (OAuth client, forms, catalog parsing)
are vendored from [dsh-gemini-oauth-bridge](https://github.com/hyqhyq3/dsh-gemini-oauth-bridge).

1. `opencode auth login google-antigravity` (listed as **Google**) → *OAuth with Google (AI Pro/Ultra)*.
   The callback listens on `localhost:51121` (fixed by Google for this client).
2. Pick a model under **Google** (`google-antigravity/…`). On OpenCode V2 the list comes
   from your account and refreshes live; models known to OpenCode keep their built-in
   name, limits and effort variants. `<model>-low/-medium/-high` ids show up as one model
   with variants, and Claude `*-thinking` gets low/medium/high thinking budgets.
3. Reasoning is streamed and shown by OpenCode. `/gquota` shows the subscription's
   weekly and 5-hour quota pools.

This uses the Antigravity app's public OAuth client outside the official app. Google may
restrict the account or change the surface at any time.

**Staying in sync.** The Hub version and model list update themselves. The rest of the wire
format lives in `src/antigravity/wire.ts`, mirrored from four CLIProxyAPI files whose last
reviewed commits are recorded in `src/antigravity/upstream.ts`. At startup the plugin checks
GitHub (at most once a day) and shows a notice when one of those files changes. It never
downloads or runs code itself. To update:

```bash
npm run check:cliproxy               # lists unreviewed commits with diff links
npm run check:cliproxy -- --accept   # after porting the diff into wire.ts and running the tests
```

Set `OPENCODE_ANTIGRAVITY_UPDATE_CHECK=0` to turn the check off.

## Configuration

### Google Cloud Project

By default, the plugin attempts to provision or find a suitable Google Cloud
project. To force a specific project, set the `projectId` in your configuration
or via environment variables:

OpenCode V1:

```json
{
  "provider": {
    "google": {
      "options": {
        "projectId": "your-specific-project-id"
      }
    }
  }
}
```

OpenCode V2:

```json
{
  "providers": {
    "google": {
      "settings": {
        "projectId": "your-specific-project-id"
      }
    }
  }
}
```

You can also set `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or
`GOOGLE_CLOUD_PROJECT_ID` to supply the project ID via environment variables.

In V2, `OPENCODE_GEMINI_PROJECT_ID` overrides the configured project. The
generic Google variables are fallbacks used only when the provider has no
configured project, with `GOOGLE_CLOUD_PROJECT` before `GOOGLE_CLOUD_PROJECT_ID`.

### Proxy

If your network requires an HTTP proxy for Google API calls, set
`OPENCODE_GEMINI_AUTH_PROXY` before starting Opencode:

```bash
OPENCODE_GEMINI_AUTH_PROXY=http://127.0.0.1:8080 opencode
```

This is passed to Bun's `fetch` proxy option and applies to OAuth, token
refresh, project/quota lookup, and Gemini request forwarding.

### Model list

If you want to remove unusable models from the picker, use OpenCode's
`provider.google.whitelist` or `provider.google.blacklist` settings.

- `whitelist`: only show the listed model IDs.
- `blacklist`: hide specific model IDs from the default list.
- `models`: define or override model metadata/options, but does not remove the
  default models by itself.

Use the exact model IDs reported by `opencode models google` when building these
lists.

Example: keep only a small Gemini model list visible.

```json
{
  "provider": {
    "google": {
      "whitelist": [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-3-flash-preview",
        "gemini-3-pro-preview"
      ]
    }
  }
}
```

Example: hide a few unwanted defaults while keeping the rest.

```json
{
  "provider": {
    "google": {
      "blacklist": [
        "gemini-2.0-flash-exp",
        "gemini-1.5-pro"
      ]
    }
  }
}
```

Below are example model entries you can add under `provider.google.models` in your
Opencode config. Each model can include an `options.thinkingConfig` block to
enable "thinking" features.

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-2.5-flash": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        },
        "gemini-2.5-pro": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        },
        "gemini-3-flash-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
        "gemini-3-pro-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        }
      }
    }
  }
}
```

Note: Available model names and previews may change—check Google's documentation or
the Gemini product page for the current model identifiers.

### Thinking Models

The plugin supports configuring Gemini "thinking" features per-model via
`thinkingConfig` (under `options.thinkingConfig` in V1 or `settings.thinkingConfig` in V2).
The available fields depend on the model family:

- For Gemini 3 models: use `thinkingLevel` with values `"low"`, `"medium"`, `"high"`, etc.
- For Gemini 2.5 models: use `thinkingBudget` (token count, or `-1` for dynamic thinking budget).
- `includeThoughts` (boolean) controls whether the model emits internal thoughts.

A combined example showing both model types:

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
        "gemini-2.5-flash": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        }
      }
    }
  }
}
```

If you don't set a `thinkingConfig` for a model, the plugin will use default
behavior for that model.

The plugin also accepts request payloads that put `thinkingConfig` at the root
and normalizes them into `generationConfig.thinkingConfig` before forwarding to
Gemini Code Assist.

## Troubleshooting

### Manual Google Cloud Setup

If automatic provisioning fails, you may need to set up the project manually:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Gemini for Google Cloud API**
   (`cloudaicompanion.googleapis.com`).
4. Configure the `projectId` in your Opencode config as shown above.

### Quotas, Plans, and 429 Errors

Common causes of `429 RESOURCE_EXHAUSTED` or `QUOTA_EXHAUSTED`:

- **No project ID configured**: the plugin uses a managed free-tier project, which has lower quotas.
- **Model-specific limits**: quotas are tracked per model (e.g., `gemini-3-pro-preview` vs `gemini-3-flash-preview`).
- **Large prompts**: OAuth/Code Assist does not support cached content, so long system prompts and history can burn quota quickly.
- **Parallel sessions**: multiple Opencode windows can drain the same bucket.

Notes:

- **Gemini CLI auto-fallbacks**: the official CLI may fall back to Flash when Pro quotas are exhausted, so it can appear to “work” even if the Pro bucket is depleted.
- **Org-backed Code Assist subscriptions require a project**: if you're using Gemini Code Assist `Standard` or `Enterprise`, set `provider.google.options.projectId` (V1), `providers.google.settings.projectId` (V2), or `OPENCODE_GEMINI_PROJECT_ID` and re-authenticate.
- **Retry delay cap**: short per-minute rate-limit retries honor `OPENCODE_GEMINI_MAX_RETRY_MS` (default `60000` ms) in both V1 and V2; delays above the cap fail fast instead of stalling.

### Debugging

To view detailed logs of Gemini requests, responses, and OAuth token refreshes, set the
`OPENCODE_GEMINI_DEBUG` environment variable:

```bash
OPENCODE_GEMINI_DEBUG=1 opencode
```

Debug logs (`gemini-debug-<timestamp>.log` and `gemini-auth-YYYY-MM-DD.log`) are created lazily
inside `<opencode-data-dir>/gemini-auth/logs/` (`%LOCALAPPDATA%\opencode\gemini-auth\logs` on
Windows, `~/Library/Application Support/opencode/gemini-auth/logs` on macOS,
`$XDG_DATA_HOME/opencode/gemini-auth/logs` or `~/.local/share/opencode/gemini-auth/logs` on Linux;
override via `OPENCODE_DATA_DIR`), with tokens, API keys, and sensitive headers redacted.

## Parity Notes

This plugin mirrors the official Gemini CLI OAuth flow and Code Assist
endpoints. In particular, project onboarding and quota retry handling follow
the same behavior patterns as the Gemini CLI.

### References

- Gemini CLI repository: https://github.com/google-gemini/gemini-cli
- Gemini CLI quota documentation: https://developers.google.com/gemini-code-assist/resources/quotas

### Local upstream mirror (optional)

For local parity checks, you can keep a separate clone of the official
`gemini-cli` in this repo at `.local/gemini-cli`.

This mirror is intentionally untracked, so contributors must set it up once on
their machine:

```bash
git clone https://github.com/google-gemini/gemini-cli.git .local/gemini-cli
```

After setup, pull upstream updates with:

```bash
bun run update:gemini-cli
```

### Updating

Opencode does not automatically update plugins. To update to the latest version,
you must clear the cached plugin:

```bash
# Clear the specific plugin cache
rm -rf ~/.cache/opencode/node_modules/opencode-gemini-auth

# Run Opencode to trigger a fresh install
opencode
```

## Development

To develop on this plugin locally:

1. **Clone**:

   ```bash
   git clone https://github.com/jenslys/opencode-gemini-auth.git
   cd opencode-gemini-auth
   bun install
   ```

2. **Link**:
   Update your Opencode config to point to your local directory using a
   `file://` URL:

   ```json
   {
     "plugin": ["file:///absolute/path/to/opencode-gemini-auth"]
   }
   ```

## License

MIT

import { randomBytes } from "node:crypto";

import { formatRefreshParts, parseRefreshParts } from "../plugin/auth";
import { createOAuthAuthorizeMethod } from "../plugin/oauth-authorize";
import { exchangeCode, refreshModels, resolveProject } from "./client";
import { buildAuthUrl, callbackUrl } from "./vendor/protocol.js";

/**
 * Google sign-in with the Antigravity OAuth client (callback on localhost:51121),
 * then Code Assist registration so the project id travels with the refresh token.
 */
export const authorizeAntigravity = createOAuthAuthorizeMethod({
  redirectUri: callbackUrl(),
  authorizeFn: async () => {
    const state = randomBytes(32).toString("hex");
    return { url: buildAuthUrl(state), verifier: "", state };
  },
  exchangeFn: (code) => exchangeCode(code),
  resolveProjectContextFn: async (auth, accessToken) => {
    const projectId = await resolveProject(accessToken);
    void refreshModels(accessToken, projectId);
    const { refreshToken } = parseRefreshParts(auth.refresh);
    return { auth: { ...auth, refresh: formatRefreshParts({ refreshToken, projectId }) } };
  },
});

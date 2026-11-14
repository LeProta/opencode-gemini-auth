/**
 * Cloud Code Assist endpoint `prepareGeminiRequest` targets; `toAntigravityRequest`
 * then re-points it at the Antigravity base (daily channel).
 */
export const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/**
 * Google-hosted page that shows the authorization code to paste: the redirect of every sign-in.
 * The Antigravity CLI 1.5.9 uses it when no local browser can reach its listener (its
 * `LOGIN_SESSION_MODE_AUTH_CODE`), and Google accepts it as a registered redirect of the
 * Antigravity client.
 */
export const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";

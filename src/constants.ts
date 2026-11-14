/**
 * Cloud Code Assist endpoint `prepareGeminiRequest` targets; `toAntigravityRequest`
 * then re-points it at the Antigravity base (daily channel).
 */
export const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** Default for the local OAuth listener; the Antigravity flow always passes its own. */
export const GEMINI_REDIRECT_URI = "http://localhost:51121/oauth-callback";

/**
 * Google-hosted page that shows the authorization code to paste. The Antigravity CLI 1.5.9
 * uses it when no local browser can reach the listener (its `LOGIN_SESSION_MODE_AUTH_CODE`),
 * and Google accepts it as a registered redirect of the Antigravity client.
 */
export const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";

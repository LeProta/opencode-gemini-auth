/**
 * Cloud Code Assist endpoint `prepareGeminiRequest` targets; `toAntigravityRequest`
 * then re-points it at the Antigravity base (daily channel).
 */
export const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** Default for the local OAuth listener; the Antigravity flow always passes its own. */
export const GEMINI_REDIRECT_URI = "http://localhost:51121/oauth-callback";

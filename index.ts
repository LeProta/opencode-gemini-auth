export {
  GeminiCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";

export { GeminiAntigravityPlugin } from "./src/antigravity/plugin";

export {
  authorizeGemini,
  exchangeGeminiWithVerifier,
} from "./src/gemini/oauth";

export type {
  GeminiAuthorization,
  GeminiTokenExchangeResult,
} from "./src/gemini/oauth";

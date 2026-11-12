import { Plugin } from '@opencode/plugin';

/**
 * OpenCode V2 plugin: Google AI Pro / Ultra subscription OAuth for the built-in
 * Google provider.
 *
 * Like the Claude subscription plugins do for Anthropic, nothing new is added to
 * the model picker: the plugin registers an OAuth method on OpenCode's own `google`
 * integration and, while that login is the active connection, sends the built-in
 * Google models through the Antigravity (Cloud Code) surface instead of the Gemini
 * API. With an API key connected the plugin stays out of the way.
 */

declare const _default: Plugin.Plugin;

export { _default as default };

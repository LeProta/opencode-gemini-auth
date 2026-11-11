import { randomUUID } from "node:crypto";

import { isRecord, pickString } from "./shared";

const PROCESS_SESSION_ID = randomUUID();

function resolveUserPromptId(payload: Record<string, unknown>, request?: Record<string, unknown>): string {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : undefined;
  const requestExtra = isRecord(request?.extra_body) ? request.extra_body : undefined;

  return (
    pickString(
      payload.user_prompt_id,
      payload.userPromptId,
      payload.prompt_id,
      payload.promptId,
      payload.request_id,
      payload.requestId,
      request?.user_prompt_id,
      request?.userPromptId,
      request?.prompt_id,
      request?.promptId,
      request?.request_id,
      request?.requestId,
      extra?.user_prompt_id,
      extra?.userPromptId,
      extra?.prompt_id,
      extra?.promptId,
      extra?.request_id,
      extra?.requestId,
      requestExtra?.user_prompt_id,
      requestExtra?.userPromptId,
      requestExtra?.prompt_id,
      requestExtra?.promptId,
      requestExtra?.request_id,
      requestExtra?.requestId,
    ) ?? randomUUID()
  );
}

function resolveSessionId(payload: Record<string, unknown>, request?: Record<string, unknown>): string {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : undefined;
  const requestExtra = isRecord(request?.extra_body) ? request.extra_body : undefined;
  return (
    pickString(
      request?.session_id,
      request?.sessionId,
      payload.session_id,
      payload.sessionId,
      extra?.session_id,
      extra?.sessionId,
      requestExtra?.session_id,
      requestExtra?.sessionId,
    ) ?? PROCESS_SESSION_ID
  );
}

function stripPromptIdentifierAliases(payload: Record<string, unknown>, keepCanonical = false): void {
  if (!keepCanonical) {
    delete payload.user_prompt_id;
  }
  delete payload.userPromptId;
  delete payload.prompt_id;
  delete payload.promptId;
  delete payload.request_id;
  delete payload.requestId;
}

function stripSessionIdentifierAliases(payload: Record<string, unknown>, keepCanonical = false): void {
  if (!keepCanonical) {
    delete payload.session_id;
  }
  delete payload.sessionId;
}

function stripExtraBodyIdentifierAliases(payload: Record<string, unknown>): void {
  if (!isRecord(payload.extra_body)) {
    return;
  }

  const extra = { ...payload.extra_body };
  stripPromptIdentifierAliases(extra, false);
  stripSessionIdentifierAliases(extra, false);

  if (Object.keys(extra).length === 0) {
    delete payload.extra_body;
  } else {
    payload.extra_body = extra;
  }
}

/**
 * Applies canonical identifiers for wrapped Code Assist payloads.
 *
 * `user_prompt_id` and `session_id` are first-class identifiers in Gemini CLI
 * request envelopes used for traceability, usage accounting, and support diagnostics.
 */
export function normalizeWrappedIdentifiers(
  wrapped: Record<string, unknown>,
): { userPromptId: string; sessionId: string } {
  const request = isRecord(wrapped.request) ? { ...wrapped.request } : {};
  const userPromptId = resolveUserPromptId(wrapped, request);
  const sessionId = resolveSessionId(wrapped, request);

  request.session_id = sessionId;
  stripSessionIdentifierAliases(request, true);
  stripPromptIdentifierAliases(request, false);
  stripExtraBodyIdentifierAliases(request);
  wrapped.request = request;

  wrapped.user_prompt_id = userPromptId;
  stripPromptIdentifierAliases(wrapped, true);
  stripSessionIdentifierAliases(wrapped, false);
  stripExtraBodyIdentifierAliases(wrapped);

  return { userPromptId, sessionId };
}

/**
 * Applies canonical identifiers for unwrapped request payloads before wrapping.
 *
 * We normalize aliases here so downstream logic has a single source of truth.
 */
export function normalizeRequestPayloadIdentifiers(
  payload: Record<string, unknown>,
): { userPromptId: string; sessionId: string } {
  const userPromptId = resolveUserPromptId(payload);
  const sessionId = resolveSessionId(payload);

  payload.session_id = sessionId;
  stripSessionIdentifierAliases(payload, true);
  stripPromptIdentifierAliases(payload, false);
  stripExtraBodyIdentifierAliases(payload);

  return { userPromptId, sessionId };
}

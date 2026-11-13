import { randomUUID } from "node:crypto";

import { getGeminiModelCapabilities } from "./model-config";
import { isRecord, readString } from "./shared";

interface GeminiFunctionCallPart {
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface OpenAIToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenAIMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
}

const THOUGHT_SIGNATURE_FALLBACK = "skip_thought_signature_validator";
const INTERRUPTED_TOOL_ERROR = "Tool call was interrupted before receiving a response.";

function makeFunctionCallId(name: string): string {
  return `${name}__${randomUUID()}`;
}

/**
 * Transforms OpenAI `tool_calls` to Gemini `functionCall` parts.
 */
export function transformOpenAIToolCalls(
  requestPayload: Record<string, unknown>,
  modelId?: string,
): void {
  const messages = requestPayload.messages;
  if (!messages || !Array.isArray(messages)) {
    return;
  }

  const capabilities = modelId ? getGeminiModelCapabilities(modelId) : undefined;
  const usesIds = capabilities ? capabilities.usesFunctionCallIds : true;
  const needsSignatureFallback = capabilities
    ? capabilities.requiresThoughtSignatureFallback
    : true;

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    const msgObj = message as OpenAIMessage;
    const toolCalls = msgObj.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }

    const parts: GeminiFunctionCallPart[] = [];
    if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
      parts.push({ text: msgObj.content });
    }

    let attachedSignatureFallback = false;
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const fn = toolCall.function;
      if (!isRecord(fn)) {
        continue;
      }

      const resolvedName = readString(fn.name) ?? "";
      const args = parseJsonObject(fn.arguments);
      const functionCall: NonNullable<GeminiFunctionCallPart["functionCall"]> = {
        name: resolvedName,
        args,
      };
      if (usesIds) {
        functionCall.id = readString(toolCall.id) ?? makeFunctionCallId(resolvedName);
      }

      const part: GeminiFunctionCallPart = { functionCall };
      if (needsSignatureFallback && !attachedSignatureFallback) {
        part.thoughtSignature = THOUGHT_SIGNATURE_FALLBACK;
        attachedSignatureFallback = true;
      }

      parts.push(part);
    }

    msgObj.parts = parts;
    delete msgObj.tool_calls;
    delete msgObj.content;
  }
}

/**
 * Adds model-appropriate functionCall IDs and synthetic thoughtSignature fallbacks
 * in both flat and wrapped payloads without overwriting existing signatures.
 */
export function addThoughtSignaturesToFunctionCalls(
  requestPayload: Record<string, unknown>,
  modelId?: string,
): void {
  const capabilities = modelId ? getGeminiModelCapabilities(modelId) : undefined;
  const usesIds = capabilities ? capabilities.usesFunctionCallIds : true;
  const needsSignatureFallback = capabilities
    ? capabilities.requiresThoughtSignatureFallback
    : true;

  const processContents = (contents: unknown): void => {
    if (!contents || !Array.isArray(contents)) {
      return;
    }

    for (const content of contents) {
      if (!isRecord(content)) {
        continue;
      }

      const parts = content.parts;
      if (!parts || !Array.isArray(parts)) {
        continue;
      }

      let hasTurnSignature = parts.some(
        (part) =>
          isRecord(part) &&
          isRecord(part.functionCall) &&
          typeof part.thoughtSignature === "string" &&
          part.thoughtSignature.length > 0,
      );

      for (const part of parts) {
        if (!isRecord(part) || !isRecord(part.functionCall)) {
          continue;
        }
        if (needsSignatureFallback && !hasTurnSignature) {
          part.thoughtSignature = THOUGHT_SIGNATURE_FALLBACK;
          hasTurnSignature = true;
        }
        const fc = part.functionCall;
        if (usesIds && !readString(fc.id)) {
          fc.id = makeFunctionCallId(readString(fc.name) ?? "");
        }
      }
    }
  };

  processContents(requestPayload.contents);
  if (isRecord(requestPayload.request)) {
    processContents(requestPayload.request.contents);
  }
}

interface PendingFunctionCall {
  id?: string;
  name: string;
}

function makePlaceholderFunctionResponse(
  call: PendingFunctionCall,
  usesIds: boolean,
): Record<string, unknown> {
  const functionResponse: Record<string, unknown> = {
    name: call.name,
    response: { error: INTERRUPTED_TOOL_ERROR },
  };
  if (usesIds && call.id) {
    functionResponse.id = call.id;
  }
  return { functionResponse };
}

function takeMatchingPendingCallIndex(
  pendingCalls: PendingFunctionCall[],
  functionResponse: Record<string, unknown>,
): number {
  const responseId = readString(functionResponse.id);
  if (responseId) {
    const byId = pendingCalls.findIndex((call) => call.id === responseId);
    if (byId !== -1) {
      return byId;
    }
  }
  const responseName = readString(functionResponse.name) ?? "";
  return pendingCalls.findIndex((call) => call.name === responseName);
}

/**
 * Losslessly repairs adjacent functionCall/functionResponse pairs in Gemini contents:
 * strips orphan functionResponse parts and inserts placeholder user functionResponse
 * turns for unanswered model functionCalls without mutating model turns.
 */
export function repairGeminiToolPairs(contents: unknown[], modelId?: string): unknown[] {
  const capabilities = modelId ? getGeminiModelCapabilities(modelId) : undefined;
  const usesIds = capabilities ? capabilities.usesFunctionCallIds : true;

  const repaired: unknown[] = [];
  let pendingCalls: PendingFunctionCall[] = [];

  const flushPendingCalls = (): void => {
    if (pendingCalls.length === 0) {
      return;
    }
    repaired.push({
      role: "user",
      parts: pendingCalls.map((call) => makePlaceholderFunctionResponse(call, usesIds)),
    });
    pendingCalls = [];
  };

  for (const content of contents) {
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      flushPendingCalls();
      repaired.push(content);
      continue;
    }

    if (content.role === "model") {
      flushPendingCalls();
      for (const part of content.parts) {
        if (isRecord(part) && isRecord(part.functionCall)) {
          pendingCalls.push({
            id: readString(part.functionCall.id),
            name: readString(part.functionCall.name) ?? "",
          });
        }
      }
      repaired.push(content);
      continue;
    }

    const frParts: unknown[] = [];
    const otherParts: unknown[] = [];
    for (const part of content.parts) {
      if (isRecord(part) && isRecord(part.functionResponse)) {
        frParts.push(part);
      } else {
        otherParts.push(part);
      }
    }

    if (pendingCalls.length === 0) {
      if (otherParts.length > 0) {
        repaired.push(
          frParts.length === 0 ? content : { ...content, parts: otherParts },
        );
      }
      continue;
    }

    const matchedFrParts: unknown[] = [];
    for (const frPart of frParts) {
      const fnResp = (frPart as Record<string, unknown>).functionResponse as Record<
        string,
        unknown
      >;
      const matchIndex = takeMatchingPendingCallIndex(pendingCalls, fnResp);
      if (matchIndex !== -1) {
        pendingCalls.splice(matchIndex, 1);
        matchedFrParts.push(frPart);
      }
    }

    const missingPlaceholderParts = pendingCalls.map((call) =>
      makePlaceholderFunctionResponse(call, usesIds),
    );
    pendingCalls = [];

    const combinedFrParts = [...matchedFrParts, ...missingPlaceholderParts];
    if (matchedFrParts.length === 0 && otherParts.length > 0) {
      repaired.push({
        role: "user",
        parts: combinedFrParts,
      });
      repaired.push({
        ...content,
        parts: otherParts,
      });
    } else if (combinedFrParts.length > 0 || otherParts.length > 0) {
      repaired.push({
        ...content,
        parts: [...combinedFrParts, ...otherParts],
      });
    }
  }

  flushPendingCalls();
  return repaired;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

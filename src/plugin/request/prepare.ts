import { randomUUID } from "node:crypto";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "../../constants";
import { getGeminiModelCapabilities, type GeminiThinkingMode } from "../model-config";
import { normalizeThinkingConfig } from "../request-helpers";
import { normalizeRequestPayloadIdentifiers, normalizeWrappedIdentifiers } from "./identifiers";
import {
  addThoughtSignaturesToFunctionCalls,
  repairGeminiToolPairs,
  transformOpenAIToolCalls,
} from "./openai";
import {
  isGenerativeLanguageRequest,
  isRecord,
  parseGenerativeLanguageRequest,
  readString,
} from "./shared";

const STREAM_ACTION = "streamGenerateContent";

export interface ThinkingConfigDefaults {
  provider?: unknown;
  models?: Record<string, unknown>;
}

/**
 * Rewrites OpenAI-style requests into Gemini Code Assist request shape.
 */
export function prepareGeminiRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  thinkingConfigDefaults?: ThinkingConfigDefaults,
): {
  request: RequestInfo;
  init: RequestInit;
  streaming: boolean;
  requestedModel?: string;
} {
  const baseInit: RequestInit = { ...init };
  const resolvedHeadersSource =
    init?.headers !== undefined
      ? init.headers
      : input instanceof Request
        ? input.headers
        : undefined;
  const headers = new Headers(resolvedHeadersSource);

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  const requestTarget = parseGenerativeLanguageRequest(input);
  if (!requestTarget) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");

  const { requestedModel: rawModel, effectiveModel, action: rawAction } = requestTarget;
  const streaming = rawAction === STREAM_ACTION;
  const transformedUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${
    streaming ? "?alt=sse" : ""
  }`;

  let body = baseInit.body;

  if (typeof baseInit.body === "string" && baseInit.body) {
    const transformed = transformRequestBody(
      baseInit.body,
      projectId,
      effectiveModel,
      rawModel,
      thinkingConfigDefaults,
    );
    if (transformed.body) {
      body = transformed.body;
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  // The User-Agent is set by toAntigravityRequest (live Antigravity client version).

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
  };
}

function sanitizeRequestPayload(
  requestPayload: Record<string, unknown>,
  effectiveModel: string,
  requestedModel: string,
  thinkingConfigDefaults?: ThinkingConfigDefaults,
): void {
  const capabilities = getGeminiModelCapabilities(effectiveModel);
  const thinkingMode =
    capabilities.family === "unknown" ? undefined : capabilities.thinkingMode;

  transformOpenAIToolCalls(requestPayload, effectiveModel);
  stripThoughtPartsFromHistory(requestPayload);
  if (Array.isArray(requestPayload.contents)) {
    requestPayload.contents = repairGeminiToolPairs(requestPayload.contents, effectiveModel);
  }
  addThoughtSignaturesToFunctionCalls(requestPayload, effectiveModel);
  normalizeThinking(
    requestPayload,
    resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel),
    thinkingConfigDefaults?.provider,
    thinkingMode,
  );
  normalizeSystemInstruction(requestPayload);
  normalizeCachedContent(requestPayload);

  if ("model" in requestPayload) {
    delete requestPayload.model;
  }
}

function transformRequestBody(
  body: string,
  projectId: string,
  effectiveModel: string,
  requestedModel: string,
  thinkingConfigDefaults?: ThinkingConfigDefaults,
): { body?: string; userPromptId: string } {
  const fallbackId = randomUUID();
  try {
    const parsedBody: unknown = JSON.parse(body);
    if (!isRecord(parsedBody)) {
      return { userPromptId: fallbackId };
    }

    const isWrapped = typeof parsedBody.project === "string" && isRecord(parsedBody.request);
    if (isWrapped) {
      const requestPayload = { ...(parsedBody.request as Record<string, unknown>) };
      sanitizeRequestPayload(
        requestPayload,
        effectiveModel,
        requestedModel,
        thinkingConfigDefaults,
      );
      const wrappedBody: Record<string, unknown> = {
        ...parsedBody,
        model: effectiveModel,
        request: requestPayload,
      };
      const { userPromptId } = normalizeWrappedIdentifiers(wrappedBody);
      return { body: JSON.stringify(wrappedBody), userPromptId };
    }

    const requestPayload = { ...parsedBody };
    sanitizeRequestPayload(
      requestPayload,
      effectiveModel,
      requestedModel,
      thinkingConfigDefaults,
    );

    const { userPromptId } = normalizeRequestPayloadIdentifiers(requestPayload);
    const wrappedBody = {
      project: projectId,
      model: effectiveModel,
      user_prompt_id: userPromptId,
      request: requestPayload,
    };

    return { body: JSON.stringify(wrappedBody), userPromptId };
  } catch (error) {
    console.error("Failed to transform Gemini request body:", error);
    return { userPromptId: fallbackId };
  }
}

function resolveDefaultThinkingConfig(
  thinkingConfigDefaults: ThinkingConfigDefaults | undefined,
  requestedModel: string,
  effectiveModel: string,
): unknown {
  if (!thinkingConfigDefaults?.models) {
    return undefined;
  }

  return thinkingConfigDefaults.models[requestedModel] ?? thinkingConfigDefaults.models[effectiveModel];
}

function normalizeThinking(
  requestPayload: Record<string, unknown>,
  modelThinkingConfig: unknown,
  providerThinkingConfig: unknown,
  thinkingMode?: GeminiThinkingMode,
): void {
  const rawGenerationConfig = isRecord(requestPayload.generationConfig)
    ? { ...requestPayload.generationConfig }
    : undefined;
  const hasRootThinkingConfig = Object.prototype.hasOwnProperty.call(requestPayload, "thinkingConfig");
  const hasRequestThinkingConfig =
    hasRootThinkingConfig ||
    (!!rawGenerationConfig && Object.prototype.hasOwnProperty.call(rawGenerationConfig, "thinkingConfig"));

  const mergedDefaultThinking =
    isRecord(providerThinkingConfig) && isRecord(modelThinkingConfig)
      ? { ...providerThinkingConfig, ...modelThinkingConfig }
      : modelThinkingConfig ?? providerThinkingConfig;

  const sourceThinkingConfig = hasRootThinkingConfig
    ? requestPayload.thinkingConfig
    : hasRequestThinkingConfig
      ? rawGenerationConfig?.thinkingConfig
      : mergedDefaultThinking;

  const normalizedThinking = normalizeThinkingConfig(
    sourceThinkingConfig,
    thinkingMode ? { thinkingMode } : undefined,
  );
  if (hasRootThinkingConfig) {
    delete requestPayload.thinkingConfig;
  }
  if (normalizedThinking) {
    if (rawGenerationConfig) {
      rawGenerationConfig.thinkingConfig = normalizedThinking;
      requestPayload.generationConfig = rawGenerationConfig;
    } else {
      requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
    }
    return;
  }

  if (hasRequestThinkingConfig && rawGenerationConfig) {
    delete rawGenerationConfig.thinkingConfig;
    requestPayload.generationConfig = rawGenerationConfig;
  }
}

function normalizeSystemInstruction(requestPayload: Record<string, unknown>): void {
  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }
}

function normalizeCachedContent(requestPayload: Record<string, unknown>): void {
  const extraBody = isRecord(requestPayload.extra_body)
    ? { ...requestPayload.extra_body }
    : undefined;
  const cachedContentFromExtra = extraBody?.cached_content ?? extraBody?.cachedContent;
  const cachedContent =
    readString(requestPayload.cached_content) ??
    readString(requestPayload.cachedContent) ??
    readString(cachedContentFromExtra);

  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }

  delete requestPayload.cached_content;
  if (!extraBody) {
    return;
  }

  delete extraBody.cached_content;
  delete extraBody.cachedContent;
  if (Object.keys(extraBody).length === 0) {
    delete requestPayload.extra_body;
  } else {
    requestPayload.extra_body = extraBody;
  }
}

function stripThoughtPartsFromHistory(requestPayload: Record<string, unknown>): void {
  const contents = requestPayload.contents;
  if (!Array.isArray(contents)) {
    return;
  }

  const sanitizedContents: unknown[] = [];
  for (const content of contents) {
    if (!isRecord(content)) {
      sanitizedContents.push(content);
      continue;
    }

    const parts = Array.isArray(content.parts) ? content.parts : undefined;
    if (!parts) {
      sanitizedContents.push(content);
      continue;
    }

    let rescuedSignature: string | undefined;
    const keptParts: unknown[] = [];
    for (const part of parts) {
      if (isRecord(part) && part.thought === true) {
        if (!rescuedSignature) {
          rescuedSignature = readString(part.thoughtSignature);
        }
        continue;
      }
      keptParts.push(isRecord(part) ? { ...part } : part);
    }

    // Drop empty model turns produced by interrupted thought streaming.
    if (keptParts.length === 0 && content.role === "model") {
      continue;
    }

    if (rescuedSignature && content.role === "model") {
      const hasExistingSignature = keptParts.some(
        (part) => isRecord(part) && Boolean(readString(part.thoughtSignature)),
      );
      if (!hasExistingSignature) {
        const targetPart =
          keptParts.find((part) => isRecord(part) && isRecord(part.functionCall)) ??
          keptParts.find((part) => isRecord(part));
        if (isRecord(targetPart)) {
          targetPart.thoughtSignature = rescuedSignature;
        }
      }
    }

    sanitizedContents.push({
      ...content,
      parts: keptParts,
    });
  }

  requestPayload.contents = sanitizedContents;
}

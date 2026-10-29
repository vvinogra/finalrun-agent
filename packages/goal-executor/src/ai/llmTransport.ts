// LLMTransport — an alternative to AIAgent's built-in provider call.
//
// AIAgent normally sends each planner/grounder request to a provider API via
// the Vercel AI SDK. A transport replaces only that final call: prompt
// assembly, redaction, retries, parsing, and tracing stay in AIAgent. Used by
// `finalrun mcp`, where the MCP client (e.g. Claude Code) answers each request
// instead of a provider API, so no API key is needed.

import type { z } from 'zod';
import type { FeatureName } from '@finalrun/common';

/** One part of the user message sent to the LLM. `image` is base64. */
export type LLMUserPart = { type: 'text'; text: string } | { type: 'image'; image: string };

/** One fully assembled LLM request. Prompt text is already redacted. */
export interface LLMTransportRequest {
  feature: FeatureName;
  systemPrompt: string;
  userParts: LLMUserPart[];
  /** The response shape — the same schema the Anthropic path enforces (schemas.ts). */
  schema: z.ZodType;
}

export interface LLMTransportResponse {
  /** Parsed JSON response, normalized by AIAgent's planner/grounder parsers. */
  output: unknown;
  /** Raw response text, used for logging and parse-error messages. */
  text: string;
}

export interface LLMTransport {
  complete(request: LLMTransportRequest): Promise<LLMTransportResponse>;
}

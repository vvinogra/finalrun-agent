// LLMBridge — an LLMTransport answered by the MCP client instead of a
// provider API. Each AIAgent request is parked until the client answers it
// through the `respond` tool with JSON that satisfies the request's schema.

import { z } from 'zod';
import type { FeatureName } from '@finalrun/common';
import type {
  LLMTransport,
  LLMTransportRequest,
  LLMTransportResponse,
  LLMUserPart,
} from '@finalrun/goal-executor';

export interface BridgeRequest {
  readonly id: string;
  readonly feature: FeatureName;
  readonly systemPrompt: string;
  readonly userParts: LLMUserPart[];
  readonly schema: z.ZodType;
}

export type BridgeAnswer = { ok: true } | { ok: false; error: string };

interface ParkedRequest {
  request: BridgeRequest;
  resolve: (response: LLMTransportResponse) => void;
  reject: (error: Error) => void;
}

export class LLMBridge implements LLMTransport {
  private _nextId = 1;
  /** Parked requests not yet handed to the client, oldest first. */
  private _queued: ParkedRequest[] = [];
  /** Requests handed to the client and awaiting an answer. */
  private _open = new Map<string, ParkedRequest>();
  private _takers: Array<(request: BridgeRequest | undefined) => void> = [];
  private _closedReason: string | undefined;

  complete(request: LLMTransportRequest): Promise<LLMTransportResponse> {
    if (this._closedReason !== undefined) {
      return Promise.reject(new Error(this._closedReason));
    }
    return new Promise((resolve, reject) => {
      const parked: ParkedRequest = {
        request: { id: `r${this._nextId++}`, ...request },
        resolve,
        reject,
      };
      const taker = this._takers.shift();
      if (taker) {
        this._open.set(parked.request.id, parked);
        taker(parked.request);
      } else {
        this._queued.push(parked);
      }
    });
  }

  /** Resolves with the next request for the client, or undefined once closed. */
  take(): Promise<BridgeRequest | undefined> {
    const parked = this._queued.shift();
    if (parked) {
      this._open.set(parked.request.id, parked);
      return Promise.resolve(parked.request);
    }
    if (this._closedReason !== undefined) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this._takers.push(resolve);
    });
  }

  /** A request handed to the client and not yet answered. */
  openRequest(id: string): BridgeRequest | undefined {
    return this._open.get(id)?.request;
  }

  /**
   * Answer an open request. Output that fails the request's schema is
   * rejected and the request stays open, so the client can correct it.
   */
  answer(id: string, output: unknown): BridgeAnswer {
    const parked = this._open.get(id);
    if (!parked) {
      const open = [...this._open.keys()];
      return {
        ok: false,
        error:
          open.length > 0
            ? `No open request "${id}". Open requests: ${open.join(', ')}.`
            : `No open request "${id}".`,
      };
    }

    const value = unwrapOutputEnvelope(output);
    const parsed = parked.request.schema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Output does not match the ${parked.request.feature} schema:\n${z.prettifyError(parsed.error)}`,
      };
    }

    this._open.delete(id);
    parked.resolve({ output: value, text: JSON.stringify(value) });
    return { ok: true };
  }

  /** Fail every parked request and refuse new ones. */
  close(reason: string): void {
    if (this._closedReason !== undefined) {
      return;
    }
    this._closedReason = reason;
    const error = new Error(reason);
    for (const parked of [...this._queued, ...this._open.values()]) {
      parked.reject(error);
    }
    this._queued = [];
    this._open.clear();
    for (const taker of this._takers.splice(0)) {
      taker(undefined);
    }
  }
}

/**
 * The prompts teach the `{"output": {...}}` envelope (the OpenAI/Google
 * text-JSON convention) while schemas.ts describes the inner shape, so
 * accept both.
 */
function unwrapOutputEnvelope(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'output' && isRecord(value['output'])
    ? value['output']
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

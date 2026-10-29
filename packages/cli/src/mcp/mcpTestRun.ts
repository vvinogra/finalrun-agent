// McpTestRun — one test or suite run driven over MCP. Starts the run with an
// LLMBridge as its LLM transport and exposes it as a sequence of events for
// the MCP tools: each parked LLM request, then the final outcome.

import type { TestRunnerResult } from '../testRunner.js';
import { LLMBridge, type BridgeAnswer, type BridgeRequest } from './llmBridge.js';

/** Abort the run when the client leaves a request unanswered this long. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;

/** What a run start function resolves with once the run has completed. */
export interface McpRunResult {
  result: TestRunnerResult;
  /** Live report URL, when the local report server could be started. */
  reportUrl?: string;
}

export type RunOutcome =
  ({ kind: 'finished' } & McpRunResult) | { kind: 'failed'; message: string };

export type RunEvent = { kind: 'request'; request: BridgeRequest } | RunOutcome;

export interface RunStartContext {
  llmTransport: LLMBridge;
  abortSignal: AbortSignal;
}

export class McpTestRun {
  private readonly _bridge = new LLMBridge();
  private readonly _abortController = new AbortController();
  private readonly _outcome: Promise<RunOutcome>;
  private readonly _responseTimeoutMs: number;
  private _settled: RunOutcome | undefined;
  private _responseTimer: NodeJS.Timeout | undefined;

  constructor(
    start: (context: RunStartContext) => Promise<McpRunResult>,
    options?: { responseTimeoutMs?: number },
  ) {
    this._responseTimeoutMs = options?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this._outcome = start({
      llmTransport: this._bridge,
      abortSignal: this._abortController.signal,
    })
      .then(
        (completed): RunOutcome => ({ kind: 'finished', ...completed }),
        (error: unknown): RunOutcome => ({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((outcome) => {
        this._settled = outcome;
        this._clearResponseTimer();
        this._bridge.close('The run has finished.');
        return outcome;
      });
  }

  /** The outcome, once the run has settled. */
  get settled(): RunOutcome | undefined {
    return this._settled;
  }

  /** Wait for the next LLM request or, when none can arrive, the outcome. */
  async nextEvent(): Promise<RunEvent> {
    const event = await Promise.race([
      this._bridge
        .take()
        .then((request) => (request ? ({ kind: 'request', request } as const) : undefined)),
      this._outcome,
    ]);
    if (event?.kind === 'request') {
      this._armResponseTimer();
      return event;
    }
    return this._outcome;
  }

  openRequest(id: string): BridgeRequest | undefined {
    return this._bridge.openRequest(id);
  }

  answer(id: string, output: unknown): BridgeAnswer {
    const answer = this._bridge.answer(id, output);
    if (answer.ok) {
      this._clearResponseTimer();
    }
    return answer;
  }

  /**
   * Abort the run: open requests fail, the executor stops at its next step,
   * and the report is still written. Resolves once the run has cleaned up.
   */
  abort(reason: string): Promise<RunOutcome> {
    // Abort first so the executor is already flagged when the failed request
    // returns control to its loop.
    this._abortController.abort();
    this._bridge.close(reason);
    return this._outcome;
  }

  private _armResponseTimer(): void {
    this._clearResponseTimer();
    this._responseTimer = setTimeout(() => {
      const minutes = Math.round(this._responseTimeoutMs / 60_000);
      void this.abort(`No response from the MCP client within ${minutes} minutes; run aborted.`);
    }, this._responseTimeoutMs);
  }

  private _clearResponseTimer(): void {
    if (this._responseTimer) {
      clearTimeout(this._responseTimer);
      this._responseTimer = undefined;
    }
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { FEATURE_GROUNDER, FEATURE_PLANNER, type TestResult } from '@finalrun/common';
import type { LLMTransportRequest } from '@finalrun/goal-executor';
import { LLMBridge } from '../mcp/llmBridge.js';
import { McpTestRun, type McpRunResult } from '../mcp/mcpTestRun.js';
import { describeImage, formatOutcome, RequestFormatter } from '../mcp/requestFormatter.js';
import type { TestRunnerResult } from '../testRunner.js';

const plannerSchema = z.object({ action: z.object({ action_type: z.string() }) });

function plannerRequest(overrides?: Partial<LLMTransportRequest>): LLMTransportRequest {
  return {
    feature: FEATURE_PLANNER,
    systemPrompt: 'You are the planner.',
    userParts: [{ type: 'text', text: 'Test objective: log in' }],
    schema: plannerSchema,
    ...overrides,
  };
}

function runResult(status: TestRunnerResult['status']): McpRunResult {
  return {
    result: {
      success: status === 'success',
      status,
      runId: 'run-1',
      runDir: '/workspace/.finalrun/artifacts/run-1',
      runIndexPath: '/workspace/.finalrun/artifacts/runs.json',
      testResults: [
        {
          relativePath: 'auth/login.yaml',
          status,
          message: 'Logged in',
          analysis: 'Home screen shown',
        } as TestResult,
      ],
    },
  };
}

// ----------------------------------------------------------------------------
// LLMBridge
// ----------------------------------------------------------------------------

test('LLMBridge parks a request until the client answers it', async () => {
  const bridge = new LLMBridge();
  const pending = bridge.complete(plannerRequest());

  const request = await bridge.take();
  assert.equal(request?.id, 'r1');
  assert.equal(request?.feature, FEATURE_PLANNER);

  const output = { action: { action_type: 'tap' } };
  assert.deepEqual(bridge.answer('r1', output), { ok: true });
  assert.deepEqual(await pending, { output, text: JSON.stringify(output) });
});

test('LLMBridge hands a request to a client that is already waiting', async () => {
  const bridge = new LLMBridge();
  const taken = bridge.take();
  const pending = bridge.complete(plannerRequest());

  assert.equal((await taken)?.id, 'r1');
  bridge.answer('r1', { action: { action_type: 'wait' } });
  assert.deepEqual((await pending).output, { action: { action_type: 'wait' } });
});

test('LLMBridge rejects output that fails the schema and keeps the request open', async () => {
  const bridge = new LLMBridge();
  const pending = bridge.complete(plannerRequest());
  await bridge.take();

  const rejected = bridge.answer('r1', { act: 'tap' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? '' : rejected.error, /does not match the planner schema/);
  assert.ok(bridge.openRequest('r1'), 'request still open');

  assert.deepEqual(bridge.answer('r1', { action: { action_type: 'tap' } }), { ok: true });
  await pending;
});

test('LLMBridge accepts the {"output": ...} envelope the prompts teach', async () => {
  const bridge = new LLMBridge();
  const pending = bridge.complete(plannerRequest());
  await bridge.take();

  bridge.answer('r1', { output: { action: { action_type: 'tap' } } });
  assert.deepEqual((await pending).output, { action: { action_type: 'tap' } });
});

test('LLMBridge names the open requests when answered with an unknown id', async () => {
  const bridge = new LLMBridge();
  void bridge.complete(plannerRequest());
  await bridge.take();

  const answer = bridge.answer('r9', {});
  assert.deepEqual(answer, { ok: false, error: 'No open request "r9". Open requests: r1.' });
});

test('LLMBridge close fails parked requests, refuses new ones, and releases waiting clients', async () => {
  const bridge = new LLMBridge();
  const open = bridge.complete(plannerRequest());
  await bridge.take();
  const queued = bridge.complete(plannerRequest({ feature: FEATURE_GROUNDER }));

  bridge.close('Run aborted');

  await assert.rejects(open, /Run aborted/);
  await assert.rejects(queued, /Run aborted/);
  await assert.rejects(bridge.complete(plannerRequest()), /Run aborted/);
  assert.equal(await bridge.take(), undefined);
});

// ----------------------------------------------------------------------------
// McpTestRun
// ----------------------------------------------------------------------------

test('McpTestRun yields each LLM request, then the outcome', async () => {
  const run = new McpTestRun(async ({ llmTransport }) => {
    await llmTransport.complete(plannerRequest());
    await llmTransport.complete(plannerRequest({ feature: FEATURE_GROUNDER }));
    return runResult('success');
  });

  const first = await run.nextEvent();
  assert.equal(first.kind === 'request' && first.request.id, 'r1');
  assert.deepEqual(run.answer('r1', { action: { action_type: 'tap' } }), { ok: true });

  const second = await run.nextEvent();
  assert.equal(second.kind === 'request' && second.request.feature, FEATURE_GROUNDER);
  run.answer('r2', { action: { action_type: 'tap' } });

  const outcome = await run.nextEvent();
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.kind === 'finished' && outcome.result.status, 'success');
  assert.equal(run.settled?.kind, 'finished');
});

test('McpTestRun reports a run that throws before finishing', async () => {
  const run = new McpTestRun(async () => {
    throw new Error('No .finalrun workspace found');
  });

  assert.deepEqual(await run.nextEvent(), {
    kind: 'failed',
    message: 'No .finalrun workspace found',
  });
});

test('McpTestRun abort signals the run before failing its open request', async () => {
  let abortedWhenRejected: boolean | undefined;
  const run = new McpTestRun(async ({ llmTransport, abortSignal }) => {
    try {
      await llmTransport.complete(plannerRequest());
    } catch {
      abortedWhenRejected = abortSignal.aborted;
    }
    return runResult('aborted');
  });
  await run.nextEvent();

  const outcome = await run.abort('Run aborted by the MCP client.');

  assert.equal(abortedWhenRejected, true);
  assert.equal(outcome.kind === 'finished' && outcome.result.status, 'aborted');
});

test('McpTestRun aborts the run when a request goes unanswered', async () => {
  const run = new McpTestRun(
    async ({ llmTransport, abortSignal }) => {
      await llmTransport.complete(plannerRequest()).catch(() => undefined);
      return runResult(abortSignal.aborted ? 'aborted' : 'success');
    },
    { responseTimeoutMs: 10 },
  );
  await run.nextEvent();

  const outcome = await run.nextEvent();
  assert.equal(outcome.kind === 'finished' && outcome.result.status, 'aborted');
});

// ----------------------------------------------------------------------------
// RequestFormatter
// ----------------------------------------------------------------------------

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

function jpegBase64(width: number, height: number): string {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(3, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]).toString('base64');
}

test('describeImage reads JPEG and PNG sizes and strips data-URL prefixes', () => {
  assert.deepEqual(
    { ...describeImage(jpegBase64(1080, 2400)), data: undefined },
    { data: undefined, mimeType: 'image/jpeg', width: 1080, height: 2400 },
  );
  const png = pngBase64(1179, 2556);
  const described = describeImage(`data:image/png;base64,${png}`);
  assert.equal(described.data, png);
  assert.equal(described.mimeType, 'image/png');
  assert.equal(described.width, 1179);
  assert.equal(described.height, 2556);
});

test('RequestFormatter sends instructions once per prompt and screenshots as images', () => {
  const formatter = new RequestFormatter();
  const screenshot = jpegBase64(1080, 2400);
  const request = {
    id: 'r1',
    ...plannerRequest({
      userParts: [
        { type: 'image', image: screenshot },
        { type: 'text', text: 'Test objective: log in' },
      ],
    }),
  };

  const first = formatter.format(request);
  assert.equal(first.length, 4);
  assert.match(textOf(first[0]), /FinalRun request r1 \(planner\)/);
  assert.match(textOf(first[0]), /Screenshot 1: 1080x2400 px/);
  assert.match(textOf(first[1]), /## Instructions \(planner\)\nYou are the planner\./);
  assert.match(textOf(first[1]), /## Output JSON schema\n\{.*"action_type"/);
  assert.deepEqual(first[2], { type: 'image', data: screenshot, mimeType: 'image/jpeg' });
  assert.equal(textOf(first[3]), 'Test objective: log in');

  const second = formatter.format({ ...request, id: 'r3' });
  assert.equal(second.length, 3, 'instructions are not repeated');
  assert.match(textOf(second[0]), /unchanged since request r1/);
  assert.match(textOf(second[0]), /get_instructions` with request_id "r3"/);
});

test('formatOutcome summarizes each test, the artifacts, and the report URL', () => {
  const text = formatOutcome({
    kind: 'finished',
    ...runResult('success'),
    reportUrl: 'http://127.0.0.1:4173/runs/run-1',
  });

  assert.equal(
    text,
    [
      'FinalRun run run-1: success',
      '- auth/login.yaml: success — Logged in',
      '  Analysis: Home screen shown',
      'Artifacts: /workspace/.finalrun/artifacts/run-1',
      'Report: http://127.0.0.1:4173/runs/run-1',
    ].join('\n'),
  );
  assert.equal(
    formatOutcome({ kind: 'failed', message: '\x1b[31m✖ No device\x1b[0m' }),
    'FinalRun run did not complete: ✖ No device',
    'terminal color codes are stripped',
  );
});

function textOf(content: unknown): string {
  const block = content as { type: string; text?: string };
  assert.equal(block.type, 'text');
  return block.text ?? '';
}

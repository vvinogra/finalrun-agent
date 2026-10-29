// The real TestExecutor loop (capture → plan → ground → act) on a fake device,
// with every LLM call answered through the MCP tools.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeviceNodeResponse,
  GetScreenshotAndHierarchyAction,
  TapAction,
  type DeviceActionRequest,
  type DeviceAgent,
  type TestResult,
} from '@finalrun/common';
import { AIAgent, TestExecutor, type TestExecutionResult } from '@finalrun/goal-executor';
import { FinalRunMcpTools, type StartRun, type ToolResult } from '../mcp/server.js';

const CAPTURE = new DeviceNodeResponse({
  success: true,
  data: {
    screenshot: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
    hierarchy: JSON.stringify([
      {
        text: 'Login',
        id: 'login_button',
        class: 'android.widget.Button',
        bounds: [10, 100, 300, 160],
      },
    ]),
    screenWidth: 1080,
    screenHeight: 2400,
  },
});

function fakeDevice(executed: unknown[]): DeviceAgent {
  return {
    async executeAction(request: DeviceActionRequest) {
      if (request.action instanceof GetScreenshotAndHierarchyAction) {
        return CAPTURE;
      }
      executed.push(request.action);
      return new DeviceNodeResponse({ success: true });
    },
  } as unknown as DeviceAgent;
}

function executorRun(executed: unknown[], results: TestExecutionResult[]): StartRun {
  return async (_args, { llmTransport, abortSignal }) => {
    const executor = new TestExecutor({
      goal: 'Tap Login, then confirm the Login button was tapped.',
      platform: 'android',
      maxIterations: 5,
      agent: fakeDevice(executed),
      aiAgent: new AIAgent({
        apiKeys: {},
        defaults: { provider: 'mcp', modelName: 'test-client' },
        transport: llmTransport,
      }),
    });
    abortSignal.addEventListener('abort', () => executor.abort());
    const result = await executor.executeGoal();
    results.push(result);
    return {
      result: {
        success: result.success,
        status: result.status,
        runId: 'run-1',
        runDir: '/workspace/.finalrun/artifacts/run-1',
        runIndexPath: '/workspace/.finalrun/artifacts/runs.json',
        testResults: [
          {
            relativePath: 'login.yaml',
            status: result.status,
            message: result.message,
          } as TestResult,
        ],
      },
    };
  };
}

function textOf(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

const TAP_LOGIN = {
  thought: { plan: '[-> Tap Login] → [Verify]', think: 'Login is visible.', act: 'Tap Login' },
  action: { action_type: 'tap' },
  remember: [],
};

test('MCP client drives the TestExecutor loop from first capture to a passing verdict', async (t) => {
  const executed: unknown[] = [];
  const results: TestExecutionResult[] = [];
  const tools = new FinalRunMcpTools({ startRun: executorRun(executed, results) });
  // A failed assertion must not leave the run parked on an open request.
  t.after(() => tools.shutdown());

  const plan1 = await tools.runTests({ selectors: ['login.yaml'] });
  assert.match(textOf(plan1), /request r1 \(planner\)/);
  assert.match(textOf(plan1), /Test objective: Tap Login/);

  const ground = await tools.respond({ request_id: 'r1', output: TAP_LOGIN });
  assert.match(textOf(ground), /request r2 \(grounder\)/);
  assert.match(textOf(ground), /"text":"Login"/);

  const plan2 = await tools.respond({ request_id: 'r2', output: { index: 0, reason: 'Login' } });
  assert.match(textOf(plan2), /request r3 \(planner\)/);
  assert.match(textOf(plan2), /unchanged since request r1/);
  assert.match(textOf(plan2), /History of actions taken so far:/);
  assert.equal(executed.length, 1);
  assert.ok(executed[0] instanceof TapAction);
  assert.deepEqual(
    { x: (executed[0] as TapAction).point.x, y: (executed[0] as TapAction).point.y },
    { x: 155, y: 130 },
    'tapped the center of the grounded element',
  );

  const summary = await tools.respond({
    request_id: 'r3',
    output: {
      thought: { plan: '[✓ Tap Login] → [-> Verify]', think: 'Tap succeeded.', act: 'Done' },
      action: { action_type: 'status', result: 'success', analysis: 'Login was tapped.' },
      remember: [],
    },
  });
  assert.match(textOf(summary), /^FinalRun run run-1: success/);
  assert.equal(results[0]?.status, 'success');
  assert.equal(results[0]?.analysis, 'Login was tapped.');
});

test('MCP abort stops the TestExecutor loop with an aborted result', async (t) => {
  const executed: unknown[] = [];
  const results: TestExecutionResult[] = [];
  const tools = new FinalRunMcpTools({ startRun: executorRun(executed, results) });
  t.after(() => tools.shutdown());
  await tools.runTests({ selectors: ['login.yaml'] });

  const aborted = await tools.abort();

  assert.match(textOf(aborted), /^FinalRun run run-1: aborted/);
  assert.equal(results[0]?.status, 'aborted');
  assert.equal(executed.length, 0, 'no device action ran');
});

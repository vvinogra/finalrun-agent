import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FEATURE_GROUNDER, Hierarchy, type TestResult } from '@finalrun/common';
import { AIAgent } from '@finalrun/goal-executor';
import {
  createFinalRunMcpServer,
  FinalRunMcpTools,
  type RunTestsArgs,
  type StartRun,
} from '../mcp/server.js';

const SCREENSHOT = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

const LOGIN_HIERARCHY = Hierarchy.fromFlatJson([
  {
    text: 'Login',
    id: 'login_button',
    class: 'android.widget.Button',
    bounds: [10, 100, 300, 160],
  },
]);

interface Observed {
  args?: RunTestsArgs;
  act?: string;
  groundedIndex?: unknown;
  error?: string;
}

/**
 * A stand-in for the local run: one planner call and one grounder call made
 * through a real AIAgent on the bridge, so the real prompts and schemas cross
 * the MCP boundary.
 */
function fakeRun(observed: Observed): StartRun {
  return async (args, { llmTransport }) => {
    observed.args = args;
    const agent = new AIAgent({
      apiKeys: {},
      defaults: { provider: 'mcp', modelName: 'test-client' },
      transport: llmTransport,
    });
    try {
      const plan = await agent.plan({
        testObjective: 'Tap Login',
        platform: 'android',
        preActionScreenshot: SCREENSHOT,
        hierarchy: LOGIN_HIERARCHY,
      });
      observed.act = plan.act;
      const grounded = await agent.ground({
        feature: FEATURE_GROUNDER,
        act: plan.reason,
        hierarchy: LOGIN_HIERARCHY,
        screenshot: SCREENSHOT,
        platform: 'android',
      });
      observed.groundedIndex = grounded.output['index'];
    } catch (error) {
      observed.error = error instanceof Error ? error.message : String(error);
    }
    const status = observed.error ? 'aborted' : 'success';
    return {
      result: {
        success: status === 'success',
        status,
        runId: 'run-1',
        runDir: '/workspace/.finalrun/artifacts/run-1',
        runIndexPath: '/workspace/.finalrun/artifacts/runs.json',
        testResults: [
          { relativePath: 'auth/login.yaml', status, message: 'Tapped Login' } as TestResult,
        ],
      },
    };
  };
}

async function connect(t: TestContext, startRun: StartRun): Promise<Client> {
  const tools = new FinalRunMcpTools({ startRun });
  // A failed assertion must not leave a run parked on an open request.
  t.after(() => tools.shutdown());
  const server = createFinalRunMcpServer(tools, '0.0.0-test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface Block {
  type: string;
  text?: string;
  mimeType?: string;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ blocks: Block[]; text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content as Block[];
  return {
    blocks,
    text: blocks.flatMap((block) => (block.text ? [block.text] : [])).join('\n'),
    isError: result.isError === true,
  };
}

test('finalrun MCP server lists its tools and instructions', async (t) => {
  const client = await connect(t, fakeRun({}));

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'abort',
    'get_instructions',
    'respond',
    'run_tests',
  ]);
  assert.match(client.getInstructions() ?? '', /act as FinalRun's AI/);
});

test('finalrun MCP server drives a run through planner and grounder requests', async (t) => {
  const observed: Observed = {};
  const client = await connect(t, fakeRun(observed));

  const planner = await call(client, 'run_tests', { selectors: ['auth/login.yaml'] });
  assert.equal(planner.isError, false);
  assert.deepEqual(observed.args, { selectors: ['auth/login.yaml'] });
  assert.match(planner.text, /FinalRun request r1 \(planner\)/);
  assert.match(planner.text, /## Instructions \(planner\)/);
  assert.match(planner.text, /Test objective: Tap Login/);
  assert.ok(
    planner.blocks.some((block) => block.type === 'image' && block.mimeType === 'image/jpeg'),
    'screenshot sent as an image',
  );

  const invalid = await call(client, 'respond', { request_id: 'r1', output: { act: 'tap' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /does not match the planner schema/);

  const grounder = await call(client, 'respond', {
    request_id: 'r1',
    output: {
      output: {
        thought: { plan: '[-> Tap Login]', think: 'Login is visible.', act: 'Tap Login' },
        action: { action_type: 'tap' },
        remember: [],
      },
    },
  });
  assert.equal(grounder.isError, false);
  assert.match(grounder.text, /FinalRun request r2 \(grounder\)/);
  assert.match(grounder.text, /## Instructions \(grounder\)/);
  assert.match(grounder.text, /act: Tap Login/);

  const instructions = await call(client, 'get_instructions', { request_id: 'r2' });
  assert.match(instructions.text, /^## Instructions \(grounder\)/);

  const summary = await call(client, 'respond', {
    request_id: 'r2',
    output: { index: 0, reason: 'Login button' },
  });
  assert.equal(summary.isError, false);
  assert.match(summary.text, /^FinalRun run run-1: success/);
  assert.match(summary.text, /auth\/login\.yaml: success — Tapped Login/);
  assert.equal(observed.act, 'tap');
  assert.equal(observed.groundedIndex, 0);

  const afterRun = await call(client, 'respond', { request_id: 'r2', output: {} });
  assert.equal(afterRun.isError, true);
  assert.match(afterRun.text, /^The run has already finished\.\nFinalRun run run-1: success/);
});

test('finalrun MCP server aborts the active run on request', async (t) => {
  const observed: Observed = {};
  const client = await connect(t, fakeRun(observed));
  await call(client, 'run_tests', { selectors: ['auth/login.yaml'] });

  const busy = await call(client, 'run_tests', { selectors: ['auth/login.yaml'] });
  assert.equal(busy.isError, true);
  assert.match(busy.text, /already in progress/);

  const aborted = await call(client, 'abort');
  assert.match(aborted.text, /^FinalRun run run-1: aborted/);
  assert.match(observed.error ?? '', /Run aborted by the MCP client/);
});

test('finalrun MCP server reports a run that fails before its first request', async (t) => {
  const client = await connect(t, async () => {
    throw new Error('Could not find a .finalrun workspace.');
  });

  const result = await call(client, 'run_tests', { selectors: ['auth/login.yaml'] });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'FinalRun run did not complete: Could not find a .finalrun workspace.');
});

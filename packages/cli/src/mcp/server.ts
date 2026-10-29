// `finalrun mcp` — FinalRun as an MCP server over stdio. The MCP client (for
// example a Claude Code subagent) acts as FinalRun's planner and grounder:
// run_tests starts a normal local run whose LLM calls are parked in an
// LLMBridge, and respond answers them one at a time. No provider API key is
// used; the run, device handling, and report are the same as `finalrun test`.

import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  DEFAULT_MAX_ITERATIONS,
  Logger,
  LogLevel,
  normalizeTestSelectors,
  resolveConfiguredEnvironmentFile,
  resolveWorkspace,
  TEST_SELECTION_REQUIRED_ERROR,
} from '@finalrun/common';
import { resolveLocalRuntime } from '../localRuntime.js';
import { resolveCliPackageVersion } from '../runtimePaths.js';
import { McpTestRun, type McpRunResult, type RunStartContext } from './mcpTestRun.js';
import {
  formatInstructions,
  formatOutcome,
  RequestFormatter,
  type ToolContent,
} from './requestFormatter.js';

export interface RunTestsArgs {
  selectors?: string[];
  suite?: string;
  platform?: 'android' | 'ios';
  env?: string;
  app?: string;
  workspace?: string;
  max_iterations?: number;
}

export interface ToolResult {
  // Index signature keeps this assignable to the SDK's CallToolResult.
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}

export type StartRun = (args: RunTestsArgs, context: RunStartContext) => Promise<McpRunResult>;

const SERVER_INSTRUCTIONS = `FinalRun runs plain-English YAML tests from a repository's .finalrun/ folder against a mobile app on a local Android emulator or iOS simulator, and writes a report with screenshots, video, and device logs.

In this server you act as FinalRun's AI, so no API key is needed. Call run_tests to start a run; it returns FinalRun's first request. A request carries instructions (in full the first time, referenced afterwards), the device screenshot, and the on-screen UI elements. Answer it by calling respond with its request_id and one JSON object that follows the instructions and output schema; respond returns the next request. Repeat until respond returns the run summary instead of a request. Planner requests choose the next action or the final pass/fail status; grounder requests locate the element for that action.

Judge only from the screenshots and UI elements in the requests, never from the app's source code. A run takes many requests, so run it from a dedicated subagent whose only tools are this server's.`;

/** Tool logic, independent of the MCP transport so it can be tested directly. */
export class FinalRunMcpTools {
  private readonly _startRun: StartRun;
  private readonly _responseTimeoutMs?: number;
  private _run: McpTestRun | undefined;
  private _formatter = new RequestFormatter();

  constructor(params: { startRun: StartRun; responseTimeoutMs?: number }) {
    this._startRun = params.startRun;
    this._responseTimeoutMs = params.responseTimeoutMs;
  }

  async runTests(args: RunTestsArgs): Promise<ToolResult> {
    if (this._activeRun()) {
      return errorResult(
        'A FinalRun run is already in progress. Answer its open request with `respond`, or call `abort`.',
      );
    }
    const run = new McpTestRun((context) => this._startRun(args, context), {
      ...(this._responseTimeoutMs !== undefined
        ? { responseTimeoutMs: this._responseTimeoutMs }
        : {}),
    });
    this._run = run;
    this._formatter = new RequestFormatter();
    return this._renderNextEvent(run);
  }

  async respond(args: { request_id: string; output: unknown }): Promise<ToolResult> {
    const run = this._activeRun();
    if (!run) {
      // The run can end between requests (abort, response timeout), so
      // repeat its summary rather than leaving the client without it.
      const settled = this._run?.settled;
      return errorResult(
        settled
          ? `The run has already finished.\n${formatOutcome(settled)}`
          : 'No FinalRun run is in progress. Start one with `run_tests`.',
      );
    }
    const answer = run.answer(args.request_id, args.output);
    if (!answer.ok) {
      return errorResult(answer.error);
    }
    return this._renderNextEvent(run);
  }

  getInstructions(args: { request_id: string }): ToolResult {
    const request = this._activeRun()?.openRequest(args.request_id);
    if (!request) {
      return errorResult(`No open request "${args.request_id}".`);
    }
    return { content: [{ type: 'text', text: formatInstructions(request) }] };
  }

  async abort(): Promise<ToolResult> {
    const run = this._activeRun();
    if (!run) {
      return errorResult('No FinalRun run is in progress.');
    }
    const outcome = await run.abort('Run aborted by the MCP client.');
    return { content: [{ type: 'text', text: formatOutcome(outcome) }] };
  }

  /** Abort any active run and wait for its cleanup (devices, recording, report). */
  async shutdown(): Promise<void> {
    await this._activeRun()?.abort('The MCP client disconnected.');
  }

  private _activeRun(): McpTestRun | undefined {
    return this._run && !this._run.settled ? this._run : undefined;
  }

  private async _renderNextEvent(run: McpTestRun): Promise<ToolResult> {
    const event = await run.nextEvent();
    if (event.kind === 'request') {
      return { content: this._formatter.format(event.request) };
    }
    return {
      content: [{ type: 'text', text: formatOutcome(event) }],
      ...(event.kind === 'failed' ? { isError: true } : {}),
    };
  }
}

const RUN_TESTS_INPUT = {
  selectors: z
    .array(z.string())
    .optional()
    .describe('Test YAML files, directories, or globs under .finalrun/tests'),
  suite: z
    .string()
    .optional()
    .describe('Suite manifest under .finalrun/suites, instead of selectors'),
  platform: z.enum(['android', 'ios']).optional(),
  env: z.string().optional().describe('Environment name, for example dev'),
  app: z.string().optional().describe('Path to an .apk or .app to install first'),
  workspace: z
    .string()
    .optional()
    .describe("Workspace root or a path inside it; defaults to the server's working directory"),
  max_iterations: z.number().int().positive().optional(),
};

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createFinalRunMcpServer(tools: FinalRunMcpTools, version: string): McpServer {
  const server = new McpServer(
    { name: 'finalrun', version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'run_tests',
    {
      title: 'Run FinalRun tests',
      description:
        'Start a FinalRun run on a local Android emulator or iOS simulator, with you as its AI. Returns the first request to answer with `respond`. One run at a time.',
      inputSchema: RUN_TESTS_INPUT,
    },
    (args) => tools.runTests(args),
  );

  server.registerTool(
    'respond',
    {
      title: 'Answer a FinalRun request',
      description:
        'Answer the open FinalRun request. `output` is the JSON object the request asks for (wrapping it in {"output": ...} is optional). Returns the next request, or the run summary when the run has finished.',
      inputSchema: {
        request_id: z.string(),
        output: z.record(z.string(), z.unknown()),
      },
    },
    (args) => tools.respond(args),
  );

  server.registerTool(
    'get_instructions',
    {
      title: 'Get FinalRun request instructions',
      description: 'Return the full instructions and output schema for an open request.',
      inputSchema: { request_id: z.string() },
    },
    (args) => tools.getInstructions(args),
  );

  server.registerTool(
    'abort',
    {
      title: 'Abort the FinalRun run',
      description: 'Stop the active run. Its report is still written. Returns the run summary.',
    },
    () => tools.abort(),
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const protocolOut = claimStdout();
  Logger.init({ level: LogLevel.INFO, resetSinks: true });

  const tools = new FinalRunMcpTools({
    // Called only after connect, once the client has introduced itself.
    startRun: (args, context) =>
      startLocalRun(args, context, server.server.getClientVersion()?.name),
  });
  const server = createFinalRunMcpServer(tools, resolveCliPackageVersion());

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Give device, recording, and report cleanup a bounded window.
    const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    void tools.shutdown().finally(() => process.exit(0));
  };
  server.server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport(process.stdin, protocolOut));
}

const SHUTDOWN_TIMEOUT_MS = 30_000;

/** The default StartRun: a local run, set up the way `finalrun test` does it. */
async function startLocalRun(
  args: RunTestsArgs,
  context: RunStartContext,
  clientName: string | undefined,
): Promise<McpRunResult> {
  const selectors = normalizeTestSelectors(args.selectors);
  const suitePath = args.suite?.trim() || undefined;
  if (selectors.length === 0 && !suitePath) {
    throw new Error(TEST_SELECTION_REQUIRED_ERROR);
  }

  const workspace = await resolveWorkspace(
    args.workspace ? path.resolve(args.workspace) : process.cwd(),
  );
  const environment = await resolveConfiguredEnvironmentFile(workspace, args.env);
  const runtime = await resolveLocalRuntime();

  const result = await runtime.testRunner.runTests({
    cwd: workspace.rootDir,
    envName: environment.usesEmptyBindings ? undefined : environment.envName,
    selectors,
    suitePath,
    platform: args.platform,
    appPath: args.app,
    apiKeys: {},
    // Recorded as the run's model in the report, e.g. "mcp/claude-code".
    defaults: { provider: 'mcp', modelName: clientName ?? 'client' },
    maxIterations: args.max_iterations ?? DEFAULT_MAX_ITERATIONS,
    invokedCommand: suitePath ? 'suite' : 'test',
    llmTransport: context.llmTransport,
    abortSignal: context.abortSignal,
    // stdin carries the MCP protocol, so a device prompt must never read it:
    // with several devices the run fails with the list instead.
    deviceSelectionIO: { input: Readable.from([]), output: process.stderr, isTTY: false },
  });

  try {
    const reportServer = await runtime.reportServerManager.startOrReuseWorkspaceReportServer({
      workspace,
      requestedPort: 4173,
      dev: false,
    });
    return {
      result,
      reportUrl: runtime.reportServerManager.buildRunReportUrl(reportServer.url, result.runId),
    };
  } catch (error) {
    Logger.w(
      `Could not start local report server: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { result };
  }
}

/**
 * MCP over stdio owns stdout: a single stray write corrupts the JSON-RPC
 * stream. Point every other stdout write (Logger, the terminal renderer) at
 * stderr and give the transport a private handle on the real stdout.
 */
function claimStdout(): Writable {
  const writeProtocol = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeProtocol(chunk, callback);
    },
  });
}

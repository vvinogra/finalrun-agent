# MCP Mode (Prototype)

`finalrun mcp` serves FinalRun over the Model Context Protocol (stdio) so that an MCP client — typically a Claude Code subagent — acts as FinalRun's AI. No provider API key is used: the model calls are answered by the client, on the client's own plan.

Everything else is the same as `finalrun test`: workspace validation, device setup, recording, device logs, and the report under `.finalrun/artifacts/`.

## How It Works

FinalRun's test loop runs unchanged inside the server. Wherever it would call a provider API (`AIAgent._callLLM`), it parks the request instead and hands it to the client:

```
agent ──run_tests──▶ finalrun mcp ── device setup, capture, AIAgent.plan() ⏸
      ◀── request r1: planner instructions + screenshot + UI elements
      ──respond(r1, {thought, action})──▶ action executes → AIAgent.ground() ⏸
      ◀── request r2: grounder instructions + UI elements
      ──respond(r2, {index: 3})──▶ tap, next capture, plan() ⏸ …
      ──respond(rN, {action: {action_type: "status", result: "success"}})──▶ report written
      ◀── run summary: status per test, artifacts folder, report URL
```

Answers are checked against the same JSON schemas the Anthropic provider path enforces; an invalid answer is rejected and the request stays open.

## Tools

| Tool               | Purpose                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_tests`        | Start a run (`selectors` or `suite`, plus optional `platform`, `env`, `app`, `workspace`, `max_iterations`). Returns the first request. One run at a time. |
| `respond`          | Answer the open request (`request_id`, `output`). Returns the next request or the run summary.                                                             |
| `get_instructions` | Re-fetch the full instructions and schema for an open request. Instructions are sent in full only the first time each one appears.                         |
| `abort`            | Stop the run. The report is still written.                                                                                                                 |

## Setup With Claude Code

1. Register the server from your app repository (local scope, so the server starts in that repository and finds its `.finalrun/` workspace):

   ```sh
   claude mcp add finalrun -- finalrun mcp
   ```

   With a development build of this repository, point at the built CLI instead:

   ```sh
   claude mcp add finalrun -- node /path/to/finalrun-agent/packages/cli/dist/bin/finalrun.js mcp
   ```

2. Add a subagent that drives the run, at `.claude/agents/finalrun-tester.md` in your app repository. Its only tools are the FinalRun server's, so screenshots stay out of your main conversation and it tests as a black box instead of reading your source code:

   ```markdown
   ---
   name: finalrun-tester
   description: Runs FinalRun mobile-app tests (.finalrun/tests, .finalrun/suites) on a local emulator or simulator, acting as FinalRun's AI through the finalrun MCP server. Use to run FinalRun tests without an API key.
   tools: mcp__finalrun__*
   model: sonnet
   ---

   You run one FinalRun test or suite and report the result.

   1. Call `run_tests` with the selectors or suite you were given, plus platform, env, or app if specified.
   2. Each result is a FinalRun request. Answer it with `respond`, using its request_id and one JSON object that follows the request's instructions and output schema. Keep answering each new request the same way.
   3. Be a strict black-box tester: decide only from the screenshot and UI elements in the request.
   4. If `respond` returns an error, correct the output and answer the same request again.
   5. When a result is the run summary instead of a request, stop. Return the summary verbatim, then explain any failure in one paragraph.
   ```

3. Ask Claude Code: "Use the finalrun-tester agent to run auth/login.yaml on Android."

## Prototype Limitations

- **One device.** Device selection can't prompt (stdin carries the protocol), so with several devices available the run fails and lists them. Boot one device, or pass `platform`.
- **Tool result size.** The first planner request carries ~31 KB of instructions plus a screenshot and UI elements. Claude Code warns above 10,000 tokens and caps tool results at 25,000 tokens by default; raise `MAX_MCP_OUTPUT_TOKENS` if a complex screen hits the cap.
- **Coordinates.** Element-index grounding is unaffected by image scaling. For the visual fallback, the request states the screenshot's native size and asks for coordinates in it; the server does not yet downscale screenshots itself.
- **Secrets.** Prompt text is redacted as in provider mode. Screenshots are not, and Claude Code saves MCP images under `~/.claude/projects/…/tool-results`.
- **Model control.** The subagent's model and effort apply to every feature. Reports record the model as `mcp/<client name>` with zero token counts.
- **Unanswered requests.** A request left unanswered for 15 minutes aborts the run.
- **Interactive only.** CI keeps using provider API keys.
- **Validation so far.** Covered by tests with a fake device and a real MCP client, and by a stdio smoke test up to device preflight — not yet by a run on a real emulator or simulator.

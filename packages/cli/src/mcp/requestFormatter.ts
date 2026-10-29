// Renders LLMBridge requests and run outcomes as MCP tool-result content.

import { z } from 'zod';
import type { BridgeRequest } from './llmBridge.js';
import type { RunOutcome } from './mcpTestRun.js';

export type ToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Formats requests for one run. Each distinct system prompt (planner.md,
 * grounder.md, ...) is sent in full only the first time it appears — the
 * planner prompt alone is ~31 KB — and referenced by request id afterwards.
 */
export class RequestFormatter {
  private readonly _firstRequestByPrompt = new Map<string, string>();

  format(request: BridgeRequest): ToolContent[] {
    const firstRequestId = this._firstRequestByPrompt.get(request.systemPrompt);
    if (firstRequestId === undefined) {
      this._firstRequestByPrompt.set(request.systemPrompt, request.id);
    }

    const images = request.userParts.flatMap((part) =>
      part.type === 'image' ? [describeImage(part.image)] : [],
    );
    const content: ToolContent[] = [
      { type: 'text', text: formatHeader(request, firstRequestId, images) },
    ];
    if (firstRequestId === undefined) {
      content.push({ type: 'text', text: formatInstructions(request) });
    }

    let imageIndex = 0;
    for (const part of request.userParts) {
      if (part.type === 'image') {
        const image = images[imageIndex++]!;
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      } else {
        content.push({ type: 'text', text: part.text });
      }
    }
    return content;
  }
}

export function formatInstructions(request: BridgeRequest): string {
  return [
    `## Instructions (${request.feature})`,
    request.systemPrompt.trim(),
    '',
    '## Output JSON schema',
    formatSchema(request.schema),
  ].join('\n');
}

export function formatOutcome(outcome: RunOutcome): string {
  if (outcome.kind === 'failed') {
    // Setup errors are formatted for a terminal (e.g. LocalRuntimeMissingError).
    // eslint-disable-next-line no-control-regex
    const message = outcome.message.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    return `FinalRun run did not complete: ${message}`;
  }

  const { result } = outcome;
  const lines = [`FinalRun run ${result.runId}: ${result.status}`];
  for (const test of result.testResults) {
    lines.push(`- ${test.relativePath}: ${test.status} — ${test.message}`);
    if (test.analysis && test.analysis !== test.message) {
      lines.push(`  Analysis: ${test.analysis}`);
    }
  }
  lines.push(`Artifacts: ${result.runDir}`);
  if (outcome.reportUrl) {
    lines.push(`Report: ${outcome.reportUrl}`);
  }
  return lines.join('\n');
}

function formatHeader(
  request: BridgeRequest,
  firstRequestId: string | undefined,
  images: DescribedImage[],
): string {
  const lines = [
    `FinalRun request ${request.id} (${request.feature}).`,
    `Answer by calling \`respond\` with request_id "${request.id}" and \`output\` set to one JSON object that follows the instructions and matches the output schema.`,
  ];
  if (firstRequestId !== undefined) {
    lines.push(
      `Instructions and schema: unchanged since request ${firstRequestId}. If you no longer have them, call \`get_instructions\` with request_id "${request.id}".`,
    );
  }
  images.forEach((image, index) => {
    if (image.width !== undefined && image.height !== undefined) {
      lines.push(
        `Screenshot ${index + 1}: ${image.width}x${image.height} px. Give any x/y coordinates in this pixel space, even if the image you see is scaled down.`,
      );
    }
  });
  return lines.join('\n');
}

function formatSchema(schema: z.ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema));
  } catch {
    return '(schema unavailable — follow the output format in the instructions)';
  }
}

interface DescribedImage {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** Strip any data-URL prefix and read the format and size from the header. */
export function describeImage(image: string): DescribedImage {
  const data = image.replace(/^data:[^;,]+;base64,/, '');
  const bytes = Buffer.from(data, 'base64');
  const png = readPngSize(bytes);
  if (png) {
    return { data, mimeType: 'image/png', ...png };
  }
  // Device screenshots are JPEG (GrpcDriverClient), so default to it.
  return { data, mimeType: 'image/jpeg', ...readJpegSize(bytes) };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpegSize(bytes: Buffer): { width?: number; height?: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return {};
  }
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return {};
    }
    const marker = bytes[offset + 1]!;
    // SOF0–SOF15 carry the frame size; 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC)
    // share the range but are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return {};
}

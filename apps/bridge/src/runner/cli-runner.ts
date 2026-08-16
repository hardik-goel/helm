import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SessionExitReason } from '@helm/core';
import { childEnv } from './env.js';
import {
  AuthRequiredError,
  looksLikeAuthFailure,
  type AgentRunner,
  type RunResult,
  type RunSpec,
} from './types.js';

/**
 * Fallback path for when the SDK is unavailable or broken.
 *
 * The CLI cannot hold a permission promise open, so this runner enforces the
 * gate by restriction instead of by blocking: the child is started with only
 * the read-only allowlist, and anything else the agent wants must arrive as a
 * `## PROPOSED ACTIONS` block in its final message. The supervisor turns that
 * block into gate items and parks the agent. Same law, different mechanics.
 */
export class CliAgentRunner implements AgentRunner {
  readonly kind = 'cli' as const;

  constructor(private readonly binary = process.env.HELM_CLAUDE_BIN ?? 'claude') {}

  async run(spec: RunSpec): Promise<RunResult> {
    const args = [
      '-p',
      spec.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      spec.model,
      '--max-turns',
      String(spec.maxTurns),
      '--allowedTools',
      spec.allowlist.join(','),
      '--permission-mode',
      'default',
      '--append-system-prompt',
      spec.systemPromptAppend,
    ];
    if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);

    const child = spawn(this.binary, args, {
      cwd: spec.cwd,
      env: childEnv(spec.billing, spec.apiKey),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => child.kill('SIGTERM');
    spec.signal.addEventListener('abort', onAbort, { once: true });

    let claudeSessionId: string | null = spec.resumeSessionId;
    let costUsd = 0;
    let turns = 0;
    let finalText = '';
    let exitReason: SessionExitReason = 'error';
    let stderr = '';

    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        spec.onMessage({ role: 'system', text: trimmed });
        continue;
      }

      spec.onRaw?.(msg);
      if (typeof msg.session_id === 'string') claudeSessionId = msg.session_id;

      switch (msg.type) {
        case 'system':
          spec.onMessage({
            role: 'system',
            text: String(msg.subtype ?? 'system'),
            raw: msg,
            claudeSessionId: claudeSessionId ?? undefined,
          });
          break;
        case 'assistant': {
          turns += 1;
          for (const block of blocksOf(msg.message)) {
            if (block.type === 'text' && block.text) {
              finalText = block.text;
              spec.onMessage({ role: 'assistant', text: block.text, raw: msg });
            } else if (block.type === 'tool_use') {
              spec.onMessage({ role: 'tool', text: String(block.name ?? 'tool'), raw: msg });
            }
          }
          break;
        }
        case 'user':
          for (const block of blocksOf(msg.message)) {
            if (block.type === 'tool_result') {
              spec.onMessage({ role: 'tool', text: 'tool result', raw: msg });
            }
          }
          break;
        case 'result': {
          costUsd = Number(msg.total_cost_usd ?? 0);
          turns = Number(msg.num_turns ?? turns);
          if (typeof msg.result === 'string') finalText = msg.result;
          exitReason =
            msg.subtype === 'success'
              ? 'completed'
              : msg.subtype === 'error_max_turns'
                ? 'max-turns'
                : 'error';
          spec.onMessage({
            role: 'result',
            text: `${String(msg.subtype)} — ${turns} turns, $${costUsd.toFixed(4)}`,
            raw: msg,
          });
          break;
        }
        default:
          break;
      }
    }

    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? 0));
    });
    spec.signal.removeEventListener('abort', onAbort);

    if (spec.signal.aborted) return { claudeSessionId, costUsd, turns, exitReason: 'killed', finalText };

    if (code !== 0 && exitReason !== 'completed') {
      if (looksLikeAuthFailure(stderr)) throw new AuthRequiredError(stderr.trim().slice(0, 400));
      exitReason = 'error';
      spec.onMessage({ role: 'error', text: stderr.trim().slice(0, 2000) || `exit ${code}` });
    }

    return { claudeSessionId, costUsd, turns, exitReason, finalText };
  }
}

type Block = { type: string; text?: string; name?: string };

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

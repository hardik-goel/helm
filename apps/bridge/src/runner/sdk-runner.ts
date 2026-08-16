import { query, type Options, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { classifyToolUse, type SessionExitReason } from '@helm/core';
import { childEnv } from './env.js';
import {
  AuthRequiredError,
  looksLikeAuthFailure,
  type AgentRunner,
  type RunResult,
  type RunSpec,
} from './types.js';

/**
 * The preferred path. `canUseTool` is the first enforcement layer: it holds the
 * permission promise open while a human decides at the gate, so the session is
 * genuinely blocked rather than politely asked to wait.
 */
export class SdkAgentRunner implements AgentRunner {
  readonly kind = 'sdk' as const;

  async run(spec: RunSpec): Promise<RunResult> {
    let claudeSessionId: string | null = spec.resumeSessionId;
    let costUsd = 0;
    let turns = 0;
    let finalText = '';
    let exitReason: SessionExitReason = 'error';
    let authFailed = false;

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      maxTurns: spec.maxTurns,
      // Law 2: the default preset plus HELM.md. Never a bypass mode.
      permissionMode: 'default',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: spec.systemPromptAppend,
      },
      allowedTools: spec.allowlist,
      env: childEnv(spec.billing, spec.apiKey) as Record<string, string | undefined>,
      abortController: toAbortController(spec.signal),
      includePartialMessages: false,
      canUseTool: async (toolName, input, opts): Promise<PermissionResult> => {
        const verdict = classifyToolUse({
          toolName,
          input: input as Record<string, unknown>,
          allowlist: spec.allowlist,
          workspacePath: spec.cwd,
          allowedDomains: spec.allowedDomains,
          autonomy: spec.autonomy,
          maxChildren: spec.maxChildren,
        });

        if (verdict.decision === 'allow') {
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        spec.onMessage({
          role: 'gate',
          text: `held at gate — ${verdict.kind}: ${verdict.reason}`,
          raw: { toolName, input },
        });

        // This await is the block. Nothing runs until a human decides.
        const decision = await spec.onPermission({
          toolName,
          input: input as Record<string, unknown>,
          toolUseId: opts?.toolUseID,
          kind: verdict.kind,
          reason: verdict.reason,
        });

        if (decision.behavior === 'allow') {
          return {
            behavior: 'allow',
            updatedInput: decision.updatedInput ?? (input as Record<string, unknown>),
          };
        }
        return { behavior: 'deny', message: decision.message, interrupt: decision.interrupt };
      },
    };

    if (spec.resumeSessionId) options.resume = spec.resumeSessionId;

    const q = query({ prompt: spec.prompt, options });

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        // Record first, interpret second.
        spec.onRaw?.(msg);
        if ('session_id' in msg && msg.session_id) claudeSessionId = msg.session_id;

        switch (msg.type) {
          case 'system':
            spec.onMessage({
              role: 'system',
              text: msg.subtype === 'init' ? `session init — model ${spec.model}` : msg.subtype,
              raw: msg,
              claudeSessionId: msg.session_id,
            });
            break;

          case 'auth_status':
            if (msg.error || looksLikeAuthFailure(msg.output?.join(' ') ?? '')) {
              authFailed = true;
              spec.onMessage({ role: 'error', text: msg.error ?? 'authentication failed', raw: msg });
            }
            break;

          case 'assistant': {
            if (msg.error === 'authentication_failed') authFailed = true;
            turns += 1;
            for (const block of contentBlocks(msg.message)) {
              if (block.type === 'text') {
                finalText = block.text ?? '';
                spec.onMessage({ role: 'assistant', text: finalText, raw: msg });
              } else if (block.type === 'thinking') {
                spec.onMessage({ role: 'thinking', text: block.thinking ?? '', raw: msg });
              } else if (block.type === 'tool_use') {
                spec.onMessage({
                  role: 'tool',
                  text: `${block.name} ${summarizeInput(block.input)}`,
                  raw: msg,
                });
              }
            }
            break;
          }

          case 'user':
            for (const block of contentBlocks(msg.message)) {
              if (block.type === 'tool_result') {
                spec.onMessage({ role: 'tool', text: summarizeResult(block), raw: msg });
              }
            }
            break;

          case 'result': {
            costUsd = msg.total_cost_usd ?? 0;
            turns = msg.num_turns ?? turns;
            if (msg.subtype === 'success') {
              exitReason = 'completed';
              if ('result' in msg && typeof msg.result === 'string') finalText = msg.result;
            } else if (msg.subtype === 'error_max_turns') {
              exitReason = 'max-turns';
            } else {
              exitReason = 'error';
            }
            spec.onMessage({
              role: 'result',
              text: `${msg.subtype} — ${turns} turns, $${costUsd.toFixed(4)}`,
              raw: msg,
            });
            break;
          }

          default:
            break;
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (spec.signal.aborted) {
        exitReason = 'killed';
      } else if (authFailed || looksLikeAuthFailure(text)) {
        spec.onMessage({ role: 'error', text, raw: { error: text } });
        throw new AuthRequiredError(text);
      } else {
        exitReason = 'error';
        spec.onMessage({ role: 'error', text, raw: { error: text } });
      }
    }

    if (authFailed) throw new AuthRequiredError('claude login required');
    if (spec.signal.aborted) exitReason = 'killed';

    return { claudeSessionId, costUsd, turns, exitReason, finalText };
  }
}

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
};

function contentBlocks(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const key = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? '';
  const s = String(key);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

function summarizeResult(block: Block): string {
  const c = block.content;
  const text =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((b) => (b as Block).text ?? '').join(' ')
        : '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const prefix = block.is_error ? 'error: ' : '';
  return `${prefix}${trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed}`;
}

/** The SDK wants an AbortController; the supervisor owns an AbortSignal. */
function toAbortController(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

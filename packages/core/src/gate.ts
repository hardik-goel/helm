import { z } from 'zod';
import { GateKind, READONLY_BASH_PREFIXES } from './domain.js';

/**
 * The `## PROPOSED ACTIONS` block an agent writes in its final message.
 * This is the SECOND enforcement layer — the permission callback is the first.
 * Both funnel into the same gate_items table.
 */
export const ProposedAction = z.object({
  kind: GateKind,
  label: z.string().min(1),
  detail: z.string().default(''),
  /** Shell command, file diff, request body — whatever the bridge would run. */
  payload: z.unknown().optional(),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

export const ProposedActionsBlock = z.object({
  actions: z.array(ProposedAction),
});
export type ProposedActionsBlock = z.infer<typeof ProposedActionsBlock>;

export const PROPOSED_ACTIONS_HEADING = '## PROPOSED ACTIONS';

/**
 * Pull the JSON block that follows a `## PROPOSED ACTIONS` heading out of an
 * agent's final message. Tolerant of ```json fences and of the array-only form.
 * Returns [] when the agent said nothing — silence means nothing proposed, and
 * nothing proposed means nothing runs.
 */
export function parseProposedActions(text: string): ProposedAction[] {
  if (!text) return [];
  const idx = text.toUpperCase().indexOf(PROPOSED_ACTIONS_HEADING);
  if (idx === -1) return [];
  const after = text.slice(idx + PROPOSED_ACTIONS_HEADING.length);

  const fenced = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? sliceFirstJson(after);
  if (!candidate) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }

  const asBlock = ProposedActionsBlock.safeParse(parsed);
  if (asBlock.success) return asBlock.data.actions;

  const asArray = z.array(ProposedAction).safeParse(parsed);
  if (asArray.success) return asArray.data;

  return [];
}

/** Grab the first balanced {...} or [...] run of text. */
function sliceFirstJson(s: string): string | null {
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const CHILD_TOOLS = new Set(['Task', 'Agent']);

/** Commands that always mean "something left this machine or changed the world". */
const IRREVERSIBLE_PATTERNS: Array<{ re: RegExp; kind: GateKind }> = [
  { re: /\bgit\s+push\b/, kind: 'push' },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|filter-branch)\b/, kind: 'other' },
  { re: /\bgit\s+(?:merge|rebase)\b/, kind: 'other' },
  { re: /\b(?:vercel|netlify|fly|railway|wrangler|gcloud|aws|kubectl|heroku)\b/, kind: 'deploy' },
  { re: /\bdocker\s+(?:push|run|compose)\b/, kind: 'deploy' },
  { re: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/, kind: 'publish' },
  { re: /\bgh\s+(?:pr|release|repo|issue)\b/, kind: 'publish' },
  { re: /\b(?:curl|wget|http|https)\b/, kind: 'send' },
  { re: /\b(?:npm|pnpm|yarn|brew|pip|pip3|cargo|gem|apt|apt-get)\s+(?:i|install|add|add-global)\b/, kind: 'install' },
  { re: /\brm\s+-[a-z]*[rf]/, kind: 'other' },
  { re: /\b(?:mv|cp)\b\s+\//, kind: 'other' },
  { re: /\bchmod\b|\bchown\b|\bsudo\b/, kind: 'other' },
  { re: />>?\s*\/|\btee\b/, kind: 'write' },
];

export type ClassifiedTool =
  | { decision: 'allow'; reason: string }
  | { decision: 'gate'; kind: GateKind; reason: string };

/**
 * Deterministic classification of a tool call. No LLM in this path — the thing
 * deciding whether something is dangerous must not be the thing being judged.
 */
export function classifyToolUse(args: {
  toolName: string;
  input: Record<string, unknown>;
  allowlist: readonly string[];
  workspacePath: string;
  allowedDomains?: readonly string[];
  /** 0 observe · 1 suggest · 2 stage · 3 execute-in-workspace. */
  autonomy?: number;
  /** How many sub-agents this agent may spawn. 0 means none. */
  maxChildren?: number;
}): ClassifiedTool {
  const { toolName, input, allowlist, workspacePath } = args;
  const autonomy = args.autonomy ?? 1;
  const maxChildren = args.maxChildren ?? 0;

  // Spawning a sub-agent multiplies everything this agent can do, so the
  // max-children setting is a real limit, not a label on a slider.
  if (CHILD_TOOLS.has(toolName)) {
    if (maxChildren <= 0) {
      return { decision: 'gate', kind: 'other', reason: 'max children is 0 — no sub-agents' };
    }
    if (!allowlist.includes(toolName)) {
      return { decision: 'gate', kind: 'other', reason: `${toolName} not in allowlist` };
    }
    return { decision: 'allow', reason: `sub-agent within max children (${maxChildren})` };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const target = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
    if (target && !isInsideWorkspace(target, workspacePath)) {
      return {
        decision: 'gate',
        kind: 'write',
        reason: `write outside workspace: ${target}`,
      };
    }
    if (!allowlist.includes(toolName)) {
      return { decision: 'gate', kind: 'write', reason: `${toolName} not in allowlist` };
    }
    // Autonomy 0 and 1 observe and suggest. They do not touch the disk, even
    // inside the workspace, even with the tool allowlisted.
    if (autonomy < 2) {
      return {
        decision: 'gate',
        kind: 'write',
        reason: `autonomy ${autonomy} may propose changes but not make them`,
      };
    }
    return { decision: 'allow', reason: `${toolName} inside workspace and allowlisted` };
  }

  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    const hit = IRREVERSIBLE_PATTERNS.find((p) => p.re.test(cmd));
    if (hit) return { decision: 'gate', kind: hit.kind, reason: `irreversible command: ${cmd}` };
    if (isReadOnlyBash(cmd)) return { decision: 'allow', reason: 'read-only bash' };
    return { decision: 'gate', kind: 'other', reason: `unclassified bash: ${cmd}` };
  }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const url = String(input.url ?? '');
    const allowed = args.allowedDomains ?? [];
    if (url && allowed.some((d) => hostMatches(url, d))) {
      return { decision: 'allow', reason: `domain allowlisted: ${url}` };
    }
    return { decision: 'gate', kind: 'send', reason: `network fetch: ${url || toolName}` };
  }

  if (allowlist.includes(toolName)) {
    return { decision: 'allow', reason: `${toolName} allowlisted` };
  }

  return { decision: 'gate', kind: 'other', reason: `${toolName} not in allowlist` };
}

export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Any shell chaining hides a second command; make the human look at it.
  if (/[;&|`]|\$\(|>\s|>>/.test(trimmed)) return false;
  return READONLY_BASH_PREFIXES.some(
    (p) => trimmed === p || trimmed.startsWith(`${p} `),
  );
}

export function isInsideWorkspace(target: string, workspace: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  const t = norm(target);
  const w = norm(workspace);
  if (!t.startsWith('/')) return true; // relative paths resolve inside cwd
  if (t.includes('..')) return false;
  return t === w || t.startsWith(`${w}/`);
}

function hostMatches(url: string, domain: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === domain || h.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

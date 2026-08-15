/**
 * The eight non-negotiable laws of Helm.
 *
 * These are not decoration. Each one is enforced structurally somewhere in the
 * bridge; this file is the single source of the text so the console, the
 * generated HELM.md protocol files, and the README all quote the same words.
 */
export const HELM_LAWS = [
  {
    n: 1,
    title: 'Approval-first',
    text: 'No push, deploy, publish, send, install, or destructive file operation executes without an approval row in the database with decided_by = "human" and decision = "approved". Enforcement lives in the bridge, never in the agent.',
  },
  {
    n: 2,
    title: 'No permission bypass',
    text: 'Permission bypass flags are never used anywhere in Helm. The default tool allowlist per agent is Read, Grep, Glob plus read-only Bash, enforced by a permission callback.',
  },
  {
    n: 3,
    title: 'Kill switch',
    text: 'A single endpoint and hotkey terminates or pauses every child process within 2 seconds. Kill state persists across bridge restarts.',
  },
  {
    n: 4,
    title: 'Spend ceiling',
    text: 'Every agent has a daily cost cap and the fleet has one too. At cap the agent parks, logs, and surfaces a banner.',
  },
  {
    n: 5,
    title: 'Concurrency governor',
    text: 'A maximum of N concurrent live sessions (default 3). Project order in the console tree is wake priority; the rest queue.',
  },
  {
    n: 6,
    title: 'Silence is a bug',
    text: 'Every pulse writes a log row even when the finding is "clean".',
  },
  {
    n: 7,
    title: 'Subscription auth',
    text: 'The bridge relies on the machine\'s existing `claude login` credentials. No ANTHROPIC_API_KEY is required or stored. On auth failure the console shows a "run claude login" banner — never a key prompt.',
  },
  {
    n: 8,
    title: 'No unbounded loops',
    text: 'Every loop declares exit conditions, a max-iterations-per-day cap, and a per-run plus per-day budget before it can be enabled. A loop that hits its budget parks and reports.',
  },
] as const;

export type HelmLaw = (typeof HELM_LAWS)[number];

export function lawsAsMarkdown(): string {
  return HELM_LAWS.map((l) => `${l.n}. **${l.title}.** ${l.text}`).join('\n');
}

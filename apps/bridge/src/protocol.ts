import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lawsAsMarkdown,
  PROPOSED_ACTIONS_HEADING,
  type AgentConfig,
  type HelmConfig,
} from '@helm/core';

const START = '<!-- helm:begin -->';
const END = '<!-- helm:end -->';

export interface ProtocolAgent {
  name: string;
  role: string;
  mission: string;
  allowlist: readonly string[];
  autonomy: number;
  heartbeatMinutes: number;
  pulseRoutine?: string;
}

/**
 * HELM.md is the per-project protocol file. It is the agent's standing orders,
 * appended to its system prompt on every session. Everything between the helm
 * markers is regenerated; anything the operator writes outside them survives.
 */
export function renderProtocol(args: {
  projectName: string;
  agents: ProtocolAgent[];
}): string {
  const agentBlocks = args.agents.length
    ? args.agents.map(renderAgentBlock).join('\n\n')
    : '_No agents recruited on this project yet._';

  return `${START}
# HELM PROTOCOL — ${args.projectName}

You are running under Helm, a supervised multi-agent mission control. A human
operator watches every session from a console and holds a kill switch. Read this
file as standing orders that outrank convenience.

## THE LAWS

${lawsAsMarkdown()}

## AGENTS ON THIS PROJECT

${agentBlocks}

## HOW TO PROPOSE AN ACTION YOU CANNOT TAKE

Your tool allowlist is deliberately narrow. When the work needs something
outside it — a push, a deploy, a publish, a network send, an install, or a write
outside this workspace — do NOT try to route around it and do NOT stop silently.
Describe it in your final message under this exact heading:

${PROPOSED_ACTIONS_HEADING}
\`\`\`json
{
  "actions": [
    {
      "kind": "write",
      "label": "fix the install command in the README",
      "detail": "npm install is wrong for this repo",
      "payload": {
        "file": "README.md",
        "old": "Install: run \`npm install\`",
        "new": "Install: run \`pnpm install\`"
      }
    },
    {
      "kind": "push",
      "label": "commit and push the README fix",
      "detail": "one-line change to the install section",
      "payload": { "command": "git add -A && git commit -m 'fix install command' && git push origin main", "cwd": "." }
    }
  ]
}
\`\`\`

\`kind\` is one of: push, deploy, publish, send, write, install, other.

The **payload is what the bridge will actually run**, so it must be complete
and self-contained. Two shapes are supported:

- \`{ "command": "…", "cwd": "." }\` — run a shell command in the project.
- \`{ "file": "path", "old": "…", "new": "…" }\` or \`{ "file": "path", "content": "…" }\`
  — apply a file edit inside the project. \`old\` must appear exactly once.

A proposal with no runnable payload is logged as unexecutable and nothing
happens, so never propose an action you have not fully specified. Order
matters: actions are approved and executed one at a time, in the order listed.
A human approves or denies each one. Approved actions are executed by the
bridge — not by you. If you have nothing to propose, omit the heading entirely.

## HOW TO REPORT A PULSE

Every heartbeat ends with a one-paragraph finding, even when nothing happened.
Start it with \`CLEAN:\` when there is nothing to act on, or \`FINDING:\` when
there is. Silence is a bug — an empty report is treated as a failed pulse.

## WHAT NOT TO DO

- Never attempt to disable, bypass, or argue with the approval gate.
- Never write outside this project directory.
- Never install dependencies or run a package manager without going through the gate.
- Never spawn unbounded background work. If you need a loop, propose it.
${END}
`;
}

function renderAgentBlock(a: ProtocolAgent): string {
  return `### ${a.name} — ${a.role}

**Mission.** ${a.mission || 'No mission set. Ask the operator before acting.'}

**Autonomy.** Level ${a.autonomy}. **Heartbeat.** ${
    a.heartbeatMinutes > 0 ? `every ${a.heartbeatMinutes} min` : 'manual only'
  }.

**Tools you may use without asking.** ${a.allowlist.join(', ')} (plus read-only Bash).

**Every pulse, you:**
${(a.pulseRoutine ?? defaultRoutine()).trim()}`;
}

function defaultRoutine(): string {
  return `1. Read the project state relevant to your mission — do not re-read the whole repo.
2. Compare it against your last finding. Skip anything already marked resolved or known-noise.
3. Report exactly one paragraph: CLEAN, or FINDING with the single most important item.
4. If action is needed and it is outside your allowlist, emit a PROPOSED ACTIONS block.`;
}

/** Write or refresh HELM.md, preserving operator prose outside the markers. */
export function writeProtocolFile(args: {
  projectPath: string;
  projectName: string;
  agents: ProtocolAgent[];
}): string {
  const file = join(args.projectPath, 'HELM.md');
  const block = renderProtocol({ projectName: args.projectName, agents: args.agents });

  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8');
    const s = current.indexOf(START);
    const e = current.indexOf(END);
    if (s !== -1 && e !== -1) {
      const next = current.slice(0, s) + block.trimEnd() + current.slice(e + END.length);
      writeFileSync(file, next, 'utf8');
      return file;
    }
    writeFileSync(file, `${block}\n${current}`, 'utf8');
    return file;
  }

  writeFileSync(file, block, 'utf8');
  return file;
}

/**
 * Regenerate a project's HELM.md from the current config and return its
 * contents. Called before every session so a deleted or stale protocol file
 * cannot silently strip an agent of its standing orders.
 */
export function syncProtocol(
  cfg: HelmConfig,
  project: { id: string; name: string; path: string },
): string {
  const agents = cfg.agents.filter((a) => a.projectId === project.id).map(agentToProtocolAgent);
  const file = writeProtocolFile({
    projectPath: project.path,
    projectName: project.name,
    agents,
  });
  try {
    return readFileSync(file, 'utf8').slice(0, 24_000);
  } catch {
    return renderProtocol({ projectName: project.name, agents });
  }
}

export function agentToProtocolAgent(a: AgentConfig): ProtocolAgent {
  return {
    name: a.name,
    role: a.role,
    mission: a.mission,
    allowlist: a.allowlist,
    autonomy: a.autonomy,
    heartbeatMinutes: a.heartbeatMinutes,
  };
}

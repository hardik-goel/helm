import { PROPOSED_ACTIONS_HEADING } from '@helm/core';

export interface PromptAgent {
  name: string;
  role: string;
  mission: string;
  autonomy: number;
  allowlist: string[];
}

/** First contact, or a manual "run now" from the console. */
export function missionPrompt(agent: PromptAgent, extra?: string): string {
  return [
    `You are ${agent.name}, the ${agent.role} for this project, running under Helm.`,
    '',
    `MISSION: ${agent.mission || 'No mission set — report that and stop.'}`,
    '',
    extra?.trim() ? `OPERATOR INSTRUCTION: ${extra.trim()}` : '',
    '',
    'Work within your allowlist. If you need an action outside it, describe it in a',
    `${PROPOSED_ACTIONS_HEADING} block at the end of your final message instead of attempting it.`,
    'End with a one-paragraph report starting with CLEAN: or FINDING:.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Every heartbeat. Deliberately short — the standing orders live in HELM.md. */
export function pulsePrompt(agent: PromptAgent, sinceIso: string): string {
  return [
    `Heartbeat pulse. Last pulse was ${sinceIso}.`,
    '',
    'Run your standing routine from HELM.md against your mission:',
    `"${agent.mission || 'no mission set'}"`,
    '',
    'Do not re-investigate anything you already reported and resolved. Be brief.',
    'End with exactly one paragraph starting with CLEAN: (nothing to act on) or',
    'FINDING: (the single most important item). Silence is a bug — always report.',
    `If action is needed outside your allowlist, add a ${PROPOSED_ACTIONS_HEADING} block.`,
  ].join('\n');
}

/** Told to the agent after a human denies one of its proposals. */
export function denialNote(label: string): string {
  return (
    `The operator DENIED this proposed action: "${label}". ` +
    'Hold. Do not retry it, do not route around it, and do not propose a variant of ' +
    'the same action. Report what you would need in order for it to be approved.'
  );
}

/** Parses the CLEAN/FINDING report out of a final message. */
export function readPulseReport(finalText: string): { clean: boolean; finding: string } {
  const text = (finalText ?? '').trim();
  const m = /(CLEAN|FINDING)\s*:\s*([\s\S]*)$/i.exec(text);
  if (!m) {
    return {
      clean: false,
      finding: text
        ? `unstructured report: ${text.slice(-600)}`
        : 'agent returned no report (silence is a bug)',
    };
  }
  const clean = m[1]!.toUpperCase() === 'CLEAN';
  return { clean, finding: m[2]!.trim().slice(0, 4000) || (clean ? 'clean' : 'finding with no detail') };
}

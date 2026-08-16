/**
 * The starter loop library, written into ~/.helm/loops on first boot and
 * disabled by default. Each one is a template the operator points at a project
 * by editing the agent names — not something that starts running on its own.
 */
export const STARTER_LOOPS: Array<{ file: string; yaml: string }> = [
  {
    file: 'watchdog.yaml',
    yaml: `# Detect -> diagnose -> gated fix -> verify.
# Point the agent names at your own fleet, then enable from the Loops tab.
name: watchdog
description: Watch a project for regressions, root-cause the novel ones, and stage a fix behind the gate.
trigger:
  type: cron
  every: 15m
bounds:
  max_iterations_per_day: 40
  budget_per_run_usd: 0.25
  budget_per_day_usd: 3.00
memory: true
steps:
  - agent: argus
    do: >-
      Run the standing scan routine for this project. Read loop memory first and
      do not re-investigate anything already marked resolved or known-noise.
      Report novel findings only.
    output: findings
    emits: [finding]

  - when: findings.novel > 0
    agent: argus
    do: >-
      Root-cause the single most important novel finding. Read only what you
      need. Say plainly whether it is fixable in this repo.
    output: diagnosis

  - when: diagnosis.fixable
    agent: vesta
    do: >-
      Implement the smallest correct fix on a branch. Stage the push behind the
      approval gate — do not attempt it yourself.
    gated: true
    output: fix
    emits: [fix-ready]

  - when: fix.applied
    agent: argus
    do: >-
      Verify the fix against the original failing signal. Write the verdict and
      the signature of the resolved finding into loop memory.
    output: verdict
    emits: [verified]

exit:
  - clean
  - fix-verified
  - budget-exhausted
  - iterations-capped
`,
  },
  {
    file: 'content-batch.yaml',
    yaml: `# Weekly content chain: draft -> render manifest -> gated publish queue.
name: content-batch
description: Draft a batch of scripts, build a render manifest, and queue publishing behind the gate.
trigger:
  type: cron
  every: 7d
bounds:
  max_iterations_per_day: 2
  budget_per_run_usd: 1.50
  budget_per_day_usd: 3.00
memory: true
steps:
  - agent: muse
    do: >-
      Draft this week's scripts. Read loop memory for what performed and what
      flopped last cycle, and do not repeat a format that underperformed twice.
    output: drafts

  - when: drafts.count > 0
    agent: muse
    do: Build the render manifest for the approved drafts. Do not render anything yet.
    output: manifest

  - when: manifest.ready
    agent: muse
    do: >-
      Queue the batch for publishing. Every publish is an irreversible action —
      stage it behind the gate with the full payload.
    gated: true
    output: queued
    emits: [publish-queued]

exit:
  - clean
  - queued
  - budget-exhausted
  - iterations-capped
`,
  },
  {
    file: 'compliance-drift.yaml',
    yaml: `# Daily: diff the regulatory registry against live site copy.
name: compliance-drift
description: Compare obligations against the live copy and stage copy fixes behind the gate.
trigger:
  type: cron
  at: "07:30"
bounds:
  max_iterations_per_day: 3
  budget_per_run_usd: 0.50
  budget_per_day_usd: 1.50
memory: true
steps:
  - agent: lex
    do: >-
      Compare the regulatory obligations registry against the current site copy.
      Read loop memory first: skip obligations already audited this cycle.
    output: drift

  - when: drift.count > 0
    agent: lex
    do: >-
      Produce the exact copy fix for each drifted obligation as a file edit
      payload. Stage them behind the gate.
    gated: true
    output: fixes

exit:
  - clean
  - ticket-filed
  - budget-exhausted
  - iterations-capped
`,
  },
  {
    file: 'retro.yaml',
    yaml: `# The meta loop: an agent proposes edits to its own playbook, gated.
name: retro
description: Weekly, read an agent's pulse history and gate decisions, and propose a tighter HELM.md playbook.
trigger:
  type: cron
  every: 7d
bounds:
  max_iterations_per_day: 1
  budget_per_run_usd: 0.40
  budget_per_day_usd: 0.40
memory: true
steps:
  - agent: argus
    do: >-
      Read your own pulse history and the gate decisions on your proposals for
      the last week. Identify the noise you kept reporting and the proposals a
      human kept denying.
    output: retro

  - when: retro.changes > 0
    agent: argus
    do: >-
      Propose the smallest edit to your own section of HELM.md that would have
      prevented that noise. Stage it as a file edit behind the gate — a human
      signs every change to your playbook.
    gated: true
    output: playbook
    emits: [playbook-proposed]

exit:
  - clean
  - playbook-proposed
  - budget-exhausted
  - iterations-capped
`,
  },
  {
    file: 'standup.yaml',
    yaml: `# Daily digest. The bridge assembles it from database rows; the single
# model call only writes the summary paragraph.
name: standup
description: Compile the 24h digest from database rows, with one cheap call for the summary.
trigger:
  type: cron
  at: "08:00"
bounds:
  max_iterations_per_day: 2
  budget_per_run_usd: 0.05
  budget_per_day_usd: 0.10
memory: false
steps:
  - agent: argus
    do: >-
      Read the standup digest the bridge has already compiled and write one
      paragraph a human can read in ten seconds. Do not re-derive the numbers.
    output: summary

exit:
  - clean
  - budget-exhausted
`,
  },
];

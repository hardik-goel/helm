# Helm

Local-first mission control for a fleet of autonomous Claude Code agents.

Helm runs a bridge daemon that spawns and supervises headless Claude Code
sessions across many project folders, schedules recurring pulses, streams live
transcripts into a web console, and holds every irreversible action behind an
approval gate until you clear it. It replaces opening a terminal per project.

Everything runs on your machine: SQLite at `~/.helm/helm.db`, a daemon on
`127.0.0.1:8787`, a console on `127.0.0.1:3777`. No cloud, no API keys.

---

## 60-second quickstart

```bash
# 1. you need Node 20+, pnpm, and an existing Claude Code login
claude login          # if you have not already

# 2. install and start
pnpm install
pnpm helm             # boots the bridge and the console together
```

Open **http://localhost:3777**.

```
3. + project        register a folder you already have
4. + recruit        give it an agent: name, mission, heartbeat
5. run now          watch the session stream in the right rail
6. Gate tab         approve or deny anything irreversible it proposes
```

To go from a build prompt to a running project without touching the terminal,
paste the whole brief into **Launch Pad**. Helm provisions the workspace, runs
`git init`, writes `HELM.md`, registers the project, and hands the brief to a
one-shot builder — then streams the five onboarding steps as they really happen.

`⌘K` opens the command palette (jump anywhere, kill the fleet, recruit).
`Esc` closes everything.

---

## What is where

```
apps/bridge      the daemon: child processes, scheduler, gate, loops, WS server
apps/console     Next.js cockpit at :3777 — not deployed anywhere, it is local
packages/core    shared types, zod schemas for every message on the wire
~/.helm/         helm.db, config.json, loops/*.yaml, transcripts/*.jsonl
```

| Command | What it does |
| --- | --- |
| `pnpm helm` | bridge + console together |
| `pnpm bridge` / `pnpm console` | one at a time |
| `pnpm test` | the whole suite |
| `pnpm typecheck` | strict TypeScript across the workspace |
| `pnpm db:generate` | regenerate the Drizzle migration after a schema change |

`HELM_RUNNER=cli pnpm bridge` swaps the Agent SDK for the CLI fallback.
`HELM_HOME=/tmp/whatever` points Helm at a throwaway home.

---

## Security — the eight laws

These are not documentation of good intentions. Each one is enforced in code, in
the bridge, where the agent cannot reach it.

**1. Approval-first.** No push, deploy, publish, send, install, or destructive
file operation runs without a row in `gate_items` reading
`decided_by = 'human'` and `decision = 'approved'`. `GateService.execute()`
re-reads that row from the database immediately before running anything and
refuses otherwise — an in-memory "approved" flag is not evidence. Approval is
single-use; a replay is refused.

**2. No permission bypass.** Helm never uses `--dangerously-skip-permissions` or
`bypassPermissions`. An ESLint rule fails the build if either string appears in
the source. Every agent starts with `Read, Grep, Glob` plus read-only Bash, and
a `canUseTool` callback classifies every other call deterministically — no model
is asked whether something is dangerous.

**3. Kill switch.** `POST /fleet/kill`, the header button, and the palette all
SIGTERM every child within two seconds and persist the killed state, so a
restarted bridge comes back stopped rather than eagerly resuming.

**4. Spend ceiling.** Every agent has a daily cap and the fleet has one. At cap
an agent parks, logs, and shows a banner; it unparks itself the next day. Cost
comes from the session result's `total_cost_usd`, not an estimate.

**5. Concurrency governor.** At most N concurrent sessions (default 3). Project
order in the tree is wake priority; the rest queue. Dragging the tree changes
who wakes first, and it survives a restart.

**6. Silence is a bug.** Every pulse writes a `pulses` row, clean or not. An
agent that returns nothing is recorded as a failed pulse, not skipped.

**7. Subscription auth.** Helm uses your existing `claude login`. It never asks
for, stores, or reads an API key from this repo — and it strips
`ANTHROPIC_API_KEY` out of every child environment so a stray shell variable
cannot silently move you onto metered billing. On auth failure the console says
"run `claude login`" and never prompts for a key. A single agent or loop may opt
into `billing: api`, with the key read from the OS keychain only.

**8. No unbounded loops.** A loop must declare exit conditions, a
`max_iterations_per_day`, a `budget_per_run_usd`, and a `budget_per_day_usd`.
The zod schema has no defaults for those, so a YAML missing any of them is
refused at registration with a pointed error. A loop that exhausts its daily
budget parks and reports.

Two more things worth knowing:

- **Loop guards are not JavaScript.** A `when:` expression is parsed by a small
  purpose-built evaluator, never `eval`. A loop file on disk is not a trusted
  source of code.
- **The watchers are watched by arithmetic.** The loop health monitor — stuck
  runs, cost anomalies, same-finding thrash — is deterministic code with no
  model call in the path.

---

## Agents and the protocol file

Registering a project writes `HELM.md` into its root. It is regenerated before
every session, so deleting it does not quietly strip an agent of its orders.
It states the mission, the pulse routine, the laws, and the contract for
proposing work the agent is not allowed to do:

````markdown
## PROPOSED ACTIONS
```json
{ "actions": [
  { "kind": "write", "label": "fix the install command",
    "payload": { "file": "README.md", "old": "npm install", "new": "pnpm install" } },
  { "kind": "push", "label": "commit and push it",
    "payload": { "command": "git add -A && git commit -m fix && git push origin main" } }
] }
```
````

The bridge parses that into gate items. This is the *second* layer — the
permission callback already blocks the session in real time — and both funnel
into the same table, so nothing gets through by taking the other path.

---

## Loops

A loop is a declared, bounded, compounding workflow. It lives in
`~/.helm/loops/*.yaml`, and the difference between a loop and a cron job is
memory: what each run learns is injected into the next one's prompt, so run
forty is cheaper and sharper than run one.

```yaml
name: watchdog
trigger: { type: cron, every: 15m }
bounds:                        # all three required, or registration fails
  max_iterations_per_day: 40
  budget_per_run_usd: 0.25
  budget_per_day_usd: 3.00
memory: true
steps:
  - agent: argus
    do: Run the standing scan. Skip anything memory records as resolved.
    output: findings
  - when: findings.novel > 0
    agent: vesta
    do: Implement the fix. Stage the push behind the gate.
    gated: true               # parks the run until a human decides
exit: [clean, fix-verified, budget-exhausted, iterations-capped]
```

A `gated: true` step parks the run in the database, so it survives a bridge
restart and resumes when you approve. Steps emit typed events that other loops
can trigger on, which is how detection hands off to repair without a human
wiring the two together.

Five starters are written to `~/.helm/loops` on first boot, all **disabled**:
`watchdog`, `content-batch`, `compliance-drift`, `retro`, `standup`. Point them
at your own agents and enable them from the Loops tab. Enabling is refused if a
step names an agent that does not exist.

`retro` is the meta one: weekly, an agent reads its own pulse history and gate
decisions and proposes an edit to its own `HELM.md` playbook — as a gated diff.
Agents that improve their own instructions, with a human signing every change.

Loops export and import as bundles (`GET /loops/:id/export`,
`POST /loops/import`); imported loops always arrive disabled and are validated
exactly like local ones.

---

## Transcripts

Every session writes `~/.helm/transcripts/<session_id>.jsonl`, containing both
role-coded lines and the raw message stream. The transcript drawer renders the
readable version and live-tails a running session; `?raw=1` on the transcript
endpoint returns everything, including the reminders the CLI injected. If an
agent ever tells you it was instructed to do something, that file is how you
check.

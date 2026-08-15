import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ids, slugify, type LaunchStepMsg } from '@helm/core';
import type { Runtime } from './runtime.js';
import type { Supervisor } from './supervisor.js';
import { reconcileConfigToDb } from './reconcile.js';
import { syncProtocol } from './protocol.js';
import { expandTilde } from './paths.js';

export interface LaunchRequest {
  prompt: string;
  name?: string;
  model?: string;
}

export interface LaunchResult {
  launchId: string;
  projectId: string;
  agentId: string;
  path: string;
  name: string;
}

const STOPWORDS = new Set([
  'build',
  'create',
  'make',
  'write',
  'a',
  'an',
  'the',
  'me',
  'my',
  'that',
  'which',
  'please',
  'app',
  'project',
  'tool',
  'simple',
  'small',
  'new',
]);

/**
 * Name a launch without spending a token. The first few meaningful words of a
 * build prompt are a better slug than anything an LLM would invent, and this
 * runs in the control path where determinism matters more than elegance.
 */
export function inferProjectName(prompt: string): string {
  const words = prompt
    .replace(/[`"'*_#]/g, ' ')
    .split(/[^A-Za-z0-9+.-]+/)
    .filter(Boolean);

  const picked: string[] = [];
  for (const w of words) {
    if (picked.length >= 5) break;
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    picked.push(lower);
  }
  return slugify(picked.join('-')) || 'launch';
}

/** Pick a directory name that does not collide with an existing workspace. */
export function uniqueWorkspace(root: string, slug: string): string {
  let candidate = join(root, slug);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(root, `${slug}-${n++}`);
  }
  return candidate;
}

/**
 * Provision a workspace, register it, and hand the pasted prompt to a builder
 * agent. Every step emits a WS event so the console animates from reality
 * rather than from a timer.
 */
export class LaunchPad {
  constructor(
    private readonly rt: Runtime,
    private readonly sup: Supervisor,
  ) {}

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    const launchId = ids.event();
    const gov = this.rt.config.get().governor;
    const name = (req.name?.trim() || inferProjectName(req.prompt)).slice(0, 60);
    const slug = slugify(name);

    const step = (
      s: LaunchStepMsg['step'],
      state: LaunchStepMsg['state'],
      detail?: string,
      extra?: { projectId?: string; agentId?: string },
    ) => {
      this.rt.send({
        type: 'launch.step',
        launchId,
        step: s,
        state,
        detail,
        projectId: extra?.projectId ?? null,
        agentId: extra?.agentId ?? null,
        at: Date.now(),
      });
    };

    // 1 — workspace
    step('workspace', 'active');
    const root = expandTilde(gov.launchRoot);
    mkdirSync(root, { recursive: true });
    const path = uniqueWorkspace(root, slug);
    mkdirSync(path, { recursive: true });
    step('workspace', 'done', path);

    // 2 — git
    step('git', 'active');
    try {
      execFileSync('git', ['init', '-q'], { cwd: path, stdio: 'ignore' });
      step('git', 'done', 'repository initialised');
    } catch (err) {
      step('git', 'failed', (err as Error).message);
    }

    // 3 — register project + builder agent
    step('register', 'active');
    const projectId = ids.project();
    const agentId = ids.agent();
    const cfg = this.rt.config.update((draft) => {
      // New launches go to the top of the tree: they are the thing being watched.
      for (const p of draft.projects) p.order += 1;
      draft.projects.unshift({
        id: projectId,
        name,
        path,
        url: null,
        tag: 'new',
        order: 0,
      });
      draft.agents.push({
        id: agentId,
        projectId,
        name: 'One-Shot Builder',
        role: 'builder',
        model: req.model ?? draft.governor.defaultModel,
        mission: firstLine(req.prompt),
        autonomy: 2,
        heartbeatMinutes: 10,
        maxChildren: 0,
        allowlist: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
        allowedDomains: [],
        dailyCapUsd: 5,
        maxTurns: 60,
        billing: 'subscription',
        keychainAccount: null,
      });
      return draft;
    });
    reconcileConfigToDb(this.rt.db, cfg);
    step('register', 'done', name, { projectId, agentId });

    // 4 — protocol file
    step('protocol', 'active');
    syncProtocol(cfg, { id: projectId, name, path });
    step('protocol', 'done', 'HELM.md written');

    this.rt.event({
      projectId,
      agentId,
      message: `launch pad: ${name} provisioned at ${path}`,
    });
    this.rt.broadcastFleet({ running: this.sup.running(), queued: this.sup.queued() });

    // 5 — hand the prompt to the builder
    step('session', 'active');
    this.sup
      .request({ agentId, trigger: 'launch', prompt: buildPrompt(req.prompt), resume: false })
      .then(() => step('session', 'done', 'builder session finished'))
      .catch((err: Error) => step('session', 'failed', err.message));

    return { launchId, projectId, agentId, path, name };
  }
}

function firstLine(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 300);
}

/**
 * The pasted prompt, wrapped in the one thing it cannot know: that it is
 * running under supervision and must route irreversible work through the gate.
 */
function buildPrompt(pasted: string): string {
  return [
    'You are the one-shot builder for this new, empty workspace. Build what the',
    'brief below asks for, working phase by phase and verifying as you go.',
    '',
    'You may create and edit files inside this workspace without asking. Anything',
    'else — installing dependencies, running package managers, pushing, deploying,',
    'publishing, or fetching from the network — must be described in a',
    '## PROPOSED ACTIONS block at the end of your message and approved by a human.',
    'Read HELM.md in this directory first; it is your standing protocol.',
    '',
    '--- BRIEF ---',
    pasted,
  ].join('\n');
}

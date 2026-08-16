import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Everything Helm owns lives under ~/.helm. Overridable with HELM_HOME so the
 * test suite never touches the operator's real fleet.
 */
export const HELM_HOME = process.env.HELM_HOME
  ? resolve(expandTilde(process.env.HELM_HOME))
  : join(homedir(), '.helm');

export const paths = {
  home: HELM_HOME,
  db: join(HELM_HOME, 'helm.db'),
  config: join(HELM_HOME, 'config.json'),
  transcripts: join(HELM_HOME, 'transcripts'),
  loops: join(HELM_HOME, 'loops'),
  state: join(HELM_HOME, 'state.json'),
  logs: join(HELM_HOME, 'logs'),
};

export function ensureHelmDirs(): void {
  for (const dir of [paths.home, paths.transcripts, paths.loops, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

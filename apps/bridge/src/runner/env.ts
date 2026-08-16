import { execFileSync } from 'node:child_process';

/**
 * Law 7. Helm runs on the operator's `claude login` credentials. We strip
 * ANTHROPIC_API_KEY out of the child environment rather than merely not
 * setting it, so a key sitting in the shell profile cannot silently move a
 * subscription agent onto metered billing.
 */
export function childEnv(billing: 'subscription' | 'api', apiKey?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_URL;

  if (billing === 'api') {
    if (!apiKey) throw new Error('agent is flagged billing:"api" but no key was resolved');
    env.ANTHROPIC_API_KEY = apiKey;
  }

  // Keep child output machine-parseable and free of interactive affordances.
  env.CI = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

/**
 * The only place an API key may come from is the OS keychain — never a file in
 * a repo, never config.json, never an env var checked into a dotfile.
 */
export function readKeychainKey(account: string, service = 'helm-anthropic'): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

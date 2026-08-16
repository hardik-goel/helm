/**
 * Prefixed ids, readable in logs and URLs. Uses the Web Crypto API so this
 * module stays importable from the console bundle as well as the bridge.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomHex(20)}`;
}

function randomHex(len: number): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, len);
  const bytes = new Uint8Array(Math.ceil(len / 2));
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

export const ids = {
  project: () => newId('prj'),
  agent: () => newId('agt'),
  session: () => newId('ses'),
  pulse: () => newId('pls'),
  gateItem: () => newId('gat'),
  event: () => newId('evt'),
  loop: () => newId('lop'),
  loopRun: () => newId('lrn'),
};

/** URL/folder-safe slug used for launch-pad workspace names. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'untitled';
}

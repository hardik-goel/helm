'use client';

import { useCallback, useEffect, useState } from 'react';
import { BRIDGE_HTTP } from '@/lib/bridge';

interface StandupProject {
  projectId: string;
  name: string;
  moved: string[];
  blocked: string[];
  waiting: string[];
  sessions: number;
  costUsd: number;
  cleanPulses: number;
  findings: number;
}

interface Digest {
  generatedAt: number;
  windowHours: number;
  totalCostUsd: number;
  projects: StandupProject[];
}

export function StandupTab() {
  const [hours, setHours] = useState(24);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    fetch(`${BRIDGE_HTTP}/standup?hours=${hours}`)
      .then((r) => r.json())
      .then((r: { digest: Digest; markdown: string }) => {
        setDigest(r.digest);
        setMarkdown(r.markdown);
      })
      .catch((e: Error) => setErr(e.message));
  }, [hours]);

  useEffect(load, [load]);

  if (err) return <div className="banner red">standup unavailable — {err}</div>;
  if (!digest) return <div className="empty">building the digest…</div>;

  const active = digest.projects.filter(
    (p) => p.sessions > 0 || p.moved.length || p.blocked.length || p.waiting.length,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setErr('clipboard blocked by the browser');
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <span className="micro">
          standup — last {digest.windowHours}h · ${digest.totalCostUsd.toFixed(2)} spent
        </span>
        <div className="row">
          <select
            className="select"
            style={{ width: 110 }}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            aria-label="standup window"
          >
            <option value={6}>last 6h</option>
            <option value={24}>last 24h</option>
            <option value={72}>last 3d</option>
            <option value={168}>last 7d</option>
          </select>
          <button className="btn" onClick={load}>
            refresh
          </button>
          <button className="btn amber" onClick={copy}>
            {copied ? 'copied' : 'copy as markdown'}
          </button>
        </div>
      </div>

      {active.length === 0 && (
        <div className="empty">
          Nothing ran in this window.
          <br />
          That is either a quiet fleet or a stopped one — check the kill switch.
        </div>
      )}

      {active.map((p) => (
        <div key={p.projectId} className="card" style={{ padding: 12 }}>
          <div className="spread">
            <strong>{p.name}</strong>
            <span className="micro">
              {p.sessions} sessions · ${p.costUsd.toFixed(2)} · {p.cleanPulses} clean ·{' '}
              {p.findings} findings
            </span>
          </div>
          <Section title="what moved" items={p.moved} tone="var(--mint)" />
          <Section title="blocked" items={p.blocked} tone="var(--red)" />
          <Section title="waiting on you" items={p.waiting} tone="var(--amber)" />
        </div>
      ))}
    </div>
  );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="micro" style={{ color: items.length ? tone : undefined }}>
        {title} {items.length ? `(${items.length})` : ''}
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--ink-faint)' }}>nothing</div>
      ) : (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--ink-dim)', lineHeight: 1.7 }}>
          {items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

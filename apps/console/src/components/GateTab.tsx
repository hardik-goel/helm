'use client';

import { useEffect, useState } from 'react';
import type { GateItem } from '@helm/core';
import { bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';
import { time } from './TopBar';

const KIND_CLASS: Record<string, string> = {
  push: 'chip red',
  deploy: 'chip red',
  publish: 'chip red',
  send: 'chip amber',
  install: 'chip amber',
  write: 'chip amber',
  other: 'chip',
};

export function GateTab() {
  const gate = useHelm((s) => s.gate);
  const seedGate = useHelm((s) => s.seedGate);
  const fleet = useHelm((s) => s.fleet);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  useEffect(() => {
    bridge
      .gate()
      .then((r) => seedGate(r.items))
      .catch(() => {});
  }, [seedGate]);

  const pending = gate.filter((g) => g.status === 'pending');
  const decided = gate.filter((g) => g.status !== 'pending').slice(0, 40);
  const nameOf = (id: string) => fleet?.agents.find((a) => a.id === id)?.name ?? id.slice(0, 10);

  async function act(fn: () => Promise<unknown>, id: string) {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      const r = await bridge.gate();
      seedGate(r.items);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <span className="micro">approval gate — {pending.length} waiting on you</span>
        <div className="row">
          <button
            className="btn"
            onClick={() => setShowDecided((v) => !v)}
            aria-pressed={showDecided}
          >
            {showDecided ? 'hide history' : 'show history'}
          </button>
          <button
            className="btn amber"
            disabled={pending.length === 0 || busy !== null}
            onClick={() => act(() => bridge.approveAll(), 'all')}
          >
            approve all ({pending.length})
          </button>
        </div>
      </div>

      {err && <div className="banner red">{err}</div>}

      {pending.length === 0 && (
        <div className="empty">
          Nothing is waiting.
          <br />
          Agents hold here whenever they want to push, deploy, publish, send, install, or write
          outside their workspace.
        </div>
      )}

      {pending.map((item) => (
        <GateCard
          key={item.id}
          item={item}
          agentName={nameOf(item.agentId)}
          busy={busy === item.id}
          onApprove={() => act(() => bridge.approve(item.id), item.id)}
          onDeny={() => act(() => bridge.deny(item.id), item.id)}
        />
      ))}

      {showDecided && (
        <>
          <div className="micro">history</div>
          {decided.map((item) => (
            <div key={item.id} className="card" style={{ padding: 10 }}>
              <div className="spread">
                <span className="row">
                  <span className={KIND_CLASS[item.kind] ?? 'chip'}>{item.kind}</span>
                  <span>{item.label}</span>
                </span>
                <span
                  className={`chip ${item.status === 'approved' ? 'mint' : item.status === 'denied' ? 'red' : ''}`}
                >
                  {item.status}
                  {item.decidedBy ? ` · ${item.decidedBy}` : ''}
                </span>
              </div>
              <div className="micro" style={{ marginTop: 4 }}>
                {nameOf(item.agentId)} · {time(item.decidedAt ?? item.createdAt)}
              </div>
            </div>
          ))}
          {decided.length === 0 && <div className="empty">No decisions yet.</div>}
        </>
      )}
    </div>
  );
}

function GateCard({
  item,
  agentName,
  busy,
  onApprove,
  onDeny,
}: {
  item: GateItem;
  agentName: string;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const payload = item.payload ? JSON.stringify(item.payload, null, 2) : null;
  return (
    <div className="card slide-up" style={{ padding: 12, borderColor: 'var(--amber-dim)' }}>
      <div className="spread">
        <span className="row">
          <span className={KIND_CLASS[item.kind] ?? 'chip'}>{item.kind}</span>
          <strong>{item.label}</strong>
        </span>
        <span className="micro">
          {agentName} · {time(item.createdAt)}
        </span>
      </div>

      {item.detail && (
        <div style={{ color: 'var(--ink-dim)', marginTop: 6 }}>{item.detail}</div>
      )}

      {payload && (
        <details style={{ marginTop: 8 }}>
          <summary className="micro" style={{ cursor: 'pointer' }}>
            payload
          </summary>
          <pre className="mono-pre" style={{ marginTop: 6 }}>
            {payload}
          </pre>
        </details>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn mint" disabled={busy} onClick={onApprove}>
          approve
        </button>
        <button className="btn danger" disabled={busy} onClick={onDeny}>
          deny
        </button>
        <span className="micro" style={{ marginLeft: 'auto' }}>
          the session is blocked until you decide
        </span>
      </div>
    </div>
  );
}

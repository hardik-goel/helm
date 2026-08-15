'use client';

import { useState } from 'react';
import { bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';

export function TopBar() {
  const fleet = useHelm((s) => s.fleet);
  const events = useHelm((s) => s.events);
  const connection = useHelm((s) => s.connection);
  const setPalette = useHelm((s) => s.setPalette);
  const [busy, setBusy] = useState(false);

  const latest = events[events.length - 1];
  const killed = fleet?.killed ?? false;
  const spend = fleet?.spendTodayUsd ?? 0;
  const cap = fleet?.fleetCapUsd ?? 0;

  async function toggleKill() {
    setBusy(true);
    try {
      if (killed) await bridge.resumeFleet();
      else await bridge.kill('console');
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      <span className="brand">helm</span>

      <span className="ticker" title={latest?.message ?? ''}>
        {connection === 'live' ? (
          latest ? (
            <>
              <span className="feed-time">{time(latest.createdAt)}</span> {latest.message}
            </>
          ) : (
            <span style={{ color: 'var(--ink-faint)' }}>fleet quiet</span>
          )
        ) : (
          <span style={{ color: 'var(--red)' }}>
            {connection === 'connecting' ? 'connecting to bridge…' : 'bridge offline'}
          </span>
        )}
      </span>

      <span className="micro" title="running / governor cap">
        {fleet?.governor.running ?? 0}/{fleet?.governor.maxConcurrent ?? 0} live
      </span>
      <span
        className="micro"
        style={{ color: cap > 0 && spend >= cap ? 'var(--red)' : undefined }}
        title="fleet spend today / daily cap"
      >
        ${spend.toFixed(2)}/${cap.toFixed(0)}
      </span>

      <button className="btn" onClick={() => setPalette(true)} title="Command palette (⌘K)">
        ⌘K
      </button>
      <button
        className={`btn ${killed ? 'mint' : 'danger'}`}
        onClick={toggleKill}
        disabled={busy || connection !== 'live'}
        title={killed ? 'Resume the fleet' : 'Kill every child process now (⌘⇧K)'}
      >
        {killed ? 'resume fleet' : 'kill'}
      </button>
    </header>
  );
}

export function Banners() {
  const fleet = useHelm((s) => s.fleet);
  const connection = useHelm((s) => s.connection);

  const spend = fleet?.spendTodayUsd ?? 0;
  const cap = fleet?.fleetCapUsd ?? 0;

  return (
    <>
      {connection === 'offline' && (
        <div className="banner red">
          <strong>bridge offline</strong>
          <span>
            the daemon at 127.0.0.1 is not answering — start it with <code>pnpm helm</code>
          </span>
        </div>
      )}
      {fleet && !fleet.authOk && (
        <div className="banner red">
          <strong>auth required</strong>
          <span>
            run <code>claude login</code> in a terminal, then resume the fleet. Helm never asks for
            an API key.
          </span>
        </div>
      )}
      {fleet?.killed && (
        <div className="banner red">
          <strong>fleet killed</strong>
          <span>every child process is stopped and nothing will wake until you resume.</span>
        </div>
      )}
      {cap > 0 && spend >= cap && (
        <div className="banner amber">
          <strong>fleet spend cap reached</strong>
          <span>
            ${spend.toFixed(2)} of ${cap.toFixed(2)} today — no agent wakes until tomorrow.
          </span>
        </div>
      )}
    </>
  );
}

export function time(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

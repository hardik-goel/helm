'use client';

import { useEffect, useRef } from 'react';
import { useHelm } from '@/lib/store';
import { Avatar } from './Avatar';
import { StatusDot } from './StatusDot';
import { time } from './TopBar';

export function RightRail() {
  return (
    <div className="pane" aria-label="live sessions and pulse feed">
      <LiveSessions />
      <PulseFeed />
    </div>
  );
}

function LiveSessions() {
  const fleet = useHelm((s) => s.fleet);
  const agentState = useHelm((s) => s.agentState);
  const setDrawer = useHelm((s) => s.setDrawer);
  const select = useHelm((s) => s.select);

  const active = (fleet?.agents ?? []).filter((a) => {
    const st = agentState[a.id]?.status ?? a.status;
    return st === 'running' || st === 'waiting-gate' || st === 'queued';
  });

  return (
    <>
      <div className="pane-head">
        <span className="micro">live sessions</span>
        <span className="micro">{active.length}</span>
      </div>

      {active.length === 0 && <div className="empty">No agent is awake right now.</div>}

      <div style={{ display: 'grid', gap: 8, padding: '0 12px 12px' }}>
        {active.map((a) => {
          const st = agentState[a.id];
          const status = st?.status ?? a.status;
          const turns = st?.turns ?? 0;
          const pct = Math.min(100, Math.round((turns / Math.max(1, 30)) * 100));
          return (
            <div key={a.id} className="card slide-up" style={{ padding: 10 }}>
              <div className="spread">
                <span className="row">
                  <StatusDot status={status} />
                  <Avatar name={a.name} size={16} />
                  <strong>{a.name}</strong>
                </span>
                <span className="micro">{a.model.replace('claude-', '')}</span>
              </div>
              <div className="bar" style={{ margin: '8px 0 6px' }}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="spread micro">
                <span>{status === 'waiting-gate' ? 'blocked at gate' : `${turns} turns`}</span>
                <span>${(st?.costUsdToday ?? 0).toFixed(3)} today</span>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => select(a.id, a.projectId)}>
                  mission
                </button>
                <button
                  className="btn"
                  disabled={!st?.sessionId}
                  onClick={() => st?.sessionId && setDrawer(st.sessionId)}
                >
                  transcript
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function PulseFeed() {
  const events = useHelm((s) => s.events);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <>
      <div className="pane-head" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="micro">pulse feed</span>
        <span className="micro">last {Math.min(events.length, 50)}</span>
      </div>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        style={{ maxHeight: '46vh', overflowY: 'auto', paddingBottom: 12 }}
      >
        {events.length === 0 && <div className="empty">No events yet.</div>}
        {events.slice(-50).map((e) => (
          <div key={e.id} className={`feed-line ${e.level}`}>
            <span className="feed-time">{time(e.createdAt)}</span>
            <span style={{ minWidth: 0 }}>{e.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { AUTONOMY_LABELS, HELM_LAWS, type Agent } from '@helm/core';
import { BRIDGE_HTTP, bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';
import { Avatar } from './Avatar';
import { StatusDot } from './StatusDot';

export function MissionTab() {
  const fleet = useHelm((s) => s.fleet);
  const agentId = useHelm((s) => s.selectedAgentId);
  const agentState = useHelm((s) => s.agentState);
  const setRecruit = useHelm((s) => s.setRecruit);
  const setDrawer = useHelm((s) => s.setDrawer);

  const agent = fleet?.agents.find((a) => a.id === agentId) ?? null;
  const project = fleet?.projects.find((p) => p.id === agent?.projectId) ?? null;

  if (!agent) {
    return (
      <div className="empty">
        No agent selected.
        <br />
        Pick one from the tree, or{' '}
        <button className="btn amber" onClick={() => setRecruit(true)}>
          recruit
        </button>{' '}
        one.
      </div>
    );
  }

  const status = agentState[agent.id]?.status ?? agent.status;
  const sessionId = agentState[agent.id]?.sessionId ?? null;

  return (
    <div className="stack">
      <div className="spread">
        <div className="row">
          <Avatar name={agent.name} size={34} />
          <div>
            <div className="row">
              <StatusDot status={status} />
              <strong style={{ fontSize: 14 }}>{agent.name}</strong>
              <span className="chip">{agent.role}</span>
              <span className="chip">{agent.model.replace('claude-', '')}</span>
              <span className="chip">{AUTONOMY_LABELS[agent.autonomy]}</span>
            </div>
            <div className="micro" style={{ marginTop: 4 }}>
              {project?.name} · {project?.path}
            </div>
          </div>
        </div>
        <AgentActions agent={agent} status={status} sessionId={sessionId} onDrawer={setDrawer} />
      </div>

      <MissionEditor agent={agent} />
      <PulseRoutine agent={agent} />
      <Controls agent={agent} />
      <RetroToggle agent={agent} />
      <Laws />
    </div>
  );
}

function AgentActions({
  agent,
  status,
  sessionId,
  onDrawer,
}: {
  agent: Agent;
  status: Agent['status'];
  sessionId: string | null;
  onDrawer: (id: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const killed = useHelm((s) => s.fleet?.killed ?? false);

  const wrap = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const paused = status === 'paused';

  return (
    <div style={{ textAlign: 'right' }}>
      <div className="row">
        <button
          className="btn amber"
          disabled={busy || killed || status === 'running' || status === 'queued'}
          onClick={wrap(() => bridge.runAgent(agent.id))}
          title={killed ? 'the fleet is killed — resume it first' : 'wake this agent now'}
        >
          run now
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={wrap(() => (paused ? bridge.resumeAgent(agent.id) : bridge.pauseAgent(agent.id)))}
        >
          {paused ? 'resume' : 'pause'}
        </button>
        <button className="btn" disabled={!sessionId} onClick={() => onDrawer(sessionId)}>
          transcript
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={wrap(async () => {
            if (!confirm(`Decommission ${agent.name}? Its history is archived, not deleted.`)) return;
            await bridge.decommissionAgent(agent.id);
          })}
        >
          decommission
        </button>
      </div>
      {err && (
        <div className="micro" style={{ color: 'var(--red)', marginTop: 6 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function MissionEditor({ agent }: { agent: Agent }) {
  const [text, setText] = useState(agent.mission);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    setText(agent.mission);
    setSaved(true);
  }, [agent.id, agent.mission]);

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="spread" style={{ marginBottom: 6 }}>
        <span className="micro">mission</span>
        <button
          className="btn amber"
          disabled={saved}
          onClick={async () => {
            await bridge.patchAgent(agent.id, { mission: text });
            setSaved(true);
          }}
        >
          save
        </button>
      </div>
      <textarea
        className="textarea"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        placeholder="What is this agent responsible for, in one paragraph?"
      />
      <div className="micro" style={{ marginTop: 6 }}>
        saved to HELM.md in the project root on every change
      </div>
    </div>
  );
}

function PulseRoutine({ agent }: { agent: Agent }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="micro" style={{ marginBottom: 6 }}>
        every pulse, {agent.name}
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-dim)', lineHeight: 1.9 }}>
        <li>reads only what its mission needs — never the whole repo</li>
        <li>compares against its last finding, skipping known-noise</li>
        <li>reports one paragraph: CLEAN, or FINDING with the single most important item</li>
        <li>describes anything outside its allowlist as a proposed action for the gate</li>
      </ol>
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <span className="micro">tools</span>
        {agent.allowlist.map((t) => (
          <span key={t} className="chip mint">
            {t}
          </span>
        ))}
        <span className="chip mint">read-only bash</span>
      </div>
    </div>
  );
}

function Controls({ agent }: { agent: Agent }) {
  const [heartbeat, setHeartbeat] = useState(agent.heartbeatMinutes);
  const [children, setChildren] = useState(agent.maxChildren);
  const [cap, setCap] = useState(agent.dailyCapUsd);
  const [autonomy, setAutonomy] = useState<number>(agent.autonomy);

  useEffect(() => {
    setHeartbeat(agent.heartbeatMinutes);
    setChildren(agent.maxChildren);
    setCap(agent.dailyCapUsd);
    setAutonomy(agent.autonomy);
  }, [agent.id, agent.heartbeatMinutes, agent.maxChildren, agent.dailyCapUsd, agent.autonomy]);

  const push = (patch: Record<string, unknown>) => void bridge.patchAgent(agent.id, patch);

  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 12 }}>
      <div>
        <div className="spread">
          <span className="micro">heartbeat</span>
          <span>{heartbeat === 0 ? 'manual only' : `every ${heartbeat} min`}</span>
        </div>
        <input
          type="range"
          min={0}
          max={240}
          step={5}
          value={heartbeat}
          onChange={(e) => setHeartbeat(Number(e.target.value))}
          onMouseUp={() => push({ heartbeatMinutes: heartbeat })}
          onKeyUp={() => push({ heartbeatMinutes: heartbeat })}
          style={{ width: '100%' }}
        />
      </div>

      <div>
        <div className="spread">
          <span className="micro">max children</span>
          <span>{children}</span>
        </div>
        <input
          type="range"
          min={0}
          max={5}
          value={children}
          onChange={(e) => setChildren(Number(e.target.value))}
          onMouseUp={() => push({ maxChildren: children })}
          onKeyUp={() => push({ maxChildren: children })}
          style={{ width: '100%' }}
        />
      </div>

      <div className="spread">
        <span className="micro">autonomy</span>
        <select
          className="select"
          style={{ width: 220 }}
          value={autonomy}
          onChange={(e) => {
            const v = Number(e.target.value);
            setAutonomy(v);
            push({ autonomy: v });
          }}
        >
          {[0, 1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n} — {AUTONOMY_LABELS[n]}
            </option>
          ))}
        </select>
      </div>

      <div className="spread">
        <span className="micro">daily cap (usd)</span>
        <input
          className="input"
          style={{ width: 220 }}
          type="number"
          min={0}
          step={0.25}
          value={cap}
          onChange={(e) => setCap(Number(e.target.value))}
          onBlur={() => push({ dailyCapUsd: cap })}
        />
      </div>
    </div>
  );
}

/**
 * The meta loop, enabled per agent: weekly, it reads this agent's own pulse
 * history and gate decisions and proposes an edit to its own playbook — as a
 * gated diff a human signs.
 */
function RetroToggle({ agent }: { agent: Agent }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    fetch(`${BRIDGE_HTTP}/loops/retro/for/${agent.id}`)
      .then((r) => r.json())
      .then((r: { enabled: boolean }) => setEnabled(r.enabled))
      .catch(() => setEnabled(false));
  }, [agent.id]);

  async function toggle() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${BRIDGE_HTTP}/loops/retro/for/${agent.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const body = (await res.json()) as { enabled?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'could not change the retro loop');
      setEnabled(!!body.enabled);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="spread">
        <div style={{ maxWidth: 520 }}>
          <div className="micro">weekly retro</div>
          <div style={{ color: 'var(--ink-dim)', marginTop: 4 }}>
            {agent.name} reads its own pulse history and your gate decisions once a week, then
            proposes a tighter <code>HELM.md</code> playbook. The diff goes to the gate — you sign
            every change to how it works.
          </div>
        </div>
        <button
          className={enabled ? 'btn mint' : 'btn'}
          disabled={busy}
          onClick={toggle}
          aria-pressed={enabled}
        >
          {enabled ? 'enabled' : 'enable'}
        </button>
      </div>
      {err && (
        <div className="micro" style={{ color: 'var(--red)', marginTop: 6 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function Laws() {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="micro" style={{ marginBottom: 8 }}>
        the laws — enforced in the bridge, not asked of the agent
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-dim)', lineHeight: 1.8 }}>
        {HELM_LAWS.map((l) => (
          <li key={l.n} style={{ marginBottom: 4 }}>
            <span style={{ color: 'var(--ink)' }}>{l.title}.</span> {l.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

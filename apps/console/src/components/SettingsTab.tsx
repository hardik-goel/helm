'use client';

import { useEffect, useState } from 'react';
import { AUTONOMY_LABELS, type Agent, type GovernorConfig } from '@helm/core';
import { bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';

export function SettingsTab() {
  const fleet = useHelm((s) => s.fleet);
  const [gov, setGov] = useState<GovernorConfig | null>(null);
  const [saved, setSaved] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    bridge
      .config()
      .then((r) => setGov(r.config.governor))
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (!gov) {
    return <div className="empty">{err ?? 'loading settings…'}</div>;
  }

  const set = <K extends keyof GovernorConfig>(k: K, v: GovernorConfig[K]) => {
    setGov({ ...gov, [k]: v });
    setSaved(false);
  };

  async function save() {
    setErr(null);
    try {
      await bridge.patchGovernor(gov as unknown as Record<string, unknown>);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <span className="micro">fleet settings</span>
        <button className="btn amber" disabled={saved} onClick={save}>
          save
        </button>
      </div>
      {err && <div className="banner red">{err}</div>}

      <div className="card" style={{ padding: 12, display: 'grid', gap: 12 }}>
        <Field
          label="governor — max concurrent sessions"
          hint="Keeps Helm inside your subscription rate limits. Project tree order is wake priority."
        >
          <input
            className="input"
            style={{ width: 120 }}
            type="number"
            min={1}
            max={12}
            value={gov.maxConcurrent}
            onChange={(e) => set('maxConcurrent', Number(e.target.value))}
          />
        </Field>

        <Field label="fleet daily cap (usd)" hint="At this number every agent parks until tomorrow.">
          <input
            className="input"
            style={{ width: 120 }}
            type="number"
            min={0}
            step={1}
            value={gov.fleetDailyCapUsd}
            onChange={(e) => set('fleetDailyCapUsd', Number(e.target.value))}
          />
        </Field>

        <Field label="default model" hint="Used for new agents and one-shot builders.">
          <input
            className="input"
            style={{ width: 260 }}
            value={gov.defaultModel}
            onChange={(e) => set('defaultModel', e.target.value)}
          />
        </Field>

        <Field label="launch root" hint="Where the Launch Pad provisions new workspaces.">
          <input
            className="input"
            style={{ width: 260 }}
            value={gov.launchRoot}
            onChange={(e) => set('launchRoot', e.target.value)}
          />
        </Field>

        <Field label="gate ttl (minutes)" hint="Pending approvals older than this expire instead of blocking forever.">
          <input
            className="input"
            style={{ width: 120 }}
            type="number"
            min={1}
            value={gov.gateTtlMinutes}
            onChange={(e) => set('gateTtlMinutes', Number(e.target.value))}
          />
        </Field>
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div className="micro" style={{ marginBottom: 8 }}>
          agents — edit any of them here without leaving the fleet view
        </div>
        {(fleet?.agents ?? []).length === 0 && <div className="empty">No agents yet.</div>}
        {(fleet?.agents ?? []).map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            projectName={fleet?.projects.find((p) => p.id === a.projectId)?.name ?? ''}
          />
        ))}
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div className="micro" style={{ marginBottom: 6 }}>
          auth
        </div>
        <div style={{ color: 'var(--ink-dim)' }}>
          Helm runs on your <code>claude login</code> session. It never asks for, stores, or reads an
          API key from this repo. If a session fails to authenticate, run <code>claude login</code>{' '}
          in a terminal and resume the fleet.
        </div>
      </div>
    </div>
  );
}

function AgentRow({ agent, projectName }: { agent: Agent; projectName: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    model: agent.model,
    heartbeatMinutes: agent.heartbeatMinutes,
    dailyCapUsd: agent.dailyCapUsd,
    autonomy: agent.autonomy as number,
    maxChildren: agent.maxChildren,
  });
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    setDraft({
      model: agent.model,
      heartbeatMinutes: agent.heartbeatMinutes,
      dailyCapUsd: agent.dailyCapUsd,
      autonomy: agent.autonomy,
      maxChildren: agent.maxChildren,
    });
    setSaved(true);
  }, [agent]);

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  };

  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', padding: '7px 0' }}>
      <div className="spread">
        <button
          className="btn"
          style={{ border: 'none', background: 'none', padding: 0 }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} {agent.name}
        </button>
        <span className="micro">
          {projectName} · {agent.heartbeatMinutes > 0 ? `${agent.heartbeatMinutes}m` : 'manual'} · $
          {agent.dailyCapUsd.toFixed(2)}/day · {agent.model.replace('claude-', '')} ·{' '}
          {AUTONOMY_LABELS[agent.autonomy]}
        </span>
      </div>

      {open && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="micro" style={{ display: 'grid', gap: 3 }}>
            model
            <input
              className="input"
              style={{ width: 190 }}
              value={draft.model}
              onChange={(e) => set('model', e.target.value)}
            />
          </label>
          <label className="micro" style={{ display: 'grid', gap: 3 }}>
            heartbeat (min)
            <input
              className="input"
              style={{ width: 110 }}
              type="number"
              min={0}
              value={draft.heartbeatMinutes}
              onChange={(e) => set('heartbeatMinutes', Number(e.target.value))}
            />
          </label>
          <label className="micro" style={{ display: 'grid', gap: 3 }}>
            daily cap
            <input
              className="input"
              style={{ width: 100 }}
              type="number"
              min={0}
              step={0.25}
              value={draft.dailyCapUsd}
              onChange={(e) => set('dailyCapUsd', Number(e.target.value))}
            />
          </label>
          <label className="micro" style={{ display: 'grid', gap: 3 }}>
            max children
            <input
              className="input"
              style={{ width: 100 }}
              type="number"
              min={0}
              max={5}
              value={draft.maxChildren}
              onChange={(e) => set('maxChildren', Number(e.target.value))}
            />
          </label>
          <label className="micro" style={{ display: 'grid', gap: 3 }}>
            autonomy
            <select
              className="select"
              style={{ width: 190 }}
              value={draft.autonomy}
              onChange={(e) => set('autonomy', Number(e.target.value))}
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} — {AUTONOMY_LABELS[n]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn amber"
            disabled={saved}
            onClick={async () => {
              await bridge.patchAgent(agent.id, draft);
              setSaved(true);
            }}
          >
            save
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="spread" style={{ alignItems: 'flex-start' }}>
      <div style={{ maxWidth: 420 }}>
        <div>{label}</div>
        {hint && (
          <div className="micro" style={{ marginTop: 3, textTransform: 'none', letterSpacing: 0 }}>
            {hint}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

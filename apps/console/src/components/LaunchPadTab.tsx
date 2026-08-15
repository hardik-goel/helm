'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LaunchStepMsg } from '@helm/core';
import { BRIDGE_HTTP, bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';

const STEPS: Array<{ key: LaunchStepMsg['step']; label: string; hint: string }> = [
  { key: 'workspace', label: 'workspace', hint: 'creating the folder under your launch root' },
  { key: 'git', label: 'git', hint: 'initialising the repository' },
  { key: 'register', label: 'register', hint: 'adding the project and its builder to the fleet' },
  { key: 'protocol', label: 'protocol', hint: 'writing HELM.md — the laws and the routine' },
  { key: 'session', label: 'builder', hint: 'handing the brief to the one-shot builder' },
];

const NO_STEPS: LaunchStepMsg[] = [];

export function LaunchPadTab() {
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [inferred, setInferred] = useState('');
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const steps = useHelm((s) => (launchId ? (s.launchSteps[launchId] ?? NO_STEPS) : NO_STEPS));
  const killed = useHelm((s) => s.fleet?.killed ?? false);
  const select = useHelm((s) => s.select);
  const setTab = useHelm((s) => s.setTab);

  // Name inference is deterministic and cheap, so it can follow the typing.
  useEffect(() => {
    if (!prompt.trim()) {
      setInferred('');
      return;
    }
    const t = setTimeout(() => {
      fetch(`${BRIDGE_HTTP}/launch/preview-name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
        .then((r) => r.json())
        .then((r: { name: string }) => setInferred(r.name))
        .catch(() => setInferred(''));
    }, 250);
    return () => clearTimeout(t);
  }, [prompt]);

  const stateOf = useMemo(() => {
    const map = new Map(steps.map((s) => [s.step, s]));
    return (key: LaunchStepMsg['step']) => map.get(key);
  }, [steps]);

  const launched = steps.find((s) => s.step === 'register' && s.state === 'done');

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = (await bridge.launch({
        prompt,
        name: name.trim() || undefined,
      })) as unknown as { launchId: string; projectId: string; agentId: string };
      setLaunchId(r.launchId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="micro">launch pad — paste a full build prompt, get a running project</div>

      <div className="card" style={{ padding: 12, display: 'grid', gap: 10 }}>
        <textarea
          className="textarea"
          style={{ minHeight: 220 }}
          placeholder={
            'Build a CLI that prints the NSE holiday calendar as JSON.\n\nPaste the whole brief — phases, constraints, acceptance criteria. It goes to the builder verbatim.'
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="micro" htmlFor="l-name">
              name (optional)
            </label>
            <input
              id="l-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={inferred || 'inferred from the prompt'}
            />
          </div>
          <button
            className="btn amber"
            style={{ alignSelf: 'flex-end', padding: '6px 14px' }}
            disabled={busy || killed || prompt.trim().length < 20}
            onClick={submit}
            title={killed ? 'the fleet is killed — resume it first' : 'provision and start'}
          >
            {busy ? 'launching…' : 'launch'}
          </button>
        </div>

        {inferred && !name.trim() && (
          <div className="micro">
            workspace will be <span style={{ color: 'var(--amber)' }}>{inferred}</span>
          </div>
        )}
        {err && <div className="banner red">{err}</div>}
      </div>

      {launchId && (
        <div className="card slide-up" style={{ padding: 12 }}>
          <div className="micro" style={{ marginBottom: 10 }}>
            onboarding
          </div>
          {STEPS.map((s) => {
            const msg = stateOf(s.key);
            const state = msg?.state ?? 'pending';
            const color =
              state === 'done'
                ? 'var(--mint)'
                : state === 'failed'
                  ? 'var(--red)'
                  : state === 'active'
                    ? 'var(--amber)'
                    : 'var(--ink-faint)';
            return (
              <div key={s.key} className="row" style={{ padding: '5px 0', alignItems: 'flex-start' }}>
                <span
                  className={state === 'active' ? 'dot wait' : 'dot'}
                  style={{ background: color, marginTop: 6 }}
                />
                <div style={{ flex: 1 }}>
                  <div className="spread">
                    <span style={{ color }}>{s.label}</span>
                    <span className="micro">{state}</span>
                  </div>
                  <div className="micro" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    {msg?.detail ?? s.hint}
                  </div>
                </div>
              </div>
            );
          })}

          {launched?.projectId && (
            <button
              className="btn amber"
              style={{ marginTop: 10 }}
              onClick={() => {
                select(launched.agentId ?? null, launched.projectId ?? null);
                setTab('mission');
              }}
            >
              open the new project
            </button>
          )}
        </div>
      )}
    </div>
  );
}

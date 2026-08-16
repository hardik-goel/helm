'use client';

import { useCallback, useEffect, useState } from 'react';
import { BRIDGE_HTTP, bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';
import { time } from './TopBar';

interface LoopRun {
  id: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  costUsd: number;
  waitingGateId: string | null;
}

interface Loop {
  id: string;
  name: string;
  description: string;
  trigger: { type: string; every?: string; at?: string; on?: string };
  bounds: {
    max_iterations_per_day: number;
    budget_per_run_usd: number;
    budget_per_day_usd: number;
  };
  memory: boolean;
  steps: number;
  status: 'enabled' | 'parked' | 'disabled';
  parkedReason: string | null;
  iterationsToday: number;
  spendTodayUsd: number;
  lastOutcome: string | null;
  lastRunAt: number | null;
  missingAgents: string[];
  history: LoopRun[];
}

export function LoopsTab() {
  const [loops, setLoops] = useState<Loop[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Loop | null>(null);
  const [importing, setImporting] = useState(false);
  const loopState = useHelm((s) => s.loopState);

  const load = useCallback(() => {
    fetch(`${BRIDGE_HTTP}/loops`)
      .then((r) => r.json())
      .then((r: { loops: Loop[] }) => setLoops(r.loops))
      .catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(load, [load]);
  // Any loop state change over the websocket means the cards are stale.
  useEffect(() => {
    if (Object.keys(loopState).length) load();
  }, [loopState, load]);

  if (err) return <div className="banner red">loops unavailable — {err}</div>;
  if (!loops) return <div className="empty">reading ~/.helm/loops…</div>;

  return (
    <div className="stack">
      <div className="spread">
        <span className="micro">
          loops — {loops.filter((l) => l.status === 'enabled').length} enabled of {loops.length}
        </span>
        <div className="row">
          <button className="btn" onClick={() => setImporting(true)}>
            import
          </button>
          <button
            className="btn"
            onClick={async () => {
              await fetch(`${BRIDGE_HTTP}/loops/reload`, { method: 'POST' });
              load();
            }}
          >
            reload from disk
          </button>
        </div>
      </div>

      {loops.length === 0 && (
        <div className="empty">
          No loops yet. Drop a YAML into ~/.helm/loops and hit reload.
          <br />
          Every loop needs an exit condition, an iteration cap, and a budget — or it is refused.
        </div>
      )}

      {loops.map((l) => (
        <LoopCard key={l.id} loop={l} onChanged={load} onEdit={() => setEditing(l)} />
      ))}

      {editing && <LoopEditor loop={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {importing && <LoopImporter onClose={() => setImporting(false)} onImported={load} />}
    </div>
  );
}

/**
 * Loops move between machines as a bundle: the YAML, and optionally what the
 * loop has learned. Whatever arrives is validated like a local loop and lands
 * disabled, so nothing starts running because someone sent you a file.
 */
function LoopImporter({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [withMemory, setWithMemory] = useState(false);
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErrors([]);
    try {
      // Accept either a raw YAML loop or a full exported bundle.
      let yaml = text;
      let memory: Record<string, unknown> | undefined;
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) {
        const bundle = JSON.parse(trimmed) as { yaml?: string; memory?: Record<string, unknown> };
        if (!bundle.yaml) throw new Error('that bundle has no yaml in it');
        yaml = bundle.yaml;
        if (withMemory) memory = bundle.memory;
      }

      const res = await fetch(`${BRIDGE_HTTP}/loops/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml, memory }),
      });
      const body = (await res.json()) as {
        error?: string;
        errors?: Array<{ path: string; message: string }>;
        missingAgents?: string[];
      };
      if (!res.ok) {
        setErrors(body.errors ?? [{ path: '(import)', message: body.error ?? 'import failed' }]);
        return;
      }
      onImported();
      onClose();
    } catch (e) {
      setErrors([{ path: '(input)', message: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(760px, 94vw)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="import a loop"
      >
        <div className="modal-head">
          <span className="micro">import a loop</span>
        </div>
        <div className="modal-body">
          <textarea
            className="textarea"
            style={{ minHeight: '36vh', fontSize: 11 }}
            placeholder="paste loop YAML, or a bundle exported from another machine"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoFocus
          />
          <label className="row micro" style={{ textTransform: 'none', letterSpacing: 0 }}>
            <input
              type="checkbox"
              checked={withMemory}
              onChange={(e) => setWithMemory(e.target.checked)}
            />
            bring its memory too — only if you trust what it learned on that machine
          </label>
          <div className="micro" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Imported loops arrive disabled and are validated exactly like local ones.
          </div>
          {errors.length > 0 && (
            <div className="banner red" style={{ borderRadius: 6, display: 'block' }}>
              {errors.map((e, i) => (
                <div key={i}>
                  <strong>{e.path}</strong> — {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            cancel
          </button>
          <button className="btn amber" disabled={busy || !text.trim()} onClick={submit}>
            import
          </button>
        </div>
      </div>
    </div>
  );
}

function LoopCard({
  loop,
  onChanged,
  onEdit,
}: {
  loop: Loop;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const iterPct = Math.min(
    100,
    (loop.iterationsToday / loop.bounds.max_iterations_per_day) * 100,
  );
  const spendPct = Math.min(100, (loop.spendTodayUsd / loop.bounds.budget_per_day_usd) * 100);

  async function setStatus(status: 'enabled' | 'disabled') {
    setBusy(true);
    setErr(null);
    try {
      await bridge.loopToggle(loop.id, status);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusChip =
    loop.status === 'enabled' ? 'chip mint' : loop.status === 'parked' ? 'chip red' : 'chip';

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="spread">
        <span className="row">
          <span className={statusChip}>{loop.status}</span>
          <strong>{loop.name}</strong>
          <span className="chip">{triggerLabel(loop.trigger)}</span>
          {loop.memory && <span className="chip amber">memory</span>}
          <span className="chip">{loop.steps} steps</span>
        </span>
        <span className="micro">
          {loop.lastRunAt ? `last run ${time(loop.lastRunAt)}` : 'never run'}
          {loop.lastOutcome ? ` · ${loop.lastOutcome}` : ''}
        </span>
      </div>

      {loop.description && (
        <div style={{ color: 'var(--ink-dim)', marginTop: 6 }}>{loop.description}</div>
      )}

      {loop.status === 'parked' && loop.parkedReason && (
        <div className="banner red" style={{ marginTop: 8, borderRadius: 6 }}>
          parked — {loop.parkedReason}
        </div>
      )}
      {loop.missingAgents.length > 0 && (
        <div className="banner amber" style={{ marginTop: 8, borderRadius: 6 }}>
          points at agents that do not exist: {loop.missingAgents.join(', ')}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        <Meter
          label={`iterations today ${loop.iterationsToday}/${loop.bounds.max_iterations_per_day}`}
          pct={iterPct}
        />
        <Meter
          label={`spend today $${loop.spendTodayUsd.toFixed(2)}/$${loop.bounds.budget_per_day_usd.toFixed(2)} · $${loop.bounds.budget_per_run_usd.toFixed(2)} per run`}
          pct={spendPct}
        />
      </div>

      <Sparkline runs={loop.history} />

      <div className="row" style={{ marginTop: 10 }}>
        <button
          className={loop.status === 'enabled' ? 'btn' : 'btn mint'}
          disabled={busy}
          onClick={() => setStatus(loop.status === 'enabled' ? 'disabled' : 'enabled')}
        >
          {loop.status === 'enabled' ? 'disable' : loop.status === 'parked' ? 'unpark' : 'enable'}
        </button>
        <button
          className="btn amber"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await bridge.loopRun(loop.id);
              onChanged();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          run now
        </button>
        <button className="btn" onClick={onEdit}>
          edit yaml
        </button>
        <button
          className="btn"
          disabled={busy}
          title="copy a portable bundle of this loop to the clipboard"
          onClick={async () => {
            setErr(null);
            try {
              const r = await fetch(`${BRIDGE_HTTP}/loops/${loop.id}/export?memory=1`);
              await navigator.clipboard.writeText(JSON.stringify(await r.json(), null, 2));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          {copied ? 'copied' : 'export'}
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

function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="micro" style={{ marginBottom: 3 }}>
        {label}
      </div>
      <div className="bar">
        <span style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : undefined }} />
      </div>
    </div>
  );
}

function Sparkline({ runs }: { runs: LoopRun[] }) {
  if (runs.length === 0) return null;
  const series = [...runs].reverse().slice(-20);
  const max = Math.max(...series.map((r) => r.costUsd), 0.001);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 26, marginTop: 10 }}>
      {series.map((r) => {
        const h = Math.max(2, Math.round((r.costUsd / max) * 24));
        const color =
          r.outcome === 'error'
            ? 'var(--red)'
            : r.waitingGateId
              ? 'var(--amber)'
              : r.outcome === 'short-circuited'
                ? 'var(--violet)'
                : 'var(--mint)';
        return (
          <span
            key={r.id}
            title={`${new Date(r.startedAt).toLocaleString()} · ${r.outcome ?? 'running'} · $${r.costUsd.toFixed(3)}`}
            style={{ width: 6, height: h, background: color, opacity: 0.85, borderRadius: 1 }}
          />
        );
      })}
    </div>
  );
}

function LoopEditor({
  loop,
  onClose,
  onSaved,
}: {
  loop: Loop;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [yaml, setYaml] = useState('');
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [ok, setOk] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    bridge
      .loopSource(loop.id)
      .then((r) => setYaml(r.yaml))
      .catch(() => setYaml('# no source file on disk for this loop\n'));
  }, [loop.id]);

  // Validate as you type: Law 8 violations should be visible before saving.
  useEffect(() => {
    if (!yaml.trim()) return;
    const t = setTimeout(async () => {
      try {
        const r = await bridge.loopValidate(yaml);
        setOk(r.ok);
        setErrors(r.errors ?? []);
      } catch {
        /* the bridge is offline; the save button will say so */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [yaml]);

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(860px, 94vw)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`edit ${loop.name}`}
      >
        <div className="modal-head spread">
          <span className="micro">{loop.name}.yaml</span>
          <span className={ok ? 'chip mint' : 'chip red'}>{ok ? 'valid' : 'invalid'}</span>
        </div>
        <div className="modal-body">
          <textarea
            className="textarea"
            style={{ minHeight: '46vh', fontSize: 11 }}
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
          />
          {errors.length > 0 && (
            <div className="banner red" style={{ borderRadius: 6, display: 'block' }}>
              {errors.map((e, i) => (
                <div key={i}>
                  <strong>{e.path}</strong> — {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            cancel
          </button>
          <button
            className="btn amber"
            disabled={!ok || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await bridge.loopSave(loop.id, yaml);
                onSaved();
                onClose();
              } catch (e) {
                setErrors([{ path: '(save)', message: (e as Error).message }]);
              } finally {
                setSaving(false);
              }
            }}
          >
            save
          </button>
        </div>
      </div>
    </div>
  );
}

function triggerLabel(t: Loop['trigger']): string {
  if (t.type === 'cron') return t.every ? `every ${t.every}` : `daily ${t.at}`;
  if (t.type === 'event') return `on ${t.on}`;
  if (t.type === 'gate') return `on gate ${t.on}`;
  return 'manual';
}

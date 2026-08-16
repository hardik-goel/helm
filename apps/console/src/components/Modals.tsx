'use client';

import { useState } from 'react';
import { AUTONOMY_LABELS, DEFAULT_ALLOWLIST } from '@helm/core';
import { bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';

export function AddProjectModal() {
  const open = useHelm((s) => s.addProjectOpen);
  const close = useHelm((s) => s.setAddProject);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await bridge.createProject({ name: name.trim(), path: path.trim() });
      setName('');
      setPath('');
      close(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={() => close(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="add project">
        <div className="modal-head">
          <span className="micro">register a project</span>
        </div>
        <div className="modal-body">
          <label className="micro" htmlFor="p-name">
            name
          </label>
          <input
            id="p-name"
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="trinetra"
          />
          <label className="micro" htmlFor="p-path">
            existing path
          </label>
          <input
            id="p-path"
            className="input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="~/dev/trinetra"
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="micro">
            HELM.md is written into the project root. Nothing else is touched.
          </div>
          {err && <div className="banner red">{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => close(false)}>
            cancel
          </button>
          <button className="btn amber" disabled={busy || !name.trim() || !path.trim()} onClick={submit}>
            register
          </button>
        </div>
      </div>
    </div>
  );
}

export function RecruitModal() {
  const open = useHelm((s) => s.recruitOpen);
  const close = useHelm((s) => s.setRecruit);
  const fleet = useHelm((s) => s.fleet);
  const selectedProjectId = useHelm((s) => s.selectedProjectId);

  const [projectId, setProjectId] = useState(selectedProjectId ?? '');
  const [name, setName] = useState('');
  const [role, setRole] = useState('watcher');
  const [mission, setMission] = useState('');
  const [heartbeat, setHeartbeat] = useState(0);
  const [autonomy, setAutonomy] = useState(1);
  const [cap, setCap] = useState(2);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;
  const effectiveProject = projectId || selectedProjectId || fleet?.projects[0]?.id || '';

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await bridge.createAgent({
        projectId: effectiveProject,
        name: name.trim(),
        role: role.trim() || 'operator',
        mission: mission.trim(),
        heartbeatMinutes: heartbeat,
        autonomy,
        dailyCapUsd: cap,
        allowlist: [...DEFAULT_ALLOWLIST],
      });
      setName('');
      setMission('');
      close(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={() => close(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="recruit agent">
        <div className="modal-head">
          <span className="micro">recruit an agent</span>
        </div>
        <div className="modal-body">
          <label className="micro" htmlFor="a-project">
            project
          </label>
          <select
            id="a-project"
            className="select"
            value={effectiveProject}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {(fleet?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="row">
            <div style={{ flex: 1 }}>
              <label className="micro" htmlFor="a-name">
                name
              </label>
              <input
                id="a-name"
                className="input"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="argus"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="micro" htmlFor="a-role">
                role
              </label>
              <input
                id="a-role"
                className="input"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
            </div>
          </div>

          <label className="micro" htmlFor="a-mission">
            mission
          </label>
          <textarea
            id="a-mission"
            className="textarea"
            value={mission}
            onChange={(e) => setMission(e.target.value)}
            placeholder="Watch the build and the error budget. Report anything that regressed since the last pulse."
          />

          <div className="row">
            <div style={{ flex: 1 }}>
              <label className="micro" htmlFor="a-hb">
                heartbeat (min, 0 = manual)
              </label>
              <input
                id="a-hb"
                className="input"
                type="number"
                min={0}
                value={heartbeat}
                onChange={(e) => setHeartbeat(Number(e.target.value))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="micro" htmlFor="a-cap">
                daily cap (usd)
              </label>
              <input
                id="a-cap"
                className="input"
                type="number"
                min={0}
                step={0.25}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="micro" htmlFor="a-auto">
                autonomy
              </label>
              <select
                id="a-auto"
                className="select"
                value={autonomy}
                onChange={(e) => setAutonomy(Number(e.target.value))}
              >
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n} — {AUTONOMY_LABELS[n]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="micro">
            Starts with Read, Grep, Glob and read-only Bash. Everything else goes to the gate.
          </div>
          {err && <div className="banner red">{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => close(false)}>
            cancel
          </button>
          <button
            className="btn amber"
            disabled={busy || !name.trim() || !effectiveProject}
            onClick={submit}
          >
            recruit
          </button>
        </div>
      </div>
    </div>
  );
}

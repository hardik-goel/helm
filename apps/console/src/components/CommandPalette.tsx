'use client';

import { useEffect, useMemo, useState } from 'react';
import { bridge } from '@/lib/bridge';
import { useHelm, type TabKey } from '@/lib/store';
import { Avatar } from './Avatar';

interface Command {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const open = useHelm((s) => s.paletteOpen);
  const setPalette = useHelm((s) => s.setPalette);
  const setTab = useHelm((s) => s.setTab);
  const select = useHelm((s) => s.select);
  const setRecruit = useHelm((s) => s.setRecruit);
  const setAddProject = useHelm((s) => s.setAddProject);
  const fleet = useHelm((s) => s.fleet);

  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    for (const p of fleet?.projects ?? []) {
      list.push({
        id: `p-${p.id}`,
        label: p.name,
        hint: 'project',
        run: () => {
          const first = fleet?.agents.find((a) => a.projectId === p.id);
          select(first?.id ?? null, p.id);
          setTab('mission');
        },
      });
    }
    for (const a of fleet?.agents ?? []) {
      list.push({
        id: `a-${a.id}`,
        label: a.name,
        hint: `agent · ${fleet?.projects.find((p) => p.id === a.projectId)?.name ?? ''}`,
        run: () => {
          select(a.id, a.projectId);
          setTab('mission');
        },
      });
    }

    const tabs: Array<[TabKey, string]> = [
      ['mission', 'Mission'],
      ['launch', 'Launch Pad'],
      ['gate', 'Gate'],
      ['loops', 'Loops'],
      ['standup', 'Standup'],
      ['settings', 'Settings'],
    ];
    for (const [key, label] of tabs) {
      list.push({ id: `t-${key}`, label: `Go to ${label}`, hint: 'tab', run: () => setTab(key) });
    }

    list.push({
      id: 'recruit',
      label: 'Recruit an agent',
      hint: 'action',
      run: () => setRecruit(true),
    });
    list.push({
      id: 'add-project',
      label: 'Register a project',
      hint: 'action',
      run: () => setAddProject(true),
    });
    list.push({
      id: 'kill',
      label: fleet?.killed ? 'Resume the fleet' : 'KILL SWITCH — stop every agent now',
      hint: 'fleet',
      danger: !fleet?.killed,
      run: async () => {
        if (fleet?.killed) await bridge.resumeFleet();
        else await bridge.kill('palette');
      },
    });

    return list;
  }, [fleet, select, setTab, setRecruit, setAddProject]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 40);
    return commands
      .filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [q, commands]);

  if (!open) return null;

  const activate = (c: Command | undefined) => {
    if (!c) return;
    setPalette(false);
    void c.run();
  };

  return (
    <div className="scrim" onClick={() => setPalette(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="command palette">
        <div className="modal-head">
          <input
            className="input"
            autoFocus
            placeholder="jump to a project, agent, or tab…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                activate(filtered[cursor]);
              }
            }}
          />
        </div>
        <div style={{ maxHeight: '48vh', overflowY: 'auto', padding: '6px 0' }}>
          {filtered.length === 0 && <div className="empty">Nothing matches.</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => activate(c)}
              style={c.danger ? { color: 'var(--red)' } : undefined}
            >
              {c.hint === 'agent' || c.hint?.startsWith('agent') ? (
                <Avatar name={c.label} size={14} />
              ) : (
                <span className="dot" />
              )}
              <span style={{ flex: 1 }}>{c.label}</span>
              <span className="micro">{c.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

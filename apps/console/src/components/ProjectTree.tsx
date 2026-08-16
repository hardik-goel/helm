'use client';

import { useMemo, useState } from 'react';
import type { Agent, Project } from '@helm/core';
import { bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';
import { Avatar } from './Avatar';
import { StatusDot } from './StatusDot';

export function ProjectTree() {
  const fleet = useHelm((s) => s.fleet);
  const agentState = useHelm((s) => s.agentState);
  const selectedAgentId = useHelm((s) => s.selectedAgentId);
  const select = useHelm((s) => s.select);
  const setAddProject = useHelm((s) => s.setAddProject);
  const setRecruit = useHelm((s) => s.setRecruit);

  const [filter, setFilter] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);

  const projects = useMemo(() => {
    const list = fleet?.projects ?? [];
    if (!order) return list;
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...list].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }, [fleet?.projects, order]);

  const agentsFor = (projectId: string): Agent[] =>
    (fleet?.agents ?? []).filter((a) => a.projectId === projectId);

  const matches = (p: Project) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.tag ?? '').toLowerCase().includes(q) ||
      agentsFor(p.id).some((a) => a.name.toLowerCase().includes(q))
    );
  };

  async function commitOrder(nextIds: string[]) {
    setOrder(nextIds);
    try {
      await bridge.reorderProjects(nextIds);
    } catch {
      setOrder(null);
    }
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = projects.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void commitOrder(ids);
    setDragId(null);
    setOverId(null);
  }

  const visible = projects.filter(matches);

  return (
    <div className="pane" aria-label="project tree">
      <div className="pane-head">
        <span className="micro">projects</span>
        <button className="btn" onClick={() => setAddProject(true)} title="Register a project">
          + project
        </button>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <input
          className="input"
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="filter projects"
        />
      </div>

      {visible.length === 0 && (
        <div className="empty">
          {projects.length === 0 ? (
            <>
              No projects yet.
              <br />
              Register one, or paste a build prompt into the Launch Pad.
            </>
          ) : (
            <>Nothing matches “{filter}”.</>
          )}
        </div>
      )}

      {visible.map((p) => {
        const agents = agentsFor(p.id);
        const live = agents.filter(
          (a) => (agentState[a.id]?.status ?? a.status) === 'running',
        ).length;
        return (
          <div key={p.id}>
            <div
              className={`tree-project${overId === p.id ? ' drag-over' : ''}`}
              draggable
              onDragStart={() => setDragId(p.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(p.id);
              }}
              onDragLeave={() => setOverId((v) => (v === p.id ? null : v))}
              onDrop={() => onDrop(p.id)}
              onClick={() => select(agents[0]?.id ?? null, p.id)}
              title={`${p.path}\nDrag to reorder — tree order is wake priority.`}
            >
              <span className={live > 0 ? 'dot live' : 'dot'} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.name}
              </span>
              {p.tag === 'new' && <span className="chip amber">new</span>}
              <span className="micro">{agents.length}</span>
            </div>

            {agents.map((a) => {
              const status = agentState[a.id]?.status ?? a.status;
              return (
                <div
                  key={a.id}
                  className={`tree-agent${selectedAgentId === a.id ? ' selected' : ''}`}
                  onClick={() => select(a.id, p.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && select(a.id, p.id)}
                >
                  <StatusDot status={status} />
                  <Avatar name={a.name} size={14} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.name}
                  </span>
                  {a.heartbeatMinutes > 0 && <span className="micro">{a.heartbeatMinutes}m</span>}
                </div>
              );
            })}

            {agents.length === 0 && (
              <div className="tree-agent" style={{ color: 'var(--ink-faint)' }}>
                <button
                  className="btn"
                  style={{ padding: '2px 7px' }}
                  onClick={() => {
                    select(null, p.id);
                    setRecruit(true);
                  }}
                >
                  + recruit
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

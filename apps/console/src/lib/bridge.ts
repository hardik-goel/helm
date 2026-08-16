import type { FeedEvent, GateItem, HelmConfig, Project, Session } from '@helm/core';

export const BRIDGE_PORT = process.env.NEXT_PUBLIC_BRIDGE_PORT ?? '8787';
export const BRIDGE_HTTP = `http://127.0.0.1:${BRIDGE_PORT}`;
export const BRIDGE_WS = `ws://127.0.0.1:${BRIDGE_PORT}/ws`;

export class BridgeOfflineError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_HTTP}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new BridgeOfflineError((err as Error).message);
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const bridge = {
  health: () => call<{ ok: boolean; version: string; killed: boolean; authOk: boolean }>('/health'),

  createProject: (input: { name: string; path: string; url?: string | null; tag?: string | null }) =>
    post<{ project: Project }>('/projects', input),
  reorderProjects: (order: string[]) => post<{ projects: Project[] }>('/projects/reorder', { order }),
  archiveProject: (id: string) => call<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  createAgent: (input: Record<string, unknown>) => post<{ agent: unknown }>('/agents', input),
  patchAgent: (id: string, input: Record<string, unknown>) =>
    patch<{ agent: unknown }>(`/agents/${id}`, input),
  decommissionAgent: (id: string) => call<{ ok: boolean }>(`/agents/${id}`, { method: 'DELETE' }),
  runAgent: (id: string, input?: { instruction?: string; prompt?: string; maxTurns?: number }) =>
    post<{ ok: boolean }>(`/agents/${id}/run`, input ?? {}),
  pauseAgent: (id: string) => post<{ ok: boolean }>(`/agents/${id}/pause`),
  resumeAgent: (id: string) => post<{ ok: boolean }>(`/agents/${id}/resume`),

  sessions: (agentId?: string) =>
    call<{ sessions: Session[] }>(`/sessions${agentId ? `?agentId=${agentId}` : ''}`),
  transcript: (sessionId: string) =>
    call<{ lines: Array<{ role: string; text: string; at?: number }> }>(
      `/sessions/${sessionId}/transcript`,
    ),

  gate: (status?: 'pending') => call<{ items: GateItem[] }>(`/gate${status ? `?status=${status}` : ''}`),
  approve: (id: string) => post<{ item: GateItem; execution?: unknown }>(`/gate/${id}/approve`),
  deny: (id: string) => post<{ item: GateItem }>(`/gate/${id}/deny`),
  approveAll: (agentId?: string) => post<{ approved: number }>('/gate/approve-all', { agentId }),

  events: (limit = 50) => call<{ events: FeedEvent[] }>(`/fleet/events?limit=${limit}`),
  config: () => call<{ config: HelmConfig }>('/fleet/config'),
  patchGovernor: (input: Record<string, unknown>) => patch<unknown>('/fleet/config/governor', input),
  kill: (reason = 'console') => post<{ ok: boolean; elapsedMs: number }>('/fleet/kill', { reason }),
  resumeFleet: () => post<{ ok: boolean }>('/fleet/resume'),

  standup: (hours = 24) => call<{ digest: unknown }>(`/standup?hours=${hours}`),

  launch: (input: { prompt: string; name?: string }) =>
    post<{ launchId: string }>('/launch', input),

  loops: () => call<{ loops: unknown[] }>('/loops'),
  loopRun: (id: string) => post<{ ok: boolean }>(`/loops/${id}/run`),
  loopToggle: (id: string, status: 'enabled' | 'disabled' | 'parked') =>
    post<{ ok: boolean }>(`/loops/${id}/status`, { status }),
  loopSource: (id: string) => call<{ yaml: string }>(`/loops/${id}/source`),
  loopSave: (id: string, yaml: string) => post<{ ok: boolean }>(`/loops/${id}/source`, { yaml }),
  loopValidate: (yaml: string) =>
    post<{ ok: boolean; errors?: Array<{ path: string; message: string }> }>('/loops/validate', {
      yaml,
    }),
};

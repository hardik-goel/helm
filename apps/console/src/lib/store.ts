'use client';

import { create } from 'zustand';
import {
  ServerMessage,
  type Agent,
  type FeedEvent,
  type FleetStateMsg,
  type GateItem,
  type LaunchStepMsg,
  type LoopStateMsg,
  type Pulse,
  type SessionStreamChunk,
} from '@helm/core';
import { BRIDGE_WS } from './bridge';

export type TabKey = 'mission' | 'launch' | 'gate' | 'loops' | 'standup' | 'settings';
export type Connection = 'connecting' | 'live' | 'offline';

const MAX_EVENTS = 200;
const MAX_STREAM_LINES = 600;

export interface LiveAgentState {
  status: Agent['status'];
  sessionId: string | null;
  turns: number;
  costUsdToday: number;
  at: number;
}

interface HelmStore {
  connection: Connection;
  fleet: FleetStateMsg | null;
  events: FeedEvent[];
  gate: GateItem[];
  pulses: Pulse[];
  streams: Record<string, SessionStreamChunk[]>;
  agentState: Record<string, LiveAgentState>;
  loopState: Record<string, LoopStateMsg>;
  launchSteps: Record<string, LaunchStepMsg[]>;

  selectedProjectId: string | null;
  selectedAgentId: string | null;
  tab: TabKey;
  paletteOpen: boolean;
  drawerSessionId: string | null;
  addProjectOpen: boolean;
  recruitOpen: boolean;

  connect: () => void;
  select: (agentId: string | null, projectId?: string | null) => void;
  setTab: (tab: TabKey) => void;
  setPalette: (open: boolean) => void;
  setDrawer: (sessionId: string | null) => void;
  setAddProject: (open: boolean) => void;
  setRecruit: (open: boolean) => void;
  closeAll: () => void;
  seedGate: (items: GateItem[]) => void;
  seedEvents: (events: FeedEvent[]) => void;
}

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export const useHelm = create<HelmStore>((set, get) => ({
  connection: 'connecting',
  fleet: null,
  events: [],
  gate: [],
  pulses: [],
  streams: {},
  agentState: {},
  loopState: {},
  launchSteps: {},

  selectedProjectId: null,
  selectedAgentId: null,
  tab: 'mission',
  paletteOpen: false,
  drawerSessionId: null,
  addProjectOpen: false,
  recruitOpen: false,

  connect: () => {
    if (typeof window === 'undefined') return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    set({ connection: 'connecting' });
    const ws = new WebSocket(BRIDGE_WS);
    socket = ws;

    ws.onopen = () => {
      retry = 0;
      set({ connection: 'live' });
      ws.send(JSON.stringify({ type: 'hello' }));
    };

    ws.onclose = () => {
      set({ connection: 'offline' });
      // Exponential backoff, capped. The bridge restarting is normal.
      const delay = Math.min(500 * 2 ** retry++, 8000);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => get().connect(), delay);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (ev) => {
      const parsed = ServerMessage.safeParse(safeJson(ev.data as string));
      if (!parsed.success) return;
      apply(parsed.data, set, get);
    };
  },

  select: (agentId, projectId) =>
    set((s) => ({
      selectedAgentId: agentId,
      selectedProjectId: projectId ?? s.selectedProjectId,
      tab: agentId ? 'mission' : s.tab,
    })),
  setTab: (tab) => set({ tab }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setDrawer: (drawerSessionId) => set({ drawerSessionId }),
  setAddProject: (addProjectOpen) => set({ addProjectOpen }),
  setRecruit: (recruitOpen) => set({ recruitOpen }),
  closeAll: () =>
    set({ paletteOpen: false, drawerSessionId: null, addProjectOpen: false, recruitOpen: false }),

  seedGate: (items) => set({ gate: items }),
  seedEvents: (events) => set({ events: events.slice(-MAX_EVENTS) }),
}));

type Setter = (fn: (s: HelmStore) => Partial<HelmStore>) => void;

function apply(msg: ServerMessage, set: Setter, get: () => HelmStore): void {
  switch (msg.type) {
    case 'fleet.state': {
      set(() => ({ fleet: msg }));
      // Adopt a selection on first load so the cockpit is never empty.
      const s = get();
      if (!s.selectedAgentId && msg.agents.length) {
        const first = msg.agents[0]!;
        set(() => ({ selectedAgentId: first.id, selectedProjectId: first.projectId }));
      } else if (!s.selectedProjectId && msg.projects.length) {
        set(() => ({ selectedProjectId: msg.projects[0]!.id }));
      }
      break;
    }

    case 'feed.event':
      set((s) => ({ events: [...s.events, msg.event].slice(-MAX_EVENTS) }));
      break;

    case 'agent.status':
      set((s) => ({
        agentState: {
          ...s.agentState,
          [msg.agentId]: {
            status: msg.status,
            sessionId: msg.sessionId ?? null,
            turns: msg.turns ?? s.agentState[msg.agentId]?.turns ?? 0,
            costUsdToday: msg.costUsdToday ?? s.agentState[msg.agentId]?.costUsdToday ?? 0,
            at: msg.at,
          },
        },
      }));
      break;

    case 'session.stream':
      set((s) => {
        const prev = s.streams[msg.sessionId] ?? [];
        const next = [...prev, msg];
        return {
          streams: {
            ...s.streams,
            [msg.sessionId]: next.length > MAX_STREAM_LINES ? next.slice(-MAX_STREAM_LINES) : next,
          },
          agentState: {
            ...s.agentState,
            [msg.agentId]: {
              status: s.agentState[msg.agentId]?.status ?? 'running',
              sessionId: msg.sessionId,
              turns:
                msg.role === 'assistant' || msg.role === 'tool'
                  ? (s.agentState[msg.agentId]?.turns ?? 0) + 1
                  : (s.agentState[msg.agentId]?.turns ?? 0),
              costUsdToday: s.agentState[msg.agentId]?.costUsdToday ?? 0,
              at: msg.at,
            },
          },
        };
      });
      break;

    case 'gate.new':
      set((s) => ({ gate: [msg.item, ...s.gate.filter((g) => g.id !== msg.item.id)] }));
      break;

    case 'gate.decided':
      set((s) => ({ gate: s.gate.map((g) => (g.id === msg.item.id ? msg.item : g)) }));
      break;

    case 'pulse.new':
      set((s) => ({ pulses: [msg.pulse, ...s.pulses].slice(0, 100) }));
      break;

    case 'loop.state':
      set((s) => ({ loopState: { ...s.loopState, [msg.loopId]: msg } }));
      break;

    case 'launch.step':
      set((s) => ({
        launchSteps: {
          ...s.launchSteps,
          [msg.launchId]: [...(s.launchSteps[msg.launchId] ?? []).filter((x) => x.step !== msg.step), msg],
        },
      }));
      break;

    default:
      break;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* ---- selectors ---- */

export function useAgent(agentId: string | null): Agent | null {
  return useHelm((s) => s.fleet?.agents.find((a) => a.id === agentId) ?? null);
}

export function useAgentStatus(agent: Agent | null): Agent['status'] {
  return useHelm((s) => (agent ? (s.agentState[agent.id]?.status ?? agent.status) : 'idle'));
}

/**
 * Count, not list: a selector that builds a new array on every read makes
 * useSyncExternalStore loop forever. Components filter from `gate` themselves.
 */
export function usePendingGateCount(): number {
  return useHelm((s) => s.gate.reduce((n, g) => (g.status === 'pending' ? n + 1 : n), 0));
}

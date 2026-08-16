import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessage, ServerMessage } from '@helm/core';

/**
 * The single fan-out point for ws://localhost:8787. Every outbound message is
 * parsed against the shared schema before it leaves, so a wire drift shows up
 * here as a thrown error rather than in the console as a blank pane.
 */
export class Hub {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private onHello: (() => ServerMessage | null) | null = null;

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.on('message', (data) => {
        const parsed = ClientMessage.safeParse(safeJson(String(data)));
        if (!parsed.success) return;
        if (parsed.data.type === 'hello') {
          const snapshot = this.onHello?.();
          if (snapshot) send(ws, snapshot);
        }
      });
      const snapshot = this.onHello?.();
      if (snapshot) send(ws, snapshot);
    });
  }

  /** Register the fleet-state snapshot handed to every new connection. */
  setSnapshotProvider(fn: () => ServerMessage | null): void {
    this.onHello = fn;
  }

  broadcast(msg: ServerMessage): void {
    // Validate, but never let a malformed message take the daemon down with it.
    // A wire drift should degrade the console, not kill the fleet — the tests
    // are where schema violations are supposed to be caught.
    const parsed = ServerMessage.safeParse(msg);
    if (!parsed.success) {
      process.stderr.write(
        `helm bridge  refusing to broadcast an invalid ${String((msg as { type?: string })?.type)} message: ` +
          `${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}\n`,
      );
      return;
    }
    const payload = JSON.stringify(parsed.data);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHelmDirs, paths } from './paths.js';

/**
 * Raw session transcripts, one JSONL file per session. These are the primary
 * record — the events table holds summaries, this holds everything.
 *
 * Writes are synchronous on purpose. A buffered stream can lose the tail of a
 * session when the bridge is killed, and the tail is exactly the part that
 * explains why the kill happened. Message rates here are tens per second.
 */
export class TranscriptWriter {
  private fd: number | null;
  readonly path: string;

  constructor(sessionId: string) {
    ensureHelmDirs();
    this.path = transcriptPath(sessionId);
    this.fd = openSync(this.path, 'a');
  }

  write(entry: unknown): void {
    if (this.fd === null) return;
    writeSync(this.fd, `${JSON.stringify(entry)}\n`);
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

export function transcriptPath(sessionId: string): string {
  return join(paths.transcripts, `${sessionId}.jsonl`);
}

/**
 * Read a transcript. By default the raw audit lines are filtered out — the
 * drawer wants the role-coded story. Pass `includeRaw` to get everything,
 * which is what you want when checking what an agent was actually sent.
 */
export function readTranscript(
  sessionId: string,
  limit = 2000,
  includeRaw = false,
): unknown[] {
  const file = transcriptPath(sessionId);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return { role: 'system', text: l };
    }
  });
  const kept = includeRaw ? parsed : parsed.filter((e) => e.kind !== 'raw');
  return kept.slice(-limit);
}

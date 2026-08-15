'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '@/lib/bridge';
import { useHelm } from '@/lib/store';
import { time } from './TopBar';

interface Line {
  role: string;
  text: string;
  at?: number;
}

/**
 * Selectors must return a stable reference when there is nothing to return:
 * a fresh `[]` each read makes useSyncExternalStore re-render forever.
 */
const NO_CHUNKS: never[] = [];

/**
 * Renders the saved .jsonl for a session, then live-tails the websocket while
 * that session is still running.
 */
export function TranscriptDrawer() {
  const sessionId = useHelm((s) => s.drawerSessionId);
  const setDrawer = useHelm((s) => s.setDrawer);
  const liveChunks = useHelm((s) => (sessionId ? (s.streams[sessionId] ?? NO_CHUNKS) : NO_CHUNKS));

  const [saved, setSaved] = useState<Line[]>([]);
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    bridge
      .transcript(sessionId)
      .then((r) => setSaved(r.lines as Line[]))
      .catch(() => setSaved([]))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const lines = useMemo<Line[]>(() => {
    if (liveChunks.length > saved.length) {
      return liveChunks.map((c) => ({ role: c.role, text: c.text, at: c.at }));
    }
    return saved;
  }, [saved, liveChunks]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (!sessionId) return null;

  return (
    <div className="scrim" onClick={() => setDrawer(null)}>
      <div
        className="modal"
        style={{ width: 'min(880px, 94vw)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="transcript"
      >
        <div className="modal-head spread">
          <span className="micro">transcript · {sessionId}</span>
          <button className="btn" onClick={() => setDrawer(null)}>
            close (esc)
          </button>
        </div>
        <div ref={bodyRef} style={{ maxHeight: '64vh', overflowY: 'auto', padding: 14 }}>
          {loading && <div className="empty">reading transcript…</div>}
          {!loading && lines.length === 0 && (
            <div className="empty">This session has not written anything yet.</div>
          )}
          {lines.map((l, i) => (
            <div key={i} className={`stream-line role-${l.role}`}>
              <span className="stream-role">{l.role}</span>
              <span className="stream-text">{l.text}</span>
              {l.at ? <span className="feed-time">{time(l.at)}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

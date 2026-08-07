import { useEffect, useRef, useState } from 'react';
import type { LogLine, ServerRecord } from '@msc/shared-types';
import type { ServerRuntime } from '../hooks/useServerRuntime';

interface ConsolePageProps {
  server: ServerRecord;
  runtime: ServerRuntime;
}

export default function ConsolePage({
  server,
  runtime,
}: ConsolePageProps): React.JSX.Element {
  const { logs, sendCommand } = runtime;
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [logs, autoScroll]);

  const visible = logs.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (filter.trim() && !l.text.toLowerCase().includes(filter.trim().toLowerCase())) {
      return false;
    }
    return true;
  });

  const submit = (): void => {
    const trimmed = command.trim();
    if (!trimmed) return;
    void sendCommand(trimmed);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    setCommand('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(next);
      if (next >= 0) setCommand(history[history.length - 1 - next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next >= 0 ? history[history.length - 1 - next] : '');
    }
  };

  return (
    <section className="page page-full">
      <header className="page-header">
        <h1>Console</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      <div className="console-toolbar">
        <input
          className="input input-sm"
          placeholder="Filter logs…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="input input-sm"
          value={levelFilter}
          onChange={(e) =>
            setLevelFilter(e.target.value as 'all' | 'info' | 'warn' | 'error')
          }
        >
          <option value="all">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warnings</option>
          <option value="error">Errors</option>
        </select>
        <label className="dash-row muted checkbox-label">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            const text = visible.map((l) => `[${l.timestamp}] ${l.text}`).join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${server.name.replace(/\s+/g, '-').toLowerCase()}-console.log`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download
        </button>
      </div>

      <div className="console">
        {visible.length === 0 && <p className="muted console-empty">No output yet.</p>}
        {visible.map((log: LogLine, i) => (
          <div key={`${log.timestamp}-${i}`} className={`console-line ${logClass(log)}`}>
            <span className="console-time">{formatTime(log.timestamp)}</span>
            <span className="console-text">{log.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="console-input-row">
        <span className="console-prompt">&gt;</span>
        <input
          className="input console-input"
          placeholder="Type a server command…"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!server}
        />
      </div>
    </section>
  );
}

function logClass(log: LogLine): string {
  switch (log.level) {
    case 'error':
      return 'console-error';
    case 'warn':
      return 'console-warn';
    default:
      return '';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

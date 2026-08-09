import type { ServerRecord } from '@msc/shared-types';
import type { ServerRuntime } from '../hooks/useServerRuntime';

interface DashboardStatsProps {
  server: ServerRecord;
  runtime: ServerRuntime;
}

export default function DashboardStats({
  server,
  runtime,
}: DashboardStatsProps): React.JSX.Element {
  const { state, stats, address, uptimeSeconds, pid } = runtime;

  return (
    <div className="stats-grid">
      <div className="stat-tile">
        <span className="stat-label">Status</span>
        <span className={`stat-value ${state === 'online' ? 'status-ok-text' : ''}`}>
          {state}
        </span>
      </div>
      <div className="stat-tile">
        <span className="stat-label">Players</span>
        <span className="stat-value">
          {stats.playerCount === null ? '—' : stats.playerCount}
        </span>
      </div>
      <div className="stat-tile">
        <span className="stat-label">CPU{stats.isStale ? ' (stale)' : ''}</span>
        <span className="stat-value">
          {stats.cpuPercent === null ? '—' : `${stats.cpuPercent.toFixed(1)}%`}
        </span>
      </div>
      <div className="stat-tile">
        <span className="stat-label">Memory{stats.isStale ? ' (stale)' : ''}</span>
        <span className="stat-value">
          {stats.memoryMb === null ? '—' : `${stats.memoryMb.toFixed(1)} MB`}
        </span>
      </div>
      <div className="stat-tile">
        <span className="stat-label">Uptime</span>
        <span className="stat-value">{formatUptime(uptimeSeconds)}</span>
      </div>
      <div className="stat-tile">
        <span className="stat-label">PID</span>
        <span className="stat-value">{pid ?? '—'}</span>
      </div>
      <div className="stat-tile stat-tile-wide">
        <span className="stat-label">Address</span>
        <span className="stat-value path-text">{address ?? '—'}</span>
      </div>
    </div>
  );
}

function formatUptime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

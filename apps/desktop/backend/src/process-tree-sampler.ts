import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import pidusage from 'pidusage';
import { buildChildProcessEnvironment } from './child-process-env';

const execFile = promisify(execFileCallback);

export interface ProcessTreeSample {
  pids: number[];
  cpuPercent: number | null;
  memoryMb: number | null;
  sampledAt: string;
}

interface WindowsProcessReading {
  pid: number;
  cpuSeconds: number;
  workingSetBytes: number;
}

export type WindowsProcessTreeReader = (rootPid: number) => Promise<WindowsProcessReading[]>;

/**
 * Samples a managed process and all descendants. On Windows this deliberately
 * avoids pidusage/WMIC: WMIC is removed on newer Windows installations and
 * pidusage documents CPU readings there as inaccurate. PowerShell/CIM yields
 * a stable process tree plus cumulative CPU and working-set readings.
 */
export class ProcessTreeSampler {
  private previous: { sampledAtMs: number; cpuSeconds: number } | null = null;

  constructor(
    private readonly readWindowsTree: WindowsProcessTreeReader = readWindowsProcessTree,
    private readonly platform = process.platform,
    private readonly logicalCores = Math.max(1, os.cpus().length),
    private readonly now: () => number = Date.now,
  ) {}

  async sample(rootPid: number): Promise<ProcessTreeSample> {
    if (this.platform === 'win32') {
      const readings = await this.readWindowsTree(rootPid);
      if (readings.length === 0) throw new Error('The managed server process no longer exists');

      const sampledAtMs = this.now();
      const cpuSeconds = readings.reduce((total, reading) => total + reading.cpuSeconds, 0);
      const memoryBytes = readings.reduce((total, reading) => total + reading.workingSetBytes, 0);
      const previous = this.previous;
      this.previous = { sampledAtMs, cpuSeconds };

      const elapsedSeconds = previous ? (sampledAtMs - previous.sampledAtMs) / 1000 : 0;
      const cpuPercent = previous && elapsedSeconds > 0
        ? round1(clamp(((cpuSeconds - previous.cpuSeconds) / elapsedSeconds / this.logicalCores) * 100, 0, 100))
        : null;
      return {
        pids: readings.map((reading) => reading.pid).sort((a, b) => a - b),
        cpuPercent,
        memoryMb: round1(memoryBytes / (1024 * 1024)),
        sampledAt: new Date(sampledAtMs).toISOString(),
      };
    }

    const usage = await pidusage(rootPid);
    const sampledAtMs = this.now();
    return {
      pids: [rootPid],
      cpuPercent: round1(usage.cpu),
      memoryMb: round1(usage.memory / (1024 * 1024)),
      sampledAt: new Date(sampledAtMs).toISOString(),
    };
  }

  reset(): void {
    this.previous = null;
  }
}

async function readWindowsProcessTree(rootPid: number): Promise<WindowsProcessReading[]> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const script = `
$ErrorActionPreference = 'Stop'
$rootPid = [int]${rootPid}
$samplerPid = $PID
$all = @(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId)
$children = @{}
foreach ($entry in $all) {
  $parent = [int]$entry.ParentProcessId
  if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }
  $children[$parent].Add([int]$entry.ProcessId)
}
$queue = New-Object System.Collections.Generic.Queue[int]
$seen = New-Object System.Collections.Generic.HashSet[int]
$queue.Enqueue($rootPid)
while ($queue.Count -gt 0) {
  $currentPid = $queue.Dequeue()
  # This PowerShell helper is itself a child of the managed Node/Java process
  # while sampling. Excluding it prevents the monitor from measuring itself.
  if ($currentPid -eq $samplerPid) { continue }
  if (-not $seen.Add($currentPid)) { continue }
  if ($children.ContainsKey($currentPid)) { foreach ($child in $children[$currentPid]) { $queue.Enqueue($child) } }
}
$result = foreach ($targetPid in $seen) {
  $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    [pscustomobject]@{ pid = [int]$targetPid; cpuSeconds = [double]$process.CPU; workingSetBytes = [int64]$process.WorkingSet64 }
  }
}
@($result) | ConvertTo-Json -Compress
`;
  const shell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  const { stdout } = await execFile(shell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], {
    windowsHide: true,
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
    env: buildChildProcessEnvironment(),
  });
  const text = stdout.trim();
  if (!text || text === 'null') return [];
  const parsed: unknown = JSON.parse(text);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap((value): WindowsProcessReading[] => {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as Partial<WindowsProcessReading>;
    const pid = candidate.pid;
    const cpuSeconds = candidate.cpuSeconds;
    const workingSetBytes = candidate.workingSetBytes;
    if (
      !Number.isSafeInteger(pid) ||
      typeof cpuSeconds !== 'number' || !Number.isFinite(cpuSeconds) ||
      typeof workingSetBytes !== 'number' || !Number.isFinite(workingSetBytes)
    ) return [];
    return [{
      pid: pid as number,
      cpuSeconds,
      workingSetBytes,
    }];
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

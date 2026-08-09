import { describe, expect, it } from 'vitest';
import { ProcessTreeSampler } from '../process-tree-sampler';

describe('ProcessTreeSampler', () => {
  it('aggregates child working sets and derives CPU from consecutive tree samples', async () => {
    let now = 10_000;
    let call = 0;
    const sampler = new ProcessTreeSampler(async () => {
      call += 1;
      return call === 1
        ? [
          { pid: 100, cpuSeconds: 5, workingSetBytes: 100 * 1024 * 1024 },
          { pid: 101, cpuSeconds: 1, workingSetBytes: 50 * 1024 * 1024 },
        ]
        : [
          { pid: 100, cpuSeconds: 7, workingSetBytes: 120 * 1024 * 1024 },
          { pid: 101, cpuSeconds: 2, workingSetBytes: 60 * 1024 * 1024 },
        ];
    }, 'win32', 2, () => now);

    await expect(sampler.sample(100)).resolves.toMatchObject({
      cpuPercent: null,
      memoryMb: 150,
      pids: [100, 101],
    });
    now += 3_000;
    await expect(sampler.sample(100)).resolves.toMatchObject({
      cpuPercent: 50,
      memoryMb: 180,
      pids: [100, 101],
    });
  });

  it('throws for an empty process tree so the caller can mark stats stale and retry', async () => {
    const sampler = new ProcessTreeSampler(async () => [], 'win32');
    await expect(sampler.sample(100)).rejects.toThrow(/no longer exists/);
  });
});

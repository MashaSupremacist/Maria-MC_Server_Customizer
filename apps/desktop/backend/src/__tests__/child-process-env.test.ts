import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildProcessEnvironment } from '../child-process-env';

describe('buildChildProcessEnvironment', () => {
  it('omits backend-only and unknown variables', () => {
    const env = buildChildProcessEnvironment({
      source: {
        MSC_AUTH_TOKEN: 'top-secret',
        MSC_DATA_DIR: 'C:\\private-data',
        MSC_PORT: '12345',
        NODE_OPTIONS: '--inspect',
        THIRD_PARTY_SECRET: 'also-secret',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
      },
    });

    expect(env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' });
    expect(env.MSC_AUTH_TOKEN).toBeUndefined();
    expect(env.MSC_DATA_DIR).toBeUndefined();
  });

  it('preserves required Windows variables with case-insensitive lookup', () => {
    const env = buildChildProcessEnvironment({
      source: {
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        Path: 'C:\\Windows\\System32',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        JAVA_HOME: 'C:\\Java\\current',
        PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        windir: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\Player',
      },
    });

    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATH).toBe('C:\\Windows\\System32');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
    expect(env.JAVA_HOME).toBe('C:\\Java\\current');
    expect(env.PSModulePath).toContain('WindowsPowerShell');
    expect(env.windir).toBe('C:\\Windows');
    expect(env.USERPROFILE).toBe('C:\\Users\\Player');
  });

  it('places the selected Java bin before the inherited PATH', () => {
    const javaBin = 'C:\\Runtimes\\java-21\\bin';
    const env = buildChildProcessEnvironment({
      source: { Path: 'C:\\Windows\\System32;C:\\Windows' },
      prependPath: javaBin,
    });

    expect(env.PATH).toBe(`${javaBin}${path.delimiter}C:\\Windows\\System32;C:\\Windows`);
  });
});

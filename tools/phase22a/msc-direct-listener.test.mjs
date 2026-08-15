import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import {
  BufferedSocketReader,
  encodeAuth,
  encodeFrame,
  startPhase22aListener,
} from './msc-direct-listener.mjs';

const TOKEN = 'phase22a-automated-test-token';

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, minVersion: 'TLSv1.3', rejectUnauthorized: false });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('TLS listener authenticates, pins consistently, and echoes bounded binary frames', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'msc-phase22a-'));
  const listener = await startPhase22aListener({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    stateDirectory,
    log: () => undefined,
  });

  try {
    const socket = await connect(listener.port);
    const certificate = socket.getPeerCertificate(true);
    const actualFingerprint = createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
    assert.equal(actualFingerprint, listener.fingerprint);
    assert.equal(socket.getProtocol(), 'TLSv1.3');

    const reader = new BufferedSocketReader(socket);
    socket.write(encodeAuth(TOKEN));
    assert.equal((await reader.readExact(1))[0], 1);

    const payload = Buffer.from(Array.from({ length: 65_537 }, (_, index) => index % 251));
    socket.write(encodeFrame(payload));
    const responseLength = (await reader.readExact(4)).readUInt32BE(0);
    assert.equal(responseLength, payload.length);
    assert.deepEqual(await reader.readExact(responseLength), payload);
    socket.end();

    const rejected = await connect(listener.port);
    const rejectedReader = new BufferedSocketReader(rejected);
    rejected.write(encodeAuth('phase22a-invalid-test-token'));
    assert.equal((await rejectedReader.readExact(1))[0], 0);
    rejected.end();
  } finally {
    await listener.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

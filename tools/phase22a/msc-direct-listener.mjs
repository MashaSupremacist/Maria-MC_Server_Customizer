#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import tls from 'node:tls';

export const PHASE22A_MAGIC = Buffer.from('MSC22A01', 'ascii');
export const PHASE22A_MAX_FRAME_BYTES = 1024 * 1024;

export class BufferedSocketReader {
  #buffers = [];
  #bufferedBytes = 0;
  #ended = false;
  #error = null;
  #waiters = [];

  constructor(socket) {
    socket.on('data', (chunk) => {
      this.#buffers.push(Buffer.from(chunk));
      this.#bufferedBytes += chunk.length;
      this.#wake();
    });
    socket.on('end', () => {
      this.#ended = true;
      this.#wake();
    });
    socket.on('close', () => {
      this.#ended = true;
      this.#wake();
    });
    socket.on('error', (error) => {
      this.#error = error;
      this.#wake();
    });
  }

  #wake() {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async readExact(length, { allowCleanEof = false } = {}) {
    if (!Number.isInteger(length) || length < 0) throw new RangeError('Invalid read length');
    while (this.#bufferedBytes < length) {
      if (this.#error) throw this.#error;
      if (this.#ended) {
        if (allowCleanEof && this.#bufferedBytes === 0) return null;
        throw new Error(`Connection ended with ${this.#bufferedBytes} of ${length} required bytes buffered`);
      }
      await new Promise((resolveWaiter) => this.#waiters.push(resolveWaiter));
    }

    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const first = this.#buffers[0];
      const count = Math.min(first.length, length - offset);
      first.copy(result, offset, 0, count);
      offset += count;
      this.#bufferedBytes -= count;
      if (count === first.length) this.#buffers.shift();
      else this.#buffers[0] = first.subarray(count);
    }
    return result;
  }
}

export function encodeAuth(token) {
  const tokenBytes = Buffer.from(token, 'utf8');
  if (tokenBytes.length < 16 || tokenBytes.length > 4096) {
    throw new Error('The Phase 22A token must be between 16 and 4096 UTF-8 bytes');
  }
  const result = Buffer.allocUnsafe(PHASE22A_MAGIC.length + 2 + tokenBytes.length);
  PHASE22A_MAGIC.copy(result, 0);
  result.writeUInt16BE(tokenBytes.length, PHASE22A_MAGIC.length);
  tokenBytes.copy(result, PHASE22A_MAGIC.length + 2);
  return result;
}

export function encodeFrame(payload) {
  const bytes = Buffer.from(payload);
  if (bytes.length < 1 || bytes.length > PHASE22A_MAX_FRAME_BYTES) {
    throw new Error(`Frame size must be between 1 and ${PHASE22A_MAX_FRAME_BYTES} bytes`);
  }
  const result = Buffer.allocUnsafe(4 + bytes.length);
  result.writeUInt32BE(bytes.length, 0);
  bytes.copy(result, 4);
  return result;
}

function keytoolExecutable() {
  if (process.env.JAVA_HOME) {
    const executable = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
    if (existsSync(executable)) return executable;
  }
  return process.platform === 'win32' ? 'keytool.exe' : 'keytool';
}

function ensureIdentity(stateDirectory) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const identityPath = join(stateDirectory, 'identity.json');
  const pfxPath = join(stateDirectory, 'phase22a-listener.p12');
  let identity;

  if (existsSync(identityPath) && existsSync(pfxPath)) {
    identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  } else {
    identity = { password: randomBytes(24).toString('base64url') };
    const keytool = keytoolExecutable();
    execFileSync(keytool, [
      '-genkeypair',
      '-alias', 'msc-phase22a',
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-sigalg', 'SHA256withRSA',
      '-validity', '365',
      '-dname', 'CN=MSC Phase 22A Direct Listener',
      '-storetype', 'PKCS12',
      '-keystore', pfxPath,
      '-storepass', identity.password,
      '-keypass', identity.password,
      '-noprompt',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  }

  const certificatePem = execFileSync(keytoolExecutable(), [
    '-exportcert',
    '-rfc',
    '-alias', 'msc-phase22a',
    '-keystore', pfxPath,
    '-storepass', identity.password,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const certificate = new X509Certificate(certificatePem);
  return {
    pfx: readFileSync(pfxPath),
    passphrase: identity.password,
    fingerprint: certificate.fingerprint256.replaceAll(':', '').toUpperCase(),
  };
}

function equalToken(received, expected) {
  const expectedBytes = Buffer.from(expected, 'utf8');
  return received.length === expectedBytes.length && timingSafeEqual(received, expectedBytes);
}

async function handleConnection(socket, expectedToken, log) {
  const reader = new BufferedSocketReader(socket);
  socket.setNoDelay(true);
  socket.setTimeout(60_000, () => socket.destroy(new Error('Phase 22A connection timed out')));
  const remote = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
  try {
    const magic = await reader.readExact(PHASE22A_MAGIC.length);
    if (!magic.equals(PHASE22A_MAGIC)) throw new Error('Protocol magic mismatch');
    const tokenLength = (await reader.readExact(2)).readUInt16BE(0);
    if (tokenLength < 16 || tokenLength > 4096) throw new Error('Invalid authentication token length');
    const receivedToken = await reader.readExact(tokenLength);
    if (!equalToken(receivedToken, expectedToken)) {
      socket.end(Buffer.from([0]));
      log(`Rejected authentication from ${remote}`);
      return;
    }

    socket.write(Buffer.from([1]));
    log(`Accepted TLS ${socket.getProtocol() ?? 'unknown'} test connection from ${remote}`);
    while (!socket.destroyed) {
      const header = await reader.readExact(4, { allowCleanEof: true });
      if (header === null) break;
      const length = header.readUInt32BE(0);
      if (length < 1 || length > PHASE22A_MAX_FRAME_BYTES) throw new Error(`Invalid frame length ${length}`);
      const payload = await reader.readExact(length);
      socket.write(encodeFrame(payload));
    }
  } catch (error) {
    if (!socket.destroyed) socket.destroy();
    log(`Connection ${remote} closed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function startPhase22aListener({
  host = '::',
  port = 44333,
  token = randomBytes(24).toString('base64url'),
  stateDirectory = join(homedir(), '.msc-phase22a'),
  log = console.log,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535');
  encodeAuth(token);
  const identity = ensureIdentity(resolve(stateDirectory));
  const server = tls.createServer({
    pfx: identity.pfx,
    passphrase: identity.passphrase,
    minVersion: 'TLSv1.3',
    requestCert: false,
  }, (socket) => void handleConnection(socket, token, log));

  await new Promise((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen({ host, port, ipv6Only: false }, () => {
      server.off('error', rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener did not return an IP socket address');

  return {
    host: address.address,
    port: address.port,
    token,
    fingerprint: identity.fingerprint,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--host' && value) { options.host = value; index += 1; }
    else if (argument === '--port' && value) { options.port = Number.parseInt(value, 10); index += 1; }
    else if (argument === '--token' && value) { options.token = value; index += 1; }
    else if (argument === '--state-dir' && value) { options.stateDirectory = resolve(value); index += 1; }
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node msc-direct-listener.mjs [--host ::] [--port 44333] [--token TOKEN] [--state-dir PATH]');
    return;
  }
  const listener = await startPhase22aListener(options);
  console.log('');
  console.log('PHASE22A_LISTENER_READY');
  console.log(`Bind address: ${listener.host}`);
  console.log(`Port: ${listener.port}`);
  console.log(`Token: ${listener.token}`);
  console.log(`Certificate SHA-256: ${listener.fingerprint}`);
  console.log('Keep this window open while the phone runs the Direct Transport test.');

  const stop = async () => {
    await listener.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    console.error(`Phase 22A listener failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

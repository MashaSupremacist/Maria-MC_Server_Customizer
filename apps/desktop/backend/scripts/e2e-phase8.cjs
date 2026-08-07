// E2E: gamerules + player management against a live backend.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const backendDist = path.resolve('dist/index.js');
const token = 'e2e-token';
const dataDir = path.join(os.tmpdir(), `msc-p8-e2e-${Date.now()}`);
const serverDir = path.join(dataDir, 'library', 'gamerule-server');
const worldDir = path.join(serverDir, 'world');

fs.mkdirSync(path.join(worldDir, 'settings'), { recursive: true });
fs.writeFileSync(
  path.join(worldDir, 'settings', 'gamerules.json'),
  JSON.stringify({ doFireTick: false, keepInventory: true, randomTickSpeed: 6 }),
);
fs.writeFileSync(path.join(serverDir, 'whitelist.json'), JSON.stringify([
  { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Alice' },
  { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef', name: 'Bob' },
]));
fs.writeFileSync(path.join(serverDir, 'ops.json'), JSON.stringify([]));
fs.writeFileSync(path.join(serverDir, 'banned-players.json'), JSON.stringify([]));
fs.writeFileSync(path.join(serverDir, 'banned-ips.json'), JSON.stringify([]));
fs.writeFileSync(path.join(serverDir, 'server.properties'), 'motd=Hello E2E\nserver-port=25565\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(process.execPath, [backendDist], {
    env: { ...process.env, MSC_AUTH_TOKEN: token, MSC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend never ready. stderr: ${stderr}`)), 15000);
    child.stdout.on('data', (d) => {
      const m = d.toString().match(/MSC_READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const http = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-msc-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  const created = await http('POST', '/servers', {
    name: 'Gamerule Server',
    edition: 'java',
    serverType: 'vanilla',
    folderPath: serverDir,
    version: '1.21.4',
  });
  console.log('create server:', created.status, created.json.id ? 'ok' : JSON.stringify(created.json));
  const id = created.json.id;

  // 1. Offline gamerule read.
  const gamerules = await http('GET', `/servers/${id}/gamerules`);
  const rules = gamerules.json.rules ?? [];
  const doFireTick = rules.find((r) => r.key === 'doFireTick');
  console.log('gamerules offline:', gamerules.status, rules.length, 'rules; doFireTick =', doFireTick?.value, '| offline =', gamerules.json.offline);

  // 2. Offline gamerule update -> writes gamerules.json.
  const setRule = await http('PUT', `/servers/${id}/gamerules`, { key: 'doFireTick', value: 'true' });
  const fileAfter = JSON.parse(fs.readFileSync(path.join(worldDir, 'settings', 'gamerules.json'), 'utf8'));
  console.log('update gamerule (offline):', setRule.status, setRule.json.ok, '| file doFireTick =', fileAfter.doFireTick);

  // 3. Whitelist read + update (file edit).
  const wl = await http('GET', `/servers/${id}/whitelist`);
  console.log('whitelist get:', wl.status, wl.json.length, 'entries');
  const wlUpdate = await http('PUT', `/servers/${id}/whitelist`, [
    ...wl.json,
    { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1', name: 'Carol' },
  ]);
  const wlFile = JSON.parse(fs.readFileSync(path.join(serverDir, 'whitelist.json'), 'utf8'));
  console.log('whitelist add:', wlUpdate.status, wlUpdate.json.ok, '| file has Carol =', wlFile.some((e) => e.name === 'Carol'));

  // 4. Ops add (file edit).
  const opsUpdate = await http('PUT', `/servers/${id}/operators`, [{ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee2', name: 'Dave' }]);
  const opsFile = JSON.parse(fs.readFileSync(path.join(serverDir, 'ops.json'), 'utf8'));
  console.log('ops add:', opsUpdate.status, opsUpdate.json.ok, '| file has Dave =', opsFile.some((e) => e.name === 'Dave'));

  // 5. Bans add (file edit).
  const bansUpdate = await http('PUT', `/servers/${id}/bans`, [{ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee3', name: 'Eve' }]);
  const bansFile = JSON.parse(fs.readFileSync(path.join(serverDir, 'banned-players.json'), 'utf8'));
  console.log('bans add:', bansUpdate.status, bansUpdate.json.ok, '| file has Eve =', bansFile.some((e) => e.name === 'Eve'));

  // 6. IP bans add (file edit).
  const ipUpdate = await http('PUT', `/servers/${id}/ip-bans`, [{ name: '1.2.3.4', uuid: '' }]);
  const ipFile = JSON.parse(fs.readFileSync(path.join(serverDir, 'banned-ips.json'), 'utf8'));
  console.log('ip-bans add:', ipUpdate.status, ipUpdate.json.ok, '| file has 1.2.3.4 =', ipFile.some((e) => e.name === '1.2.3.4'));

  // 7. Invalid gamerule value rejected.
  const bad = await http('PUT', `/servers/${id}/gamerules`, { key: 'randomTickSpeed', value: 'abc' });
  console.log('invalid gamerule value rejected:', bad.status, bad.json.ok === false, '-', bad.json.error);

  // 8. Player command while offline -> offline:true.
  const cmd = await http('POST', `/servers/${id}/commands`, { command: 'kick Alice' });
  console.log('command while offline:', cmd.status, 'offline =', cmd.json.offline);

  child.kill('SIGTERM');
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});

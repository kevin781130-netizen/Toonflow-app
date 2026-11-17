import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const providerPath = new URL('./h3Local.ts', import.meta.url);
const registryPath = new URL('../../index.ts', import.meta.url);
const request = { model: 'h3-native-shot', prompt: 'A safe static wide shot', duration: 5 };
function context(fetchImpl) {
  const requests = [];
  const checkpoints = [];
  return {
    requests,
    checkpoints,
    ctx: {
      config: { baseUrl: 'http://127.0.0.1:17960' },
      saveTaskData: async data => checkpoints.push(data),
      tool: { fetch: async (url, opts = {}) => {
        const path = new URL(url).pathname;
        const method = opts.method || 'GET';
        requests.push({ path, method });
        return fetchImpl(path, method);
      } },
    },
  };
}
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

// Startup isolation: importing the optional adapter must not contact H3.
test('standalone Toonflow: importing the optional provider makes no network calls', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('not allowed at import'); };
  try {
    const imported = await import(providerPath.href + '?detach=standalone');
    assert.equal(imported.default.id, 'h3Local');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('standalone Toonflow: H3 offline fails before project and GPU writes', async () => {
  const imported = await import(providerPath.href);
  const { ctx, requests, checkpoints } = context(async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(() => imported.default.generateVideo.call(ctx, request), /ECONNREFUSED/);
  assert.ok(requests.length >= 1);
  assert.ok(requests.every(x => x.method === 'GET'));
  assert.equal(checkpoints.length, 0);
});

test('standalone Toonflow: disabled H3 bridge returns 404 without creating anything', async () => {
  const imported = await import(providerPath.href);
  const { ctx, requests, checkpoints } = context((path) => {
    if (path.endsWith('/validate')) return reply({ schema_live: true, validation: { ok: true }, pack: { template: { bound: true } } });
    if (path === '/api/h3/status') return reply({ online: true, h3_available: true, template_bound: true });
    if (path === '/api/integrations/toonflow/health') return reply({}, 404);
    throw new Error('Unexpected access');
  });
  await assert.rejects(() => imported.default.generateVideo.call(ctx, request), /HTTP 404/);
  assert.ok(requests.every(x => x.method === 'GET'));
  assert.equal(checkpoints.length, 0);
});

test('incompatible H3 bridge protocol never creates projects or GPU jobs', async () => {
  const imported = await import(providerPath.href);
  const { ctx, requests, checkpoints } = context((path) => {
    if (path.endsWith('/validate')) return reply({ schema_live: true, validation: { ok: true }, pack: { template: { bound: true } } });
    if (path === '/api/h3/status') return reply({ online: true, h3_available: true, template_bound: true });
    if (path === '/api/integrations/toonflow/health') return reply({ integration: 'toonflow', enabled: true, contract: 'native_take_v0' });
    throw new Error('Unexpected access');
  });
  await assert.rejects(() => imported.default.generateVideo.call(ctx, request), /not verified and online/);
  assert.ok(requests.every(x => x.method === 'GET'));
  assert.equal(checkpoints.length, 0);
});

test('Toonflow Provider registry can be reverted exactly to unmodified Master', () => {
  const mounted = readFileSync(registryPath, 'utf8');
  assert.ok(mounted.includes('import h3Local from "./src/media/h3Local";'));
  assert.ok(mounted.includes('compshare, h3Local] as const;'));
  const reverted = mounted
    .replace('import h3Local from "./src/media/h3Local";\n', '')
    .replace('compshare, h3Local] as const;', 'compshare] as const;');
  const sha = createHash('sha1').update(`blob ${Buffer.byteLength(reverted)}\0`).update(reverted).digest('hex');
  assert.equal(sha, 'a0f00efcd7eb8bbfdbd190f1fd339e6a7dfc7e62');
});

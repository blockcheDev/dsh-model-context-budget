import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CHANNEL, ENDPOINT, apply } from '../src/host.js';

const require = createRequire(import.meta.url);
const anchor = process.env.DSH_INSTALL_DIR ?? process.cwd();
const load = name => import(pathToFileURL(require.resolve(name, { paths: [anchor] })).href);

test('实际安装版 Connection：独立通道可与官方 /api interceptor 共存并撤回', async () => {
  const { Context } = await load('@deepseek-ai/cordis');
  const { HostConnectionService } = await load('@deepseek-ai/dsh-client-connection');
  const ctx = new Context();
  const routes = new Map();
  ctx.provide('webServer', {
    protocol: 'http:',
    register(route) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route);
      return async () => { routes.delete(route.path); };
    },
  });
  const connection = new HostConnectionService(ctx, [], { isAuthenticated: () => true });
  const ok = async () => ({ ok: true, value: 'official gateway' });
  const unregisterOfficial = connection.rpc.intercept('/api', () => true, ok);
  try {
    assert.throws(() => connection.rpc.intercept('/api', () => false, ok), /already has an interceptor/);
    assert.throws(() => connection.rpc.handle('/api', ok), /reserved RPC channel/);
    assert.match(ENDPOINT, /^[A-Za-z0-9_$.-]+$/);
    // Register the actual plugin, not a mirrored handler. Only its transport
    // and read-only tool are instantiated; no real profile/services are read.
    ctx.provide('tools', { register() { return () => {}; } });
    apply(ctx);
    assert.equal(routes.has(CHANNEL), true);
    const shared = connection.createSharedFetchHandler('/api');
    const request = new Request('http://localhost/api/check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-gateway', method: 'check', payload: {} }),
    });
    const response = await shared.fetch(request, connection.browserPeer);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.value, 'official gateway');
  } finally {
    await unregisterOfficial();
    await connection.browserPeer.dispose();
    await ctx.fiber.dispose();
  }
  assert.equal(routes.size, 0);
});

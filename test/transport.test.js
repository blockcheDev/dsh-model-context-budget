import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as plugin from '../src/host.js';
// Public route of the maintained package; do not derive the expectation from
// the Host implementation, which would also accept a stale generated endpoint.
const ENDPOINT = 'local-model-context-budget/budget';
const RPC_PATH = `/api/${ENDPOINT}`;

const require = createRequire(import.meta.url);
const anchor = process.env.DSH_INSTALL_DIR ?? process.cwd();
const load = name => import(pathToFileURL(require.resolve(name, { paths: [anchor] })).href);

test('实际安装版 Connection：精确预算路由在真实插件作用域内与 Gateway 共存、认证并撤回', async () => {
  const { Context } = await load('@deepseek-ai/cordis');
  const { HostConnectionService } = await load('@deepseek-ai/dsh-client-connection');
  const ctx = new Context();
  // Same-level providers reproduce Cordis's real dependency boundary. Root
  // provisions and direct apply() would hide dependencies in service code.
  await ctx.plugin(provider => {
    provider.provide('webServer', { protocol: 'http:' });
  });
  await ctx.plugin({
    apply(provider) {
      new HostConnectionService(provider, [], {
        isAuthenticated: request => new Headers(request.headers).get('cookie') === 'budget-test-owner',
        authenticateApi: () => undefined,
      });
    },
  });
  const connection = ctx.connection;
  const unregisterOfficial = connection.rpc.intercept('/api', endpoint => endpoint === 'check',
    async () => ({ ok: true, value: 'official gateway' }));
  const request = (endpoint, payload = {}, cookie = 'budget-test-owner', method = endpoint) => new Request(`http://localhost/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-transport', method, payload }),
  });
  try {
    assert.throws(() => connection.rpc.intercept('/api', () => false, async () => ({})), /already has an interceptor/);
    // Business placeholders are not read: these transport probes use an invalid
    // action, and no actual profile, credential, Agent or model is instantiated.
    for (const name of ['llm', 'agents', 'agentPresets', 'settingsController', 'configEditor']) ctx.provide(name, {});
    ctx.provide('tools', { register() { return () => {}; } });
    const fiber = await ctx.plugin(plugin);
    const shared = connection.createSharedFetchHandler('/api');
    const official = await shared.fetch(request('check'), connection.browserPeer);
    assert.equal((await official.json()).result.value, 'official gateway');
    assert.equal(shared.requestBodyMode({ method: 'POST', url: new URL(`http://localhost${RPC_PATH}`) }), 'buffered');
    const response = await shared.fetch(request(ENDPOINT, { sessionId: 'test-session', action: 'invalid' }), connection.browserPeer);
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.type, 'server-response');
    assert.equal(envelope.rpcId, 'test-transport');
    assert.equal(envelope.result.error.code, 'budget/request');
    const mismatch = await shared.fetch(request(ENDPOINT, {}, 'budget-test-owner', 'wrong-method'), connection.browserPeer);
    assert.equal((await mismatch.json()).result.error.code, 'budget/request');
    const unauthenticated = await shared.fetch(request(ENDPOINT, {}, ''), connection.browserPeer);
    assert.equal(unauthenticated.status, 401);
    const untrusted = new Request(request(ENDPOINT), { headers: { 'content-type': 'application/json', host: 'untrusted.example', cookie: 'budget-test-owner' } });
    assert.equal((await shared.fetch(untrusted, connection.browserPeer)).status, 403);
    await fiber.dispose();
    assert.equal((await shared.fetch(request(ENDPOINT), connection.browserPeer)).status, 404);
    assert.equal((await shared.fetch(request('check'), connection.browserPeer)).status, 200);
  } finally {
    await unregisterOfficial();
    await ctx.fiber.dispose();
  }
});

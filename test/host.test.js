import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINT, RPC_PATH, apply, createBudgetController } from '../src/host.js';

const PI_AI = '@deepseek-ai/dsh-llm-pi-ai';
const API_KEY = '@deepseek-ai/dsh-llm-deepseek-api-key';
const ACCOUNT = '@deepseek-ai/dsh-llm-deepseek-account';
const BASIC = '@deepseek-ai/dsh-compaction-basic';
const copy = value => structuredClone(value);
const at = (value, path) => path.reduce((node, key) => node?.[key], value);
class BasicCompactionEngine {
  config = { thresholdRatio: 0.8, headroomTokens: 65_536, retainRatio: 0.16, modelPolicies: [], auto: true };
}

// This fixture models the public Settings/LLM contracts, not the plugin's helpers.
// Mutate acts on the current composed raw configuration, including lower layers,
// preserves a secret never included in describe(), and enforces the read revision.
function fixture({ family = PI_AI, profile, installed = [], model = 'sol', provider = 'gateway' } = {}) {
  const path = family === ACCOUNT ? [] : ['providers', provider];
  const defaultProfile = {
    models: [{ id: 'sol', contextWindow: 1_000_000, maxTokens: 128_000, name: 'Sol', input: ['text'] },
      { id: 'other', contextWindow: 1_000_000, maxTokens: 16_000, custom: 'keep' }],
    headers: { 'x-custom': 'unchanged' },
  };
  const initialProfile = copy(profile ?? defaultProfile);
  let raw = path.length ? { providers: { [provider]: initialProfile, untouched: { models: [{ id: 'keep', contextWindow: 500_000 }] } } }
    : initialProfile;
  raw.secret = 'NEVER-SEND-OR-DELETE';
  let revision = 1;
  let selected = { provider, model };
  const engine = new BasicCompactionEngine();
  const agent = { id: 'session-1', ctx: {}, model: { current: () => copy(selected) } };
  let resolveHook = null;
  let rejectWrite = false;
  let badReadback = false;
  let committed = false;
  let fetchRoute;
  let tool;
  const ns = 'llm-models';
  const getProfile = () => at(raw, path);
  const redacted = () => { const value = copy(raw); delete value.secret; return value; };
  const offered = () => {
    const current = getProfile();
    return current.models?.length ? current.models : installed.map(base => ({ ...base, ...current.modelOverrides?.[base.id] }));
  };
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined },
    agentPresets: {
      serviceFor: () => engine,
      composedPreset: () => 'dev',
      inspectCompositions: () => [{ modules: [{ moduleName: BASIC }] }],
    },
    configEditor: { entries: () => [{ options: { id: ns, name: family } }] },
    settingsController: {
      describe: () => ({ writable: true, hasDocument: true, namespaces: [{ ns, revision, value: redacted(), user: {} }] }),
      async mutate(targetNs, ops, expectedRevision) {
        assert.equal(targetNs, ns);
        if (rejectWrite || expectedRevision !== revision) {
          const error = new Error('configuration conflict'); error.code = 'settings/conflict'; throw error;
        }
        for (const op of ops) {
          assert.equal(op.op, 'set');
          assert.equal(op.path.at(-1), 'contextWindow');
          let node = raw;
          for (const part of op.path.slice(0, -1)) node = node[part] ??= {};
          node[op.path.at(-1)] = op.value;
        }
        revision++; committed = true;
      },
    },
    llm: {
      listConfigurableProviders: () => [{ provider, displayName: 'Gateway', settingsNs: ns, settingsPath: path }],
      async discoverModels(targetNs, request) {
        assert.equal(targetNs, ns);
        assert.deepEqual(request, { provider }); // Do not pass baseURL/credentials to trigger a network probe.
        if (installed.length) return copy(installed);
        const error = new Error('no installed catalog'); error.code = 'DISCOVERY_FAILED'; throw error;
      },
      async listModels() { return offered().map(entry => ({ id: entry.id, name: entry.name ?? entry.id })); },
      async resolveModelInfo(_provider, id) {
        if (resolveHook) await resolveHook();
        const current = getProfile();
        const explicit = current.models?.length ? current.models.find(entry => entry.id === id) : current.modelOverrides?.[id];
        const base = installed.find(entry => entry.id === id);
        if (!base && !current.models?.some(entry => entry.id === id)) throw new Error('UNKNOWN_MODEL');
        const contextWindow = committed && badReadback ? 1_000_000 : explicit?.contextWindow ?? base?.contextWindow;
        return { id, name: explicit?.name ?? base?.name ?? id, context: { contextWindow },
          ...(explicit?.maxTokens === undefined ? {} : { defaultMaxTokens: explicit.maxTokens }) };
      },
    },
    connection: {
      browserPeer: {},
      admit(request) { return { peer: request.headers.get('x-test-peer') === 'browser' ? ctx.connection.browserPeer : {} }; },
      fetch: {
        register(route) {
          assert.equal(route.path, RPC_PATH);
          fetchRoute = route.fetch; return () => {};
        },
      },
      rpc: { intercept() { throw new Error('connection: shared RPC channel "/api" already has an interceptor'); } },
    },
    tools: { register(definition) { tool = definition; return () => {}; } },
    effect: operation => operation(),
  };
  return {
    ctx, agent, engine, controller: createBudgetController(ctx),
    raw: () => copy(raw), profile: getProfile,
    changeSelection: next => { selected = next; },
    changeRevision: () => { revision++; },
    onResolve: hook => { resolveHook = hook; },
    rejectWrite: () => { rejectWrite = true; },
    badReadback: () => { badReadback = true; },
    async rpc(method, payload, signal, peer) {
      const response = await fetchRoute(new Request(`http://localhost${RPC_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-peer': peer === ctx.connection.browserPeer ? 'browser' : 'api' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'test-budget', method, payload }), signal,
      }));
      return (await response.json()).result;
    },
    tool: () => tool,
  };
}

const codeIs = code => error => error.code === code;

test('读取/预览不写入，确认只改目标字段并保留秘密、其他供应商与模型', async () => {
  const f = fixture();
  const before = f.raw();
  const view = await f.controller.read('session-1');
  assert.equal(view.models[0].capacityMaxTokens, 128_000);
  assert.equal(view.models[0].defaultOutputTokens, 128_000);
  assert.equal(JSON.stringify(view).includes('NEVER-SEND-OR-DELETE'), false);
  const preview = await f.controller.preview('session-1', 'sol', 260_000);
  assert.equal(preview.after.contextWindow, 453_536);
  assert.deepEqual(f.raw(), before);
  const saved = await f.controller.save('session-1', preview.token);
  const expected = copy(before);
  expected.providers.gateway.models[0].contextWindow = 453_536;
  assert.deepEqual(f.raw(), expected);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.view.models[0].contextWindow, 453_536);
  assert.equal(saved.view.models[0].budget.thresholdTokens, 260_000);
  assert.deepEqual(saved.view.selected, view.selected);
  await assert.rejects(f.controller.save('session-1', preview.token), codeIs('preview'));
});

test('继承目录输出能力不变成请求预留，modelOverrides 保存不缩窄目录', async () => {
  const f = fixture({ profile: { modelOverrides: {}, defaultMaxTokens: 128_000 }, installed: [
    { id: 'sol', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'other', contextWindow: 1_000_000, maxTokens: 16_000 },
  ] });
  const before = f.raw();
  const view = await f.controller.read('session-1');
  assert.equal(view.models[0].capacityMaxTokens, 128_000);
  assert.equal(view.models[0].defaultOutputTokens, 0);
  const preview = await f.controller.preview('session-1', 'sol', 260_000);
  assert.equal(preview.after.contextWindow, 325_536);
  await f.controller.save('session-1', preview.token);
  const expected = copy(before);
  expected.providers.gateway.modelOverrides.sol = { contextWindow: 325_536 };
  assert.deepEqual(f.raw(), expected);
  assert.equal((await f.controller.read('session-1')).models.length, 2);
});

test('DeepSeek API 现有 models 和 Account modelOverrides 均使用官方单模型路径', async () => {
  const api = fixture({ family: API_KEY });
  const apiPreview = await api.controller.preview('session-1', 'other', 260_000);
  await api.controller.save('session-1', apiPreview.token);
  assert.equal(api.profile().models[0].contextWindow, 1_000_000);
  assert.equal(api.profile().models[1].contextWindow, 341_536);
  assert.equal(api.profile().models[1].custom, 'keep');
  const account = fixture({ family: ACCOUNT, profile: { modelOverrides: { sol: { maxTokens: 128_000 } } },
    installed: [{ id: 'sol', contextWindow: 1_000_000, maxTokens: 128_000 }] });
  const before = account.raw();
  const preview = await account.controller.preview('session-1', 'sol', 260_000);
  await account.controller.save('session-1', preview.token);
  const expected = copy(before); expected.modelOverrides.sol.contextWindow = 453_536;
  assert.deepEqual(account.raw(), expected);
});

test('预览后配置 revision、默认输出预留、策略或会话选择变化均拒绝旧确认', async () => {
  for (const change of [
    f => f.changeRevision(),
    f => { f.profile().models[0].maxTokens = 64_000; },
    f => { f.engine.config = { ...f.engine.config, headroomTokens: 32_768 }; },
    f => f.changeSelection({ provider: 'gateway', model: 'other' }),
  ]) {
    const f = fixture();
    const preview = await f.controller.preview('session-1', 'sol', 260_000);
    change(f);
    const before = f.raw();
    await assert.rejects(f.controller.save('session-1', preview.token), codeIs('stale'));
    assert.deepEqual(f.raw(), before);
  }
});

test('元数据 await 期间发生配置变化不能混合成可保存快照', async () => {
  const f = fixture();
  f.onResolve(() => f.changeRevision());
  const before = f.raw();
  await assert.rejects(f.controller.read('session-1'), codeIs('stale'));
  assert.deepEqual(f.raw(), before);
});

test('提交前冲突保持配置；提交后回读失败明确表示已提交且不重复保存', async () => {
  const f = fixture();
  const preview = await f.controller.preview('session-1', 'sol', 260_000);
  f.rejectWrite();
  const before = f.raw();
  await assert.rejects(f.controller.save('session-1', preview.token), codeIs('settings/conflict'));
  assert.deepEqual(f.raw(), before);
  const committed = fixture();
  const next = await committed.controller.preview('session-1', 'sol', 260_000);
  committed.badReadback();
  await assert.rejects(committed.controller.save('session-1', next.token), codeIs('readback'));
  assert.equal(committed.profile().models[0].contextWindow, 453_536);
  await assert.rejects(committed.controller.save('session-1', next.token), codeIs('preview'));
});

test('未知适配器、无活动会话、跨会话确认均不能写配置', async () => {
  const f = fixture({ family: '@example/unknown-adapter' });
  const before = f.raw();
  assert.equal((await f.controller.read('session-1')).models[0].writable, false);
  await assert.rejects(f.controller.preview('session-1', 'sol', 260_000), codeIs('readonly'));
  await assert.rejects(f.controller.read('inactive-session'), codeIs('session'));
  const active = fixture();
  const preview = await active.controller.preview('session-1', 'sol', 260_000);
  await assert.rejects(active.controller.save('other-session', preview.token), codeIs('preview'));
  assert.deepEqual(f.raw(), before);
});

test('非 browserPeer 的 RPC 不可读取或授权保存', async () => {
  const f = fixture(); apply(f.ctx);
  const before = f.raw();
  const signal = new AbortController().signal;
  const denied = await f.rpc(ENDPOINT, { sessionId: 'session-1', action: 'save', token: 'forged' }, signal, {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'budget/forbidden');
  const allowed = await f.rpc(ENDPOINT, { sessionId: 'session-1', action: 'read' }, signal, f.ctx.connection.browserPeer);
  assert.equal(allowed.ok, true);
  assert.deepEqual(f.raw(), before);
});

test('已脱离目录的 modelOverrides 条目仍显示且只读', async () => {
  const f = fixture({ profile: { modelOverrides: { orphan: { contextWindow: 500_000 } } },
    installed: [{ id: 'sol', contextWindow: 1_000_000, maxTokens: 128_000 }] });
  const rows = (await f.controller.read('session-1')).models;
  const orphan = rows.find(row => row.id === 'orphan');
  assert.ok(orphan, '已配置异常条目不应被有效目录列表遗漏');
  assert.equal(orphan.writable, false);
});

test('只读工具与 UI 使用相同预算，不签发确认 token、不干扰用户预览、不能保存', async () => {
  const f = fixture(); apply(f.ctx);
  const before = f.raw();
  const signal = new AbortController().signal;
  const ui = await f.rpc(ENDPOINT, { sessionId: 'session-1', action: 'read' }, signal, f.ctx.connection.browserPeer);
  const exec = { agent: f.agent, signal };
  const tool = f.tool();
  const read = await tool.execute({ action: 'read' }, exec);
  assert.deepEqual(read, ui.value);
  const pending = await f.rpc(ENDPOINT, { sessionId: 'session-1', action: 'preview', modelId: 'sol', target: 260_000 }, signal, f.ctx.connection.browserPeer);
  assert.equal(pending.ok, true);
  const calculated = await tool.execute({ action: 'preview', modelId: 'sol', target: 300_000 }, exec);
  assert.equal(calculated.after.contextWindow, 493_536);
  assert.equal(calculated.token, undefined);
  await assert.rejects(tool.execute({ action: 'save', token: pending.value.token }, exec), codeIs('readonly'));
  assert.deepEqual(f.raw(), before);
  const saved = await f.rpc(ENDPOINT, { sessionId: 'session-1', action: 'save', token: pending.value.token }, signal, f.ctx.connection.browserPeer);
  assert.equal(saved.ok, true);
  assert.equal(saved.value.contextWindow, 453_536);
});

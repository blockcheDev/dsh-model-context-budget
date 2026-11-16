import { createHash, randomUUID } from 'node:crypto';
import { BudgetError, calculateBudget, invertBudget, routedPolicy } from './budget.js';

export const PACKAGE = '@dsh-local/view-559fb07a-7828-4e51-a989-88b2f9591ca1';
export const CHANNEL = '/api';
export const ENDPOINT = 'dsh-local-model-budget-559fb07a-7828-4e51-a989-88b2f9591ca1/budget';
export const RPC_PATH = `${CHANNEL}/${ENDPOINT}`;
export const inject = ['connection', 'llm', 'agents', 'agentPresets', 'settingsController', 'configEditor', 'tools'];
const PI_AI = '@deepseek-ai/dsh-llm-pi-ai';
const API_KEY = '@deepseek-ai/dsh-llm-deepseek-api-key';
const ACCOUNT = '@deepseek-ai/dsh-llm-deepseek-account';
const BASIC = '@deepseek-ai/dsh-compaction-basic';
const at = (object, path) => path.reduce((value, key) => value?.[key], object);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const signature = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const messageOf = error => error instanceof Error ? error.message : String(error);

// No Agent is activated, resumed, intercepted, or compacted by this controller.
export function createBudgetController(ctx) {
  const previews = new Map();
  const select = sessionId => {
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new BudgetError('session', '当前会话没有已加载的 Agent。请返回会话打开后再刷新；本插件不会恢复会话。');
    const selected = agent.model.current();
    if (!selected?.provider || !selected?.model) throw new BudgetError('selection', '当前会话尚未选择模型。');
    return { agent, selected };
  };
  const policyConfig = agent => {
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction');
    const compositions = ctx.agentPresets.inspectCompositions(agent.ctx);
    if (!engine || engine.constructor.name !== 'BasicCompactionEngine'
      || !compositions.some(entry => entry.modules.some(module => module.moduleName === BASIC))) {
      throw new BudgetError('policy', '所选 Agent preset 未挂载可识别的官方 BasicCompactionEngine，不能确定计算口径。');
    }
    return engine.config;
  };

  async function read(sessionId, signal) {
    signal?.throwIfAborted();
    const { agent, selected } = select(sessionId);
    const presetId = ctx.agentPresets.composedPreset(agent.ctx) ?? null;
    const directory = ctx.llm.listConfigurableProviders().find(entry => entry.provider === selected.provider);
    const settings = ctx.settingsController.describe();
    const namespace = settings.namespaces.find(entry => entry.ns === directory?.settingsNs);
    const moduleName = ctx.configEditor.entries().find(entry => entry.options.id === namespace?.ns)?.options.name;
    if (!directory || !namespace) throw new BudgetError('configuration', '所选供应商没有官方可寻址的模型配置服务。');
    const profile = at(namespace.value, directory.settingsPath);
    if (!record(profile)) throw new BudgetError('configuration', '无法读取所选供应商的有效模型配置。');
    const family = moduleName === PI_AI ? 'pi-ai' : moduleName === API_KEY ? 'deepseek-api-key'
      : moduleName === ACCOUNT ? 'deepseek-account' : 'unknown';
    let installed = [];
    let models = [];
    if (family === 'pi-ai') {
      // Verified 0.2.2-rc.2: {provider} is a local catalog read; no baseURL,
      // API key, credentials, headers, or endpoint interrogation is supplied.
      try { installed = await ctx.llm.discoverModels(namespace.ns, { provider: selected.provider }, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (error?.code !== 'DISCOVERY_FAILED') throw error;
      }
      const configured = Array.isArray(profile.models) && profile.models.length > 0;
      models = configured ? profile.models.map((model, index) => ({
        id: model.id, configured: model,
        path: [...directory.settingsPath, 'models', String(index), 'contextWindow'],
      })) : installed.map(model => ({
        id: model.id, configured: profile.modelOverrides?.[model.id] ?? {},
        path: [...directory.settingsPath, 'modelOverrides', model.id, 'contextWindow'],
      }));
    } else if (family === 'deepseek-account') {
      const offered = await ctx.llm.listModels(selected.provider);
      signal?.throwIfAborted();
      models = offered.map(model => ({
        id: model.id, name: model.name, configured: profile.modelOverrides?.[model.id] ?? {},
        path: [...directory.settingsPath, 'modelOverrides', model.id, 'contextWindow'],
      }));
    } else {
      models = (Array.isArray(profile.models) ? profile.models : []).map((model, index) => ({
        id: model.id, configured: model,
        path: family === 'deepseek-api-key' ? [...directory.settingsPath, 'models', String(index), 'contextWindow'] : null,
      }));
    }
    // An override can remain in settings after its model leaves the directory.
    // Keep it visible as an orphan, without inventing a writable route.
    if (record(profile.modelOverrides) && !(Array.isArray(profile.models) && profile.models.length > 0)) {
      for (const [id, configured] of Object.entries(profile.modelOverrides)) {
        if (!models.some(model => model.id === id)) models.push({ id, configured, path: null });
      }
    }
    if (!models.some(model => model.id === selected.model)) {
      models.push({ id: selected.model, configured: {}, path: null });
    }
    const uniqueIds = new Set(models.map(model => model.id));
    if (uniqueIds.size !== models.length || models.some(model => typeof model.id !== 'string' || !model.id)) {
      throw new BudgetError('configuration', '官方模型配置包含重复或无效 ID，不能确定目标模型。');
    }
    let config;
    let policyError = null;
    try { config = policyConfig(agent); }
    catch (error) { policyError = messageOf(error); }
    const rows = await Promise.all(models.map(async model => {
      const base = installed.find(entry => entry.id === model.id);
      let info;
      let error = null;
      try { info = await ctx.llm.resolveModelInfo(selected.provider, model.id, signal); }
      catch (failure) { signal?.throwIfAborted(); error = messageOf(failure); }
      let policy = null;
      let budget = null;
      let budgetError = policyError ?? error;
      if (config) {
        try { policy = routedPolicy(config, selected.provider, model.id); }
        catch (failure) { budgetError = messageOf(failure); }
      }
      const defaultOutputTokens = info ? info.defaultMaxTokens ?? 0 : null;
      const contextWindow = info?.context?.contextWindow ?? null;
      if (policy && info) {
        try { budget = calculateBudget(contextWindow, defaultOutputTokens, policy); }
        catch (failure) { budgetError = messageOf(failure); }
      }
      const capacityMaxTokens = model.configured.maxTokens ?? (family === 'pi-ai'
        ? base?.maxTokens ?? profile.defaultMaxTokens : null);
      const capacitySource = model.configured.maxTokens !== undefined ? 'configured'
        : family === 'pi-ai' && base?.maxTokens !== undefined ? 'installed'
          : family === 'pi-ai' && profile.defaultMaxTokens !== undefined ? 'adapter-fallback' : 'unavailable';
      return {
        id: model.id,
        name: info?.name ?? model.name ?? model.configured.name ?? base?.name ?? model.id,
        contextWindow, configuredContextWindow: model.configured.contextWindow ?? null,
        capacityMaxTokens: capacityMaxTokens ?? null, capacitySource,
        defaultOutputTokens, policy, budget, budgetError,
        writable: settings.writable && family !== 'unknown' && model.path !== null && info !== undefined && policy !== null,
        writePath: model.path,
      };
    }));
    // Metadata queries may await. Never mix a changed selection/config/preset
    // with a snapshot captured before those queries.
    const latest = select(sessionId);
    const latestNamespace = ctx.settingsController.describe().namespaces.find(entry => entry.ns === namespace.ns);
    let latestConfig;
    try { latestConfig = policyConfig(latest.agent); } catch { latestConfig = undefined; }
    if (signature(latest.selected) !== signature(selected) || latest.agent !== agent
      || latestNamespace?.revision !== namespace.revision || signature(latestConfig) !== signature(config)) {
      throw new BudgetError('stale', '读取期间会话选择、模型配置或 preset 策略发生变化，请刷新后重试。');
    }
    signal?.throwIfAborted();
    return {
      view: {
        sessionId, selected, presetId, providerName: directory.displayName, family,
        settingsNs: namespace.ns, revision: namespace.revision, writable: settings.writable,
        policyError, models: rows,
      },
      namespace, profile, moduleName,
    };
  }

  function basis(snapshot, model) {
    return signature({
      selection: snapshot.view.selected, presetId: snapshot.view.presetId,
      namespace: snapshot.namespace.value, revision: snapshot.namespace.revision,
      moduleName: snapshot.moduleName, model,
    });
  }

  return {
    async read(sessionId, signal) { return (await read(sessionId, signal)).view; },
    async preview(sessionId, modelId, target, signal, { issueToken = true } = {}) {
      const snapshot = await read(sessionId, signal);
      const model = snapshot.view.models.find(row => row.id === modelId);
      if (!model?.writable) throw new BudgetError('readonly', model?.budgetError ?? '此模型没有已验证的官方单模型写入路径，不能保存。');
      const after = invertBudget(target, model.defaultOutputTokens, model.policy);
      if (after.contextWindow === model.contextWindow) throw new BudgetError('unchanged', '当前窗口已对应这个阈值，无需保存。');
      let token;
      if (issueToken) {
        for (const [key, preview] of previews) if (preview.sessionId === sessionId) previews.delete(key);
        token = randomUUID();
        previews.set(token, { sessionId, modelId, target, after, basis: basis(snapshot, model) });
      }
      return {
        ...(token === undefined ? {} : { token }), target, after, before: model.budget, modelId,
        currentWindow: model.contextWindow, policy: model.policy,
        settingsNs: snapshot.namespace.ns, writePath: model.writePath,
        revision: snapshot.namespace.revision, selected: snapshot.view.selected, view: snapshot.view,
      };
    },
    async save(sessionId, token, signal) {
      const preview = previews.get(token);
      if (!preview || preview.sessionId !== sessionId) throw new BudgetError('preview', '预览已失效，请重新预览并确认。');
      previews.delete(token);
      const snapshot = await read(sessionId, signal);
      const model = snapshot.view.models.find(row => row.id === preview.modelId);
      if (!model?.writable || basis(snapshot, model) !== preview.basis) {
        throw new BudgetError('stale', '预览后模型配置、会话选择或官方压缩策略已变化。未写入，请重新预览并确认。');
      }
      const after = invertBudget(preview.target, model.defaultOutputTokens, model.policy);
      if (after.contextWindow !== preview.after.contextWindow) throw new BudgetError('stale', '预算变更，请重新预览。');
      signal?.throwIfAborted();
      // The official path mutation preserves secrets, other models, fields,
      // configuration layers, and the profile's other plugin entries.
      await ctx.settingsController.mutate(snapshot.namespace.ns, [{
        op: 'set', path: model.writePath, value: after.contextWindow,
      }], snapshot.namespace.revision);
      try {
        const observed = await read(sessionId, signal);
        const actual = observed.view.models.find(row => row.id === preview.modelId);
        const stored = at(observed.namespace.value, model.writePath);
        if (stored !== after.contextWindow || actual?.contextWindow !== after.contextWindow) {
          throw new Error('官方配置回读或适配器生效窗口与预览不一致。');
        }
        return { confirmed: true, modelId: preview.modelId, contextWindow: stored, view: observed.view };
      } catch (error) {
        throw new BudgetError('readback', `写入已提交，但回读未能确认：${messageOf(error)} 请刷新核对；不会自动重试或回滚。`);
      }
    },
    dispose() { previews.clear(); },
  };
}

export function apply(ctx) {
  const controller = createBudgetController(ctx);
  ctx.effect(() => () => controller.dispose());
  // Exact Fetch routes coexist with the gateway's sole /api interceptor.
  // The official bridge authenticates requests; admit() also distinguishes
  // the GUI browser Peer from authenticated API Peers before confirmation.
  ctx.effect(() => ctx.connection.fetch.register({
    path: RPC_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const admission = ctx.connection.admit(request);
      if ('rejection' in admission) return new Response('unauthorized', { status: admission.rejection });
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 });
      let envelope;
      try { envelope = await request.json(); }
      catch { return new Response('body is not JSON', { status: 400 }); }
      if (!record(envelope) || typeof envelope.rpcId !== 'string' || !envelope.rpcId) {
        return new Response('invalid RPC envelope', { status: 400 });
      }
      const respond = result => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
      if (admission.peer !== ctx.connection.browserPeer) return respond({
        ok: false, error: { code: 'budget/forbidden', message: '此操作仅供当前 GUI 用户使用。', details: {} },
      });
      const payload = envelope.payload;
      const signal = request.signal;
      try {
        if (envelope.type !== 'client-request' || envelope.method !== ENDPOINT || !record(payload)
          || typeof payload.sessionId !== 'string' || !payload.sessionId) {
          throw new BudgetError('request', '无效 RPC 请求或缺少当前会话 ID。');
        }
        let value;
        if (payload.action === 'read') value = await controller.read(payload.sessionId, signal);
        else if (payload.action === 'preview' && typeof payload.modelId === 'string') {
          value = await controller.preview(payload.sessionId, payload.modelId, payload.target, signal);
        } else if (payload.action === 'save' && typeof payload.token === 'string') {
          value = await controller.save(payload.sessionId, payload.token, signal);
        } else throw new BudgetError('request', '无效的模型预算请求。');
        return respond({ ok: true, value });
      } catch (error) {
        return respond({ ok: false, error: { code: `budget/${error?.code ?? 'error'}`, message: messageOf(error), details: {} } });
      }
    },
  }));
  // Read/calculation operations share the UI controller, but never issue a
  // confirmation token or touch the GUI user's pending preview.
  ctx.effect(() => ctx.tools.register({
    name: 'model_context_budget',
    description: '只读查询当前会话供应商的模型上下文预算，或输入目标阈值反算窗口；不会保存配置，确认写回只能由 GUI 用户操作。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'preview'] },
        modelId: { type: 'string', description: '反算的目标模型 ID；preview 时必填。' },
        target: { type: 'integer', minimum: 1, description: '期望压缩阈值（tokens）；preview 时必填。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new BudgetError('session', '只读预算查询需要当前会话。');
      if (args.action === 'read') return controller.read(exec.agent.id, exec.signal);
      if (args.action === 'preview' && typeof args.modelId === 'string') {
        return controller.preview(exec.agent.id, args.modelId, args.target, exec.signal, { issueToken: false });
      }
      throw new BudgetError('readonly', '此工具只允许读取或反算；确认保存仅限 GUI 用户。');
    },
  }));
}

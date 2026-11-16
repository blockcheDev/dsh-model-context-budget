// Arithmetic contract: DSH 0.2.2-rc.2 compaction-basic/src/config.ts:153–217.
// Inputs come from the mounted preset's resolved policy, never local defaults.
export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function validatePolicy(policy) {
  if (!policy || !Number.isFinite(policy.thresholdRatio)
    || policy.thresholdRatio <= 0 || policy.thresholdRatio > 1) {
    throw new BudgetError('policy', '无法确定官方 thresholdRatio；必须处于 (0, 1]。');
  }
  if (!Number.isSafeInteger(policy.headroomTokens) || policy.headroomTokens < 0) {
    throw new BudgetError('policy', '无法确定官方 headroomTokens；必须是非负安全整数。');
  }
  if (policy.retainTokens !== undefined) {
    if (!Number.isSafeInteger(policy.retainTokens) || policy.retainTokens < 0) {
      throw new BudgetError('policy', '官方 retainTokens 无效。');
    }
  } else if (!Number.isFinite(policy.retainRatio) || policy.retainRatio <= 0
    || policy.retainRatio >= policy.thresholdRatio) {
    throw new BudgetError('policy', '无法确定有效的官方 retainRatio。');
  }
}

export function calculateBudget(contextWindow, outputTokens, policy) {
  validatePolicy(policy);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new BudgetError('window', 'contextWindow 必须是正安全整数。');
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new BudgetError('output', '模型默认请求输出预留无法确定，不能计算或保存。');
  }
  const messageBudgetTokens = contextWindow - outputTokens;
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
  if (messageBudgetTokens <= 0 || pressureBudgetTokens <= 0) {
    throw new BudgetError('budget', '窗口扣除请求输出预留 O 与压缩 headroom B 后没有有效压力预算。');
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;
  if (thresholdTokens <= 0 || retainTokens >= thresholdTokens) {
    throw new BudgetError('retention', '近期原文保留预算必须小于压缩阈值；本预算无效，不能保存。');
  }
  return { contextWindow, outputTokens, messageBudgetTokens, pressureBudgetTokens, thresholdTokens, retainTokens };
}

export function invertBudget(target, outputTokens, policy) {
  validatePolicy(policy);
  if (!Number.isSafeInteger(target) || target <= 0) {
    throw new BudgetError('target', '期望阈值 T 必须是正安全整数 token 数，不接受小数或单位缩写。');
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new BudgetError('output', '模型默认请求输出预留无法确定，不能计算或保存。');
  }
  const contextWindow = Math.ceil(Math.max(
    target / policy.thresholdRatio,
    target + outputTokens + policy.headroomTokens,
  ));
  if (!Number.isSafeInteger(contextWindow)) {
    throw new BudgetError('window', '反算窗口超出安全整数范围，不能保存。');
  }
  const budget = calculateBudget(contextWindow, outputTokens, policy);
  if (budget.thresholdTokens !== target) {
    throw new BudgetError('verification', '反算结果代回官方公式未得到期望阈值；不猜值保存。');
  }
  return budget;
}

export function routedPolicy(config, provider, model) {
  const overrides = config.modelPolicies.filter(entry => entry.provider === provider && entry.model === model);
  if (overrides.length > 1) throw new BudgetError('policy', '存在重复的官方模型压缩策略，计算口径不确定。');
  const override = overrides[0];
  const retention = override?.retainTokens !== undefined ? { retainTokens: override.retainTokens }
    : override?.retainRatio !== undefined ? { retainRatio: override.retainRatio }
      : config.retainTokens !== undefined ? { retainTokens: config.retainTokens } : { retainRatio: config.retainRatio };
  const policy = {
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...retention,
    auto: config.auto,
    exactOverride: override !== undefined,
  };
  validatePolicy(policy);
  return policy;
}

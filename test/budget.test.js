import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetError, calculateBudget, invertBudget, routedPolicy } from '../src/budget.js';

const defaults = { thresholdRatio: 0.8, headroomTokens: 65_536, retainRatio: 0.16 };

test('官方默认口径：260,000 阈值反算为 453,536 窗口，输出预留为 128,000', () => {
  const before = calculateBudget(1_000_000, 128_000, defaults);
  assert.equal(before.thresholdTokens, 800_000);
  assert.equal(before.retainTokens, 139_520);
  const after = invertBudget(260_000, 128_000, defaults);
  assert.equal(after.contextWindow, 453_536);
  assert.equal(after.thresholdTokens, 260_000);
  assert.equal(after.retainTokens, 52_085);
});

test('容量预留分支与比例分支均需满足：无声明输出预留仍扣除 headroom', () => {
  assert.equal(invertBudget(260_000, 0, defaults).contextWindow, 325_536);
  const proportional = invertBudget(260_001, 0, { ...defaults, headroomTokens: 0 });
  assert.equal(proportional.contextWindow, 325_002);
  assert.equal(proportional.thresholdTokens, 260_001);
  assert.equal(calculateBudget(325_001, 0, { ...defaults, headroomTokens: 0 }).thresholdTokens, 260_000);
});

test('精确 provider/model 覆盖可切换保留形式，不改原始官方策略', () => {
  const config = {
    thresholdRatio: 0.8, headroomTokens: 65_536, retainTokens: 20_000, auto: false,
    modelPolicies: [{ provider: 'gateway', model: 'small', thresholdRatio: 0.7, headroomTokens: 4096, retainRatio: 0.1 }],
  };
  const original = structuredClone(config);
  const policy = routedPolicy(config, 'gateway', 'small');
  assert.equal(policy.retainTokens, undefined);
  assert.equal(policy.retainRatio, 0.1);
  assert.equal(policy.auto, false);
  assert.equal(invertBudget(10_000, 4096, policy).contextWindow, 18_192);
  assert.equal(routedPolicy(config, 'another', 'small').retainTokens, 20_000);
  assert.deepEqual(config, original);
});

test('预算耗尽、保留量超过阈值、非整数和不安全反算结果不能保存', () => {
  const fails = (operation, code) => assert.throws(operation, error => error instanceof BudgetError && error.code === code);
  fails(() => calculateBudget(193_536, 128_000, defaults), 'budget');
  fails(() => invertBudget(40_000, 0, { thresholdRatio: 0.8, headroomTokens: 65_536, retainTokens: 50_000 }), 'retention');
  fails(() => invertBudget(260_000.5, 0, defaults), 'target');
  fails(() => invertBudget(Number.MAX_SAFE_INTEGER, 128_000, defaults), 'window');
});

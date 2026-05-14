const assert = require('assert');

function calcScore({ success, score, rewardScore, actual, target }) {
  if (!success) return 10;
  return Math.round(Number(score || 0) + (actual - target) * Number(rewardScore || 0) + 10);
}

function accuracyText(correct, attempts) {
  return attempts > 0 ? `${Math.round((correct / attempts) * 1000) / 10}%` : '—';
}

function progressSequence(startLevel, failures) {
  let currentLevel = startLevel;
  let failureStreak = 0;
  let failureBaseLevel = null;
  const out = [];
  for (let i = 0; i < failures; i += 1) {
    const beforeLevel = currentLevel;
    failureStreak += 1;
    if (failureStreak === 1 || failureBaseLevel === null) failureBaseLevel = beforeLevel;
    if (failureStreak === 1) currentLevel = Math.max(1, failureBaseLevel);
    else if (failureStreak === 2) currentLevel = Math.max(1, failureBaseLevel - 1);
    else {
      currentLevel = Math.max(1, failureBaseLevel - 3);
      failureStreak = 0;
      failureBaseLevel = null;
    }
    out.push(currentLevel);
  }
  return out;
}

assert.strictEqual(calcScore({ success: false, score: 100, rewardScore: 10, actual: 0, target: 1 }), 10, '失败只得 10 分');
assert.strictEqual(calcScore({ success: true, score: 100, rewardScore: 10, actual: 1, target: 1 }), 110, '成功达标得 Score + 10');
assert.strictEqual(calcScore({ success: true, score: 100, rewardScore: 10, actual: 3, target: 1 }), 130, '成功超额得奖励分');
assert.deepStrictEqual(progressSequence(10, 3), [10, 9, 7], '失败段降级：原级、基准-1、基准-3');
assert.deepStrictEqual(progressSequence(2, 3), [2, 1, 1], '降级下限为 1');
assert.strictEqual(accuracyText(7, 10), '70%', '准确率整数百分比');
assert.strictEqual(accuracyText(2, 3), '66.7%', '准确率保留一位小数');
assert.strictEqual(accuracyText(0, 0), '—', '未作答准确率显示为空');
console.log('LOGIC UNIT TESTS PASSED');

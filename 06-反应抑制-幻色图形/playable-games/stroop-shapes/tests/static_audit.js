const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const failures = [];
const pass = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
  else pass.push(message);
}

const sandbox = { window: {} };
vm.runInNewContext(read('js/config.js'), sandbox, { filename: 'config.js' });
const cfg = sandbox.window.GAME_CONFIG;
const html = read('index.html');
const game = read('js/game.js');
const css = read('css/style.css');
const manifest = JSON.parse(read('assets/manifest.json'));

assert(cfg.title === '幻色图形', '标题为“幻色图形”');
assert(cfg.version === '1.2.0', '配置版本为 1.2.0');
assert(cfg.maxLevel === 100, '最高等级为 100');
assert(Array.isArray(cfg.levels) && cfg.levels.length === 100, '关卡配置为 100 关');
assert(cfg.levels.every((row, idx) => row.Level === idx + 1), '关卡 Level 连续为 1-100');
assert(cfg.colors.length === 9, '颜色库为 9 色');
assert(cfg.shapes.length === 3, '图形库为 3 类');
assert(cfg.difficultyStarts.easy.startLevel === 1, '容易从第 1 关开始');
assert(cfg.difficultyStarts.normal.startLevel === 15, '普通从第 15 关开始');
assert(cfg.difficultyStarts.hard.startLevel === 30, '困难从第 30 关开始');
assert(cfg.subLevelEndRules.consecutiveWrongLimit === 2, '全局连续选错阈值为 2');
assert(cfg.levels.every((row) => Number(row.Fault) === 2), '修订后每关 Fault 为 2');
assert(cfg.levels.every((row) => Number(row.MissionPass) > 0 && Number(row.Time) >= 15), '每关有正向小关目标且小关时间已拉长');

for (const shape of cfg.shapes) {
  for (const color of cfg.colors) {
    assert(exists(`assets/shapes/${shape.id}_${color.key}.svg`), `素材存在：${shape.id}_${color.key}.svg`);
  }
}
for (const id of ['guideStepText','guideProgressBar','guideTitle','guideBody','guideBullets','guideDecision','guidePrev','guideNext','hudTarget','trainingProgress','subProgress','wrongStatus','targetStatus','passRibbon']) {
  assert(html.includes(`id="${id}"`), `HTML 包含 #${id}`);
}
assert(html.includes('新手教程'), 'HTML 包含详细新手教程标题');
assert(html.includes('图形颜色') && html.includes('文字含义'), 'HTML 包含刺激卡片语义标签');
assert(html.includes('← / X') && html.includes('→ / Enter'), 'HTML 包含快捷键视觉提示');
assert(game.includes('function targetFor') && game.includes('cfg.MissionPass'), '目标计算优先读取 MissionPass');
assert(game.includes('function wrongLimitFor') && game.includes('cfg.Fault'), '连错阈值优先读取关卡 Fault');
assert(game.includes('failureBaseLevel'), '连续失败降级使用失败段起点');
assert(game.includes('escapeHtml'), '弹窗 HTML 输出经过转义');
assert(game.includes('openGuideFromPause') && game.includes('resumeFromGuide'), '暂停帮助教程可返回训练');
assert(game.includes('totalAttempts') && game.includes('accuracyText'), '记录总作答与准确率');
assert(game.includes('pendingTransition') && game.includes('visibilitychange'), '处理暂停时的答题过渡和页面切换自动暂停');
assert(game.includes('Score') && game.includes('Scores') && game.includes('+ 10'), '成功积分公式使用 Score、Scores 和基础 10 分');
assert(css.includes('.tutorial-layout') && css.includes('.progress-fill'), 'CSS 包含教程布局和进度条样式');
assert(css.includes('.status-strip') && css.includes('.linear-progress') && css.includes('.card-label'), 'CSS 包含状态条、进度条和卡片标签样式');
assert(css.includes('prefers-reduced-motion'), 'CSS 包含低动态偏好处理');

const assetRefs = new Set();
for (const content of [html, game, css, JSON.stringify(manifest)]) {
  for (const m of content.matchAll(/assets\/[A-Za-z0-9_./\-]+\.(?:svg|wav|png|jpg|jpeg|webp)/g)) {
    assetRefs.add(m[0]);
  }
}
for (const ref of assetRefs) assert(exists(ref), `引用素材存在：${ref}`);

if (failures.length) {
  console.error('STATIC AUDIT FAILED');
  failures.forEach((x) => console.error(' - ' + x));
  process.exit(1);
}
console.log(`STATIC AUDIT PASSED: ${pass.length} checks`);

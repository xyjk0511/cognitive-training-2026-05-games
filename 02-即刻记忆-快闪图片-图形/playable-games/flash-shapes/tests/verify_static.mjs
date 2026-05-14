import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const sandbox = { window: {} };
const dataCode = fs.readFileSync(path.join(root, 'shared', 'data.js'), 'utf8');
vm.runInNewContext(dataCode, sandbox, { filename: 'data.js' });
const data = sandbox.window.KX_DATA;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(data.versions.child.levels.length === 50, '儿童版关卡数不是 50');
assert(data.versions.adult.levels.length === 50, '成人版关卡数不是 50');
assert(data.shapes.length === 100, '图形表不是 100 条');

const presets = data.meta?.difficultyPresets || [];
assert(presets.length === 3, '难度档位不是 3 个');
assert(JSON.stringify(presets.map((p) => p.label)) === JSON.stringify(['容易', '普通', '困难']), '难度名称不是 容易/普通/困难');
assert(JSON.stringify(presets.map((p) => Number(p.startLevel))) === JSON.stringify([1, 15, 30]), '难度起始关卡不是 1/15/30');

for (const version of ['child', 'adult']) {
  for (const level of data.versions[version].levels) {
    assert(Number(level.TargetCount) > 0, `${version} L${level.Level} 缺 TargetCount`);
    assert(Array.isArray(level.ShapeRange) && level.ShapeRange.length === 2, `${version} L${level.Level} 缺 ShapeRange`);
    const [min, max] = level.ShapeRange.map(Number);
    assert(min >= 1 && max <= 100 && min < max, `${version} L${level.Level} ShapeRange 非法`);
  }
}

for (const shape of data.shapes) {
  const svg = path.join(root, 'assets', 'icons', `${shape.Icon}.svg`);
  const png = path.join(root, 'assets', 'icons_png', `${shape.Icon}.png`);
  assert(fs.existsSync(svg), `缺少 ${svg}`);
  assert(fs.existsSync(png), `缺少 ${png}`);
}

function adjustDifficultySequence(startLevel, outcomes) {
  let level = startLevel;
  let failStreak = 0;
  let base = null;
  const steps = [];
  for (const pass of outcomes) {
    const old = level;
    if (pass) {
      failStreak = 0;
      base = null;
      level = Math.min(50, level + 1);
    } else {
      if (failStreak === 0) base = level;
      failStreak += 1;
      if (failStreak === 1) level = old;
      else if (failStreak === 2) level = Math.max(1, base - 1);
      else {
        level = Math.max(1, base - 3);
        failStreak = 0;
        base = null;
      }
    }
    steps.push(level);
  }
  return steps;
}

assert(JSON.stringify(adjustDifficultySequence(10, [false, false, false])) === JSON.stringify([10, 9, 7]), '连续三次失败降级规则异常');
assert(JSON.stringify(adjustDifficultySequence(1, [false, false, false])) === JSON.stringify([1, 1, 1]), '等级下限规则异常');
assert(JSON.stringify(adjustDifficultySequence(50, [true])) === JSON.stringify([50]), '等级上限规则异常');


const gameCode = fs.readFileSync(path.join(root, 'shared', 'game.js'), 'utf8');
assert(gameCode.includes('pauseQuestionDelay'), '缺少暂停期间问题延迟保护');
assert(gameCode.includes('preloadCriticalAssets'), '缺少关键素材预加载');
assert(gameCode.includes('attachCardFallback'), '缺少图形素材失败回退');
assert(gameCode.includes('POST_MESSAGE_TARGET_ORIGIN'), '缺少 postMessage 目标域配置');
assert(gameCode.includes('selectDifficulty'), '缺少三档难度选择逻辑');
assert(gameCode.includes('difficultyStartLevel'), '缺少难度起始关卡传参与状态');
assert(gameCode.includes('guideAnswerLocked'), '缺少引导阶段防连点锁');

function collectStaticRefs(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const refs = [];
  const attr = /(?:src|href)=["']([^"']+)["']/g;
  const cssUrl = /url\(["']?([^"')]+)["']?\)/g;
  for (const re of [attr, cssUrl]) {
    let m;
    while ((m = re.exec(txt))) {
      const ref = m[1];
      if (/^(https?:|data:|#|javascript:)/.test(ref)) continue;
      if (ref.endsWith('.html')) continue;
      refs.push(ref);
    }
  }
  return refs;
}

for (const rel of ['儿童版/index.html', '成人版/index.html']) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  assert(html.includes('id="difficultyPicker"'), `${rel} 缺少三档难度选择区`);
  for (const text of ['容易', '普通', '困难', '从第1关开始', '从第15关开始', '从第30关开始']) {
    assert(html.includes(text), `${rel} 缺少难度文案：${text}`);
  }
}

for (const rel of ['index.html', '儿童版/index.html', '成人版/index.html', '素材预览.html', 'shared/style.css']) {
  const filePath = path.join(root, rel);
  const base = path.dirname(filePath);
  for (const ref of collectStaticRefs(filePath)) {
    const resolved = path.resolve(base, ref);
    assert(fs.existsSync(resolved), `静态引用缺失：${rel} -> ${ref}`);
  }
}

console.log('verify_static: OK');

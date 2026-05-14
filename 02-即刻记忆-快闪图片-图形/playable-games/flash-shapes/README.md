# 快闪图形·三档难度版游戏包

## 入口

- `index.html`：版本选择。
- `儿童版/index.html`：儿童版。
- `成人版/index.html`：成人版。
- `素材预览.html`：所有素材预览。

## 核心规则

三档难度版按配置表运行 50 级关卡：进入训练前先选择三档难度，容易从第 1 关开始，普通从第 15 关开始，困难从第 30 关开始；进入训练后继续执行 N/M 通关目标、连续选错两次结束小关、倒计时为 0 结束小关、通关 +1、连续失败第 1 次不降、第 2 次 -1、第 3 次 -3 并清空、未通关固定 10 分、通关按公式加分。

训练不会停在单小关结算页等待手动点击；只要总训练时间未到 0，就自动继续下一小关。总训练时间为 0 后结束训练，并通过接口传出通关标识。

## 训练结束传参

见 `docs/接口说明.md`。支持：

- `window.KX_onTrainingEnd(payload)`
- `window.dispatchEvent(new CustomEvent("KX_TRAINING_END", { detail: payload }))`
- `window.parent.postMessage({ type: "KX_TRAINING_END", payload }, "*")`
- `localStorage.KX_LAST_TRAINING_RESULT`

## 启动传参

可用 URL 参数模拟平台下发：

```text
儿童版/index.html?trainingSeconds=300&difficulty=easy
儿童版/index.html?trainingSeconds=300&difficulty=normal
成人版/index.html?seconds=300&difficulty=hard
```

## 素材内容

- 图形素材：`assets/shapes/shape_001.svg` 至 `shape_100.svg`，以及 `assets/shapes_png/`。
- Icon 素材：`assets/icons/Icon1.svg` 至 `Icon100.svg`，以及 `assets/icons_png/`。游戏卡牌优先按图形表 `Icon` 字段加载这里的文件。
- UI 素材：`assets/ui/`。
- 角色素材：`assets/mascot/`，包括小康康 idle、wave、happy、blink、think、sad 等状态。
- 音频素材：`assets/audio/`。
- 素材清单：`assets/ASSET_MANIFEST.json`。
- 图形总览：`assets/atlas/shape_contact_sheet.png`。

## 配置替换

`shared/data.js` 中：

- `versions.child.levels`：儿童版关卡表。
- `versions.adult.levels`：成人版关卡表。
- `shapes`：图形表。
- `shapeRanges`：按 Type 的默认图形范围。

每关优先读取 `TargetCount` 和 `ShapeRange`。如果旧表没有这些字段，运行时会回退到 `ceil(Scores / Score)` 与 `Type -> shapeRanges`。

## 静态校验

可在包根目录运行：

```bash
node tests/verify_static.mjs
```

该脚本检查：儿童/成人 50 关、100 图形、Icon 文件完整、三档难度为容易/普通/困难且起始关卡为 1/15/30、每关 `TargetCount` 与 `ShapeRange` 完整、连续失败三次降级规则、等级上下限。

另可运行：

```bash
node tests/play_simulate.mjs
```

该脚本会模拟选择三档难度、从 1/15/30 关进入训练、新手引导防连点、正确作答、连续错两次失败、暂停/恢复和训练结束传参。

## 打磨版新增

相对上一版，本包新增：三档难度选择、关键图片与音效预加载、暂停时保留下一题剩余等待时间、图形素材加载失败时内联 SVG 兜底、`postMessageTargetOrigin` 目标域配置、按钮焦点状态、低高度屏幕适配、减少动画偏好适配，以及更完整的静态资源与自玩模拟回归检查。

详见 `docs/自查与打磨报告.md`。

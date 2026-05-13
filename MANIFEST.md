# cognitive-training-2026-05 游戏实现归档

本目录按 `cognitive-training-2026-05` 设计素材为准，归档并修复 11 个可运行训练游戏。当前选用合同见 `tools/source-contracts.json`，统一验收命令：

```powershell
node .\tools\verify-design-parity.mjs
$env:NODE_PATH='C:\Users\55093\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; node .\tools\smoke-games.mjs
```

## 对应关系

| 归档目录 | 可运行入口 | 选定设计合同 | 当前状态 |
| --- | --- | --- | --- |
| `01-反应速度-眼疾手快` | `playable-games/eye-quick/index.html` | `01 感知觉/01 反应速度-眼疾手快/data.json` + `P2眼疾手快.xlsm` | 正式入口直接调用 `eyeQuickSource.js`；`P2眼疾手快.xlsm` 已按 `data.json` 统一为 51 关；preview demo 记录为 rejected source |
| `02-即刻记忆-快闪图片-图形` | `playable-games/flash-shapes/index.html` | `02 记忆力/01 即刻记忆-快闪图片-图形/data.json` + `P2快闪图形.xlsm` | `P2快闪图形.xlsm` 已按 `data.json` 清到 50 关，任务为一回溯相同/不同 |
| `03-位置记忆-强力记忆` | `playable-games/strong-memory/index.html` | `02 记忆力/02 位置记忆-强力记忆/data.json` | 保留 60 级/800 floor 数据，补 shared 资源和 WebAudio 音效提示 |
| `04-记忆广度-数字阶梯-reference` | `playable-games/number-ladder/index.html` | `02 记忆力/03 记忆广度-数字阶梯/P1数字阶梯数值.xlsm` + `数字阶梯策划文档.xlsx` | 已替换原相近参考为 100 级数字气泡升序点击任务，计分按剩余时间比例 |
| `05-分配注意-包裹出库` | `external-games/parcel-shipping/index.html` | `03  注意力/01 分配注意-包裹出库/LevelConfig.json` + `MapConfig.json` + `包裹出库策划案.docx` | 选用 JSON 为最新运行合同，升降级和计分按策划案补强规则测试 |
| `06-反应抑制-幻色图形` | `playable-games/stroop-shapes/index.html` | `04 执行能力/01 反应抑制-幻色图形/data.json` + `P2幻色图形.xlsm` + `逻辑修改内容.docx` | `P2幻色图形.xlsm` 已按 `data.json` 统一 Floor/Level/Mis，任务为 Stroop 一致/不一致 |
| `07-表象计算-扑克求和` | `external-games/poker-sum/index.html` | `04 执行能力/02 表象计算-求和类/扑克求和/P1扑克求和数值.xlsm` | 生成源数据 JSON，保留修订版求和逻辑并加计分/升降级测试 |
| `08-表象计算-骰子求和` | `external-games/dice-sum/index.html` | `04 执行能力/02 表象计算-求和类/骰子求和/P1骰子求和数值.xlsm` | 生成源数据 JSON，修正旧时间比例计分和连续失败降级 |
| `09-识别归纳-分门别类` | `external-games/category-sort/index.html` | `05 社会认知/识别归纳-分门别类/数值.xlsx` + `关卡配置.xlsx` | 替换调试入口，接入源引导图，移除 emoji/debug fallback |
| `10-观察水平-影子配对` | `external-games/shadow-pairing/index.html` | `01 感知觉/02 观察水平-影子配对/数值.xlsx` + `影子配对策划案.xlsx` | 新增单文件实现，100 级 Level 和 32 组 shadow 配置与源表一致 |
| `11-位置记忆-翻个西瓜` | `external-games/watermelon-flip/index.html` | `02 记忆力/04 位置记忆-翻个西瓜/P2翻个西瓜 - 改.xlsm` + `逻辑修改内容.docx` | 新增单文件实现，60 级 Level 和 800 条 Floor 配置与源表一致 |

## 已接受差异

- `07` 源包没有独立扑克牌图片集，当前使用 CSS/卡牌渲染。
- `08` 源包没有独立骰子面图片集，当前使用 CSS 骰面渲染。
- `09` 源包只有引导图，没有物品图片 atlas，当前用文字物品卡替代旧 emoji fallback。
- `10` 当前用内联 SVG 渲染机器人和影子，没有接入 Axure/线框图中的正式切图资源。
- `11` 当前用 CSS/emoji 渲染西瓜和干扰物，没有接入 Axure/线框图中的正式切图资源。

## 仍未找到对应完整实现

以下源素材条目不在本次 11 个归档游戏范围内：
- `03  注意力/02 注意广度-静默池塘`
- `03  注意力/03 持续注意-钓鱼达人`

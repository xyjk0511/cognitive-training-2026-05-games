# 设计对齐报告

变更线：`fix-cognitive-training-game-design-drift`

## 修复摘要

| 游戏 | 原问题 | 修复合同 |
| --- | --- | --- |
| 01 眼疾手快 | 合同入口指向 `preview/silky-hamster-demo.html`，且该页自称不是正式规则实现；表格与 `data.json` 有冲突 | 改用 `playable-games/eye-quick/index.html` 正式入口；`P2眼疾手快.xlsm` 已按 `data.json` 回写为 51 关 |
| 02 快闪图片-图形 | 实现是“记 8 张后四选一”，设计是 1-back 相同/不同；`P2快闪图形.xlsm` 与 `data.json` 首关参数冲突 | 新建 `playable-games/flash-shapes`；`P2快闪图形.xlsm` 已按 `data.json` 回写为 50 关 |
| 03 强力记忆 | shared 资源缺失，音效按钮无实际音频 | 补 `shared/unified.*`，加入 WebAudio 正误/结果提示 |
| 04 数字阶梯 | 原目录只是 number-sequence 参考，且计分未按策划案剩余时间比例 | 从 `P1数字阶梯数值.xlsm` 生成 100 关数据；计分按 `Score + Scores * 剩余时间 / 关卡时间` 四舍五入 |
| 05 包裹出库 | 规则测试模块仍是通过一次 +3、失败一次降级、计分不按正确包裹数 | 选 `LevelConfig.json`/`MapConfig.json` 和策划案为合同；计分为正确数 * 单包积分 + 准确率奖励；连续通关 2 次才 +3，失败 1/2/3 次分别 0/-3/-5 |
| 06 幻色图形 | 实现是 floor-number 预览；规则模块缺三次失败降 3 级和超目标奖励分；`P2幻色图形.xlsm` 与 `data.json` Level 参数冲突 | 新建 `playable-games/stroop-shapes`；`P2幻色图形.xlsm` 已按 `data.json` 回写 Floor/Level/Mis；计分按 `Score + (实际数-目标数)*Scores + 10`，失败 1/2/3 次分别 0/-1/-3 |
| 07 扑克求和 | 缺源数据校验和规则证明 | 从 `P1扑克求和数值.xlsm` 生成 JSON，补求和规则测试 |
| 08 骰子求和 | 旧逻辑按剩余时间比例给分，失败不按连续失败降级 | 修正页面计分和连续失败降级，补规则模块 |
| 09 分门别类 | 暴露测试关卡入口、emoji fallback，源引导图未接入 | 替换为源数据驱动入口，接入 3 张引导图 |

## 验证

- `node .\tools\verify-design-parity.mjs`
- `$env:NODE_PATH='C:\Users\55093\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; node .\tools\smoke-games.mjs`

两条命令均已通过。浏览器 smoke 打开 9 个归档入口并点击首个可交互按钮，未发现 404、console error 或 page error。规则测试已补强到覆盖 01 正式入口、04 剩余时间比例计分、05 连续通关/失败阶梯、06 三次失败降 3 级和额外奖励分，避免只证明 `source-contracts.json` 的窄合同。

`tools/verify-design-parity.mjs` 还会调用 `tools/verify-source-workbook-parity.py`，检查 01/02/06 的 P2 工作簿已与对应 `data.json` 完全一致。

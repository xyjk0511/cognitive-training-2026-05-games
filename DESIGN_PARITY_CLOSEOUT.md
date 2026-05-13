# 设计对齐 Closeout

完成时间：2026-05-13

## 验收证据

- 规则/数据/资源：`node .\tools\verify-design-parity.mjs`，9 项测试全部通过。
- 浏览器 smoke：`$env:NODE_PATH='C:\Users\55093\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; node .\tools\smoke-games.mjs`，9 个入口全部 `browser-ok`。
- OpenSpec change：`fix-cognitive-training-game-design-drift`。

## 每游戏结论

- `01`：`data.json` 与实现数据字节一致；正式入口改为 `playable-games/eye-quick/index.html`，不再以 preview demo 作为合同入口；`P2眼疾手快.xlsm` 已按 `data.json` 统一为 51 关。
- `02`：已按 1-back 相同/不同玩法重建，首刺激不计分，50 关配置校验通过；`P2快闪图形.xlsm` 已按 `data.json` 清理为 50 关。
- `03`：60 级/800 floor 合同保持；补 shared 资源和音频提示。
- `04`：已按数字气泡升序点击重建，100 关/200 floor/100 symbol 校验通过；计分按策划案 `Score + Scores * 剩余时间 / 关卡时间`。
- `05`：以源 JSON 和策划案为准，路由、正确数计分、准确率奖励、连续 2 次通关升 3 级、失败 1/2/3 次阶梯降级规则测试通过。
- `06`：已按 Stroop 一致/不一致重建，100 关配置校验通过；补齐超目标奖励分和失败 1/2/3 次 0/-1/-3 的降级规则；`P2幻色图形.xlsm` 已按 `data.json` 统一 Floor/Level/Mis。
- `07`：源工作簿生成数据，求和判定、计分和升降级测试通过；无源卡牌图片集，使用 CSS 渲染。
- `08`：修正旧时间比例得分和连续失败降级；无源骰面图片集，使用 CSS 渲染。
- `09`：替换调试页，接入源引导图，移除 emoji/debug fallback；无源物品图片 atlas，使用文字卡。

# 《信号反应站》W3 需求追踪与加固记录

## 冻结依据

- 公共运行契约：`A620-TRC-1.1`，本施工线未修改公共 wire、共享 `game-plugin.ts` 或 Android 平台代码。
- 游戏需求：`02-信号反应站-游戏需求规格-v1.2.1.docx`，SHA-256 `c9823a24ee41d536a1401a0c233d7ed8be81e4fb7076716fafed09df3f6ac898`。
- 公共规则：`00-A620认知训练游戏任务流与共用规则-v1.3.docx`，SHA-256 `c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794`。
- 代表级：L1、L7、L67、L79、L90、L96。完整 96 级仍为 `HOLD`。

## 需求到实现证据

| 需求锚点 | 冻结语义 | 实现位置 | 自动证据 |
|---|---|---|---|
| T09/T10/T11 | 300 秒、8×37.5 秒、8 波、A/C/H、半开输入窗口 | `constants.ts`、`logical-clock.ts`、`signal-instance.ts` | A/C/H 起点、end−1、end；单次跳到截止；暂停恢复 |
| T12 | 普通目标、干扰、WaitSecond、命中/误触/超时锁定 | `signal-instance.ts`、`batch-runtime.ts` | 普通点击去重、F 去重、×2 首击/同实例二击/第三击/超时 |
| T13/T14 | 四属性、方向≤4、相似度0–3、颜色不得成为唯一差异 | `symbols.ts`、`wave-generator.ts` | 12,288 计划常规压力测试；24,576 计划对抗式复测 |
| T15/T16/T18 | 四种波模板、目标/干扰总量、每波上限、×2 固定波次 | `constants.ts`、`vertical-slices.ts`、`wave-generator.ts` | 逐波 T/D、对象≤5、目标≤3、干扰≤2、×2≤1 |
| T19/T20/T21 | 四种三态门槛、D=0、整数 RoundHalfUp、0–100 | `scoring.ts` | 升区/持区/失败边界、需求样例分数、安全整数阈值 |
| T22/T23 | UP/HOLD/RETRY/DOWN/HOLD_MAX/HOLD_MIN 与会话等级字段 | `scoring.ts`、`session.ts` | L1 下限、L96 上限、连续失败、最高呈现/通过等级 |
| T25 | 暂停、DEADLINE、TERMINATE、无正式终止成绩 | `logical-clock.ts`、`session.ts`、`training-game-module.ts` | 准备期/运行后/截止后终止；终止后禁结果和待发送批次草稿 |
| T26/T27 | 正式 game config、batch/session/partial Schema | `games/signal-station/schemas/`、`verify_schema_assets.py` | JSON Schema、语义二次校验、负例、公共 PREPARE 校验 |
| T29/T31 | 六个代表级和 L90 锚点 | `vertical-slices.ts`、golden vectors | 六级固定 seed；L90 3×4、20/10、双目标10:10、4×2 |
| 公共结果 | BATCH_CLOSED 与 RESULT_READY 内容/哈希一致 | `batch-runtime.ts`、`session.ts` | canonical SHA-256 自洽、结果数组及嵌套证据冻结 |

## 第二轮对抗式加固结论

1. 修复代表级迁移到未施工相邻等级时的自动开批异常。现在记录 `LEVEL_NOT_IMPLEMENTED`，保留真实 `sessionEndLevel`，不崩溃、不套用最近代表级。
2. 修复双目标模式下的全局颜色唯一差异缺口。首轮提交在固定 512 seed × 6 级 × 8 批的 24,576 个计划中复现 906 次；修复后同一语料为 0。
3. 修复一次 source uptime 大步推进跨越多个批次时的历史时间开批错误。现在按每个 37,500 ms 边界依次闭合和开批。
4. 补齐公共生命周期中的准备期终止、正常截止后待提交终止，以及终止后禁止继续排出未发送 `BATCH_CLOSED` 草稿。
5. 修复内容修订号与公共 Schema 身份混淆。生成器/内容/包使用 `r2`，四份 Schema `$id` 继续保持公共冻结的 `1.2.1`，并由 baseline.8 公共 `validate_game_config` 端到端验证。
6. 将 `RoundHalfUp` 改为无 `remainder*2` 的安全整数比较，避免接近 `Number.MAX_SAFE_INTEGER` 时越界。
7. 正式结果、批次数组、批次指标、partial audit 和 session metrics 均使用脱离内部状态的冻结副本，防止调用方改写已哈希证据。

## 明确未覆盖

- 完整 96 级连续配置未导入，状态仍为 `HOLD`。
- Cocos 场景、生产美术、动画、音频和真实 64dp 热区未实现。
- Android 接线、设备性能、真实触控、多指硬件事件顺序、患者与临床环境未验证。
- Schema 的空对象分支只为 baseline.8 继承测试向量保留；正式游戏适配器拒绝空配置。

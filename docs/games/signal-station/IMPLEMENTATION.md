# 《信号反应站》W3 实现说明

## 判定源

所有正式判定只读取外部注入的 active time。`DeterministicActiveClock` 不读取操作系统时间；暂停期间 active time 不增长。信号实例在 `[enterStartActiveMs, naturalExitEndActiveMs)` 内可点击，正好位于自然结束时刻的输入无效。×2 的第二击窗口同样采用半开边界。

生成器使用 `generatorVersion + sessionSeed + level + batchOrdinal + waveOrdinal + scope` 派生确定性子流。`scope` 仅用于把目标卡、布局和波内容分流；同一正式键始终生成相同结果。布局选择显式限制每波对象数、目标数、干扰数、×2 数、格位复用和全批象限平衡，约束无法满足时抛出错误。双目标等级中的每个干扰项必须相对两张目标卡都存在至少一个非颜色差异，不能只对其参考目标满足该规则。

冻结运行配置在装载时执行严格结构校验：对象只允许预期字段；时序、代表级参数、×2 波次、目标类别拆分和 SHA-256 均须与冻结值一致。不能识别的评分模板、时序配置或额外字段均 fail closed，不通过宽松默认值继续运行。

## 计分隔离

批次结果仅由 H、T、F、D 和冻结阈值决定。反应时间、二击间隔、暂停次数及暂停时长均为审计字段。测试以相同 seed 和相同 H/F、不同反应延迟运行两次，要求 `batchScore`、`resultZone` 和 `levelTransition` 完全相同，同时反应时间审计值不同。

输入事件 ID 在整个会话内幂等，不只在单批内幂等；跨批重放不能重复计分。批次起点不得回退到已经推进过的逻辑 active time。截止之后到达的输入不会改变结果；即使先收到一个晚于截止的无效输入，随后使用平台提供的有效截止时间仍可完成确定性结算。

## 六级垂直切片边界

当前只冻结并实现 L1、L7、L67、L79、L90、L96。若批次迁移结果指向未施工的相邻等级，适配器不会抛出未捕获异常，也不会把最近的代表级冒充为该等级。它会停止自动开启下一批，记录 `LEVEL_NOT_IMPLEMENTED` 覆盖阻断，并在结果草稿中保留真实的 `sessionEndLevel` / `nextStartLevel`，同时报告最高实际呈现等级。

覆盖阻断通过游戏本地审计字段表达：

- `verticalSliceCoverageBlocked`
- `verticalSliceCoverageBlockReason`
- `verticalSliceBlockedLevel`
- `verticalSliceBlockedAfterBatchOrdinal`

这些字段属于游戏专属 `game_metrics`，不要求修改 A620-TRC-1.1 公共 SPI。

## 结果与公共边界

游戏本地适配器实现现有 `A620TrainingGameModule`，不修改共享 `typescript/src/game-plugin.ts`。正常截止可输出 0、1、7 或 8 个 eligible batch；最多一条未闭合批次审计。批次哈希使用公共 canonical JSON 算法。游戏草稿不生成 Android 派生质量标志。

适配器只接受与冻结六级配置 canonical hash 完全一致的 `gameConfig`。继承的 baseline.8 公共协议向量仍携带空对象，因此 `game_config`、`partial_metrics` 和 `game_metrics` Schema 各保留一个仅用于继承向量的空对象兼容分支；实际游戏适配器拒绝该空配置。`game_batch_metrics` 不保留空对象分支。

第二轮生成规则修订后，生成器、内容包和训练包身份分别升级为 `signal-station-gen-1.2.1-r2`、`signal-station-six-slice-1.2.1-r2` 和 `1.2.1-r2`。四份 Schema 的 `$id` 刻意保持冻结公共身份 `...:1.2.1`，因为 baseline.8 的公共 PREPARE 校验器按该身份放行；不能把内容修订号混入公共 Schema ID。资产验证器会把训练包声明的配置 Schema 交给冻结公共校验器做端到端兼容检查。

Schema 除 JSON 类型和必填字段外，还校验跨字段不变量，包括 `H≤T`、`F≤D`、×2 完成/超时守恒、反应时间计数不小于命中数且不超过已呈现目标数、partial presented/count 上界、批次/波次数量守恒，以及覆盖阻断四字段的一致性。资产验证器在 Schema 之外再次执行语义核对，避免只靠结构校验产生假绿。

结果证据在离开领域模型前会复制并冻结：闭合批次草稿、eligible batch 数组及元素、未闭合批次审计数组及元素、`gameMetrics` 和 `implementedLevels` 均不共享可变引用。调用方尝试改写数组或对象会失败，也不会反向改变会话中的正式证据。

TERMINATE 按公共生命周期覆盖 READY/START_SCHEDULED、运行中、暂停中、正常截止后待提交等阶段。终止一旦成立，之后不得再产生正式结果草稿，也不得排出尚未发送的 BATCH_CLOSED 草稿；重复终止同样被拒绝。正常截止仍只由注入的 cutoff active time 结算。

积分采用整数 `RoundHalfUp`。实现通过比较余数与 `ceil(denominator / 2)` 判断进位，避免在接近 JavaScript `Number.MAX_SAFE_INTEGER` 时执行 `remainder * 2` 造成非安全整数溢出。

## 验证深度

专属测试覆盖冻结配置拒绝路径、四种评分模板、普通/×2 生命周期边界、暂停、截止、跨批幂等、headless harness、公共 SPI 适配、Schema、canonical hash、训练包签名和固定 seed golden vectors。

生成器另执行 256 个 session seed × 6 个代表级 × 8 个批次，共 12,288 个批次计划的确定性压力测试，逐批验证对象上限、目标/干扰拆分、×2 波次、左右/上下及四象限均衡、同格连续限制、双目标全局非颜色差异和可复现性。第二轮对抗式复现还单独扫描 24,576 个批次计划：修复前可复现 906 个“相对另一张目标卡只差颜色”的干扰项，修复后为 0。

## 当前限制

完整 96 级配置没有导入，状态保持 `HOLD`。覆盖阻断是垂直切片施工边界的显式保护，不等于完整 96 级可用。后续 W0 已通过 Android WebView 接通触摸、Binder、批次证据和正式结果，并在 API 36 模拟器完成完整会话；Cocos 场景、生产素材、音频、候选设备性能和患者环境仍未验证。

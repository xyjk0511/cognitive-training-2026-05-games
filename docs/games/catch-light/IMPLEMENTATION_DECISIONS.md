# W2 实现口径与冲突处理

## 事实源优先级

实现遵循工作包冻结顺序：`01-捕光行动-游戏需求规格-v1.5.docx` 和公共规则 v1.3 高于原产品 ZIP 中的 v1.4 策划与 120 级表。原 ZIP 只用于代表级数值、背景和历史视觉事实。

离线配置内记录三类来源指纹：原 v1.4 数值工作簿 SHA-256、v1.5 需求书 SHA-256、公共 v1.3 SHA-256；工作簿角色固定为 `HISTORICAL_NUMERIC_INPUT_ONLY`。包索引记录编译配置的 canonical SHA-256，运行解析器只接受与该编译产物完全一致的对象，避免手工改 JSON 后仍因“Schema 合法”而静默运行。

## 水果相似关系的证据级别

`FP_CORE_A` 的五条单属性相似关系可在 v1.4 工作簿“水果相似关系”表逐项核对，标记为 `SOURCE_WORKBOOK_CONFIRMED`。v1.5 和 v1.4 工作簿没有给出 `FP_CORE_B` 的精确成对矩阵，工作包也没有正式水果 sprite；因此 W2 为 L120 headless 确定性切片保留一组工程兼容映射，但明确标记为 `ENGINEERING_COMPATIBILITY_UNAPPROVED`。

配置和包索引同时冻结：

- `runtimeUseStatus=HEADLESS_VERTICAL_SLICE_ONLY`；
- `productionActivationStatus=BLOCKED_PENDING_FRUIT_SPRITES_AND_CORE_B_RELATION_APPROVAL`；
- CORE_B `relationUseApproved=false`；
- `productionGate=BLOCK_UNTIL_PRODUCT_AND_ART_APPROVE_FINAL_SPRITES_AND_PAIR_MATRIX`。

这使独立验证器和发布检查可以识别未获批准状态，同时 L120 逻辑仍可做确定性 headless 验证。需要明确：该对象是 Catch Light 私有机器契约，不是 A620-TRC-1.1 的平台级自动拦截字段；当前 Android/共享 SPI 不会自行解释它。正式接入和发布流水线必须显式校验该 BLOCKED 状态，正式素材与关系矩阵获批后再升级 catalog/generator 版本并重做 Golden Vector。

## 同波水果唯一性

v1.5 同时冻结了“本批目标水果固定”、每波目标实例数可大于 1，以及“同一波内同一种水果不得出现两个独立实例”。三者按字面无法同时成立：例如 L120 的单波目标数可为 4，而本批只有一个固定目标水果。

W2 采用最小一致解释：

- 同波的多个目标机会允许使用同一个本批目标水果；否则无法满足 T 和固定目标规则。
- 同波干扰水果 ID 必须互不重复。
- 目标水果不得在同波或本批被复用为干扰。

该解释没有改变 T/D、阈值、时序或玩法，只消除了冻结文本内部不可满足的组合。生成器和测试均锁定这一行为。

## seed 分层

规范 seedMaterial 包含 `waveOrdinal`。W2 使用 `waveOrdinal=0` 生成批次级计划，包括固定目标、全批相似干扰配额、远端强调配额和双光圈波次；`waveOrdinal=1..8` 分别负责对应波内水果、格位和实例顺序。这样既保持每波可独立复现，又能严格满足全批总配额。

## 远端位置

旧表中的 `target_far_edge_count` / `distractor_far_edge_count` 被实现为 `edgeEmphasis` 配额：被标记实例必须落在网格左右边列。未标记实例不等于禁止使用边列，因为 2×2 网格不存在非边列。测试校验强调配额精确相等，而不是错误地要求其余实例全部位于中心列。

## 输入与半开区间

- 实例有效窗口为 `[activeStartMs, activeDeadlineMs)`；会话输入总窗口同样为 `[0, 300000)`，`299999ms` 可计、`300000ms` 起无效。
- 双光圈二击窗口同样为半开区间；精确落在二击截止时刻无效。
- 同一对象同一逻辑毫秒最多推进一次，防止双指或同帧重入把双光圈一次完成。
- 不同对象在同一逻辑毫秒可分别生效。
- 空白触摸不计 F；已结算实例的重复触摸不重复改变统计。
- 暂停期间输入被屏蔽；恢复倒计时结束前不恢复输入。会话指标记录暂停次数和从暂停生效到恢复输入启用的墙钟时长。
- 控制器 cutoff 是 DEADLINE 的权威时间。即使渲染循环先观察到晚于 cutoff 的 uptime，随后 DEADLINE 仍按 cutoff 结算，不会被误判为时钟倒退。

## Schema 继承兼容

baseline.8 的公共继承向量仍使用空 `gameConfig` 和最小 H/T/F/D、`totalTouches`、`waveOrdinal`。直接删除旧形状会破坏继承测试，因此四个 Schema 保留严格受限的 legacy 分支。

这不是 W2 正式运行形状：`parseStrictGameConfig` 会拒绝空配置，W2 Python 验证器要求所有新生成结果走完整 metrics 分支。待公共向量升级后可单独移除 legacy 分支。

公共 PREPARE 的 `runtimeConfigHash` 是会话级哈希，依赖 sessionSeed、起始等级等完整 PREPARE 投影，不能在静态训练包中伪造一个固定值。包索引因此声明其算法、canonical 投影和 Android PREPARE 权威来源；本地游戏只校验格式并原样回传，端到端一致性继续由公共 flow validator 负责。

## 代表级而非隐式全量

配置集只包含 L1、L28、L67、L102、L120。会话进入缺失等级时抛出错误，不做最近级、前一级或默认级回退。headless 代表级会话使用 HOLD 保持在 L1/L28/L102，L120 使用 UPGRADE 验证上限保护。

## L102 首教学批与连续波模式

v1.5 的 `MAX2_CONSEC` 表示双光圈最多连续出现 2 波，并不要求双光圈波彼此隔离。第 1 波禁用只适用于首次进入 L102 后的首个正式教学批；该等级后续重试批和后续批不重复禁用。

会话以“本 session 是否已经呈现过该 level”记录该事实，不用 `batchOrdinal===1` 代替“首次进入等级”。日程、批次 metrics 和 partial metrics 均保留是否发生教学抑制的审计位。

## 不可变证据与通知重试

所有被保留、哈希或跨边界发送的 canonical-JSON 对象都先复制并递归冻结。`BATCH_CLOSED` 的领域提交先于外部 sink；sink 失败只留下同一不可变事件的 pending 通知，不回滚或重算 H/T/F/D、积分和迁级。

因此当前本地通知语义是有序 at-least-once，而不是 exactly-once。接入层必须按 `batchPayloadSha256` 幂等去重；回调不得重入会话或适配器生命周期/输入入口。适配器在最外层先检查回入门，确保被拒绝的反向 `DEADLINE/TERMINATE/advance/touch` 不会先污染时钟或模块状态。

## 代表级运行时封装

会话不再暴露可变的 `CatchLightBatchRuntime`。headless 和未来渲染层使用递归冻结的 `currentBatchView` 获取日程与时间信息，所有输入仍只能通过会话/模块方法进入，避免外部提前 close、seal 或推进内部批次。

## 生成器重放校验

`scheduleSha256` 只证明日程内容自洽，不能证明它由冻结 PRNG 链生成。正式校验在约束检查后，从声明的 config、sessionSeed 和 batchOrdinal 完整重放生成器并比较整份 canonical JSON。任何改写后重算哈希的日程仍会被拒绝。

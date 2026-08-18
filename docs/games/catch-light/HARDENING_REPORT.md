# 《捕光行动》W2 第二轮加固报告

## 范围与结论

本轮在 `a620-trc-1.1-rc3-baseline.8` 的 W2 分支上进行对抗式复核，目标不是扩大产品范围，而是检查四级垂直切片在确定性、证据不可变性、生命周期事务性和截止边界上的假绿风险。

公共 `A620-TRC-1.1` wire、`contracts/**`、Android、信号反应站和共享 `typescript/src/game-plugin.ts` 均未修改。

## 实际发现并修复的问题

### 1. L102 双光圈分布语义过度收紧

旧实现把 L102 解释成“所有批次第 1 波都禁用双光圈，且双光圈波必须彼此隔离”。这不符合 v1.5 的两条独立要求：

- `MAX2_CONSEC`：最多连续 2 波，不是必须隔离；
- 只有首次进入双光圈章节后的首个正式教学批，第 1 波禁用双光圈。

修复后，会话显式记录本会话已呈现等级。L102 第一次正式呈现时生成器禁用第 1 波；该等级的后续重试批或后续批恢复第 1 波候选。批次和 partial evidence 均记录 `firstTeachingBatchWaveOneDoubleSuppressed`。

### 2. 哈希后的对象仍可被外部改写

旧边界存在调用方对象别名：配置、日程、批次证据和回调对象有机会在验证或哈希后被外部代码改写，造成“SHA-256 未更新、实际内容已变化”。

新增 canonical-JSON 边界工具：

- `immutableSnapshot`：校验、递归复制、递归冻结；
- `deepFreezeInPlace`：只用于模块自有常量；
- `isDeepFrozenJson`：测试断言。

配置、实例元数据、生成日程、批次配置、快照、`BATCH_CLOSED`、partial evidence 和最终结果均通过该边界。测试会主动改写调用方原对象和回调对象，确认运行时内容与哈希不受影响。

### 3. PRNG 索引存在模偏差

`uint32 % N` 对不能整除 `2^32` 的 N 有轻微模偏差。虽然不影响同 seed 重现，但不满足严格均匀 Fisher–Yates。

`XorShift32.nextIndex` 已改为确定性拒绝采样。消费 uint32 的规则固定，Golden Vector 和 generatorVersion 同步升级。

### 4. 会话曾暴露可变批次运行对象

外部通过 `currentBatchRuntime` 可直接调用 `close`、`sealIncompleteAt` 或推进内部批次，破坏会话所有权。

该入口已删除，替换为递归冻结的 `currentBatchView`。它只暴露渲染/headless 所需的批次时间、配置和日程快照，不暴露任何状态变更方法。

### 5. 批次证据回调失败时需要可恢复，而不能重算

批次现在先原子提交 H/T/F/D、积分、迁级和批次哈希，再尝试外部 `BATCH_CLOSED` sink。sink 失败时保留一个有序、不可变的 pending 事件：

- 不重新关闭批次；
- 不重复计分或迁级；
- 允许显式重试；
- 重试内容和 `batchPayloadSha256` 完全相同；
- 回调期间禁止重入会话。

这属于 at-least-once 本地交付语义，平台接入应按 `batchPayloadSha256` 幂等去重。

### 6. PAUSE/RESUME 边界存在半提交风险

时钟和领域会话是两个状态所有者。若先修改其中一个再由另一个拒绝，可能形成“时钟已暂停、会话未推进”或“恢复统计已记录、cutoff 不合法”的半提交。

当前流程为：

- PAUSE：时钟无副作用预校验 → 会话推进/证据交付 → 时钟提交暂停；
- RESUME：时钟 cutoff 预校验 + 会话暂停统计预校验 → 两侧同步提交。

自动测试覆盖暂停边界的 sink 首次失败、修复后同一 uptime 重试、最终 8 批不重不漏。

### 7. 自洽哈希不能证明日程没有被伪造

攻击者可以改写格位或内容后重新计算 `scheduleSha256`。仅校验“内容与自带哈希一致”不足以证明它来自冻结生成器。

`validateGeneratedSchedule` 现在除逐字段约束外，还从 `seedKey/sessionSeed/batchOrdinal` 完整重放生成器，并比较整份 canonical JSON。测试构造一个约束仍合法、且重算了 SHA-256 的格位交换日程，重放校验会拒绝它。

### 8. 已闭合批次仍可生成 partial evidence

已闭合批次若还能调用 `partialMetricsAt`，会产生与正式 eligible batch 竞争的审计形状。当前已显式拒绝；partial evidence 只能来自未闭合、截止封存的批次。

### 9. 稀疏代表级迁移错误信息不够精确

W2 只放行 L1/L28/L102/L120。代表级升降进入缺失邻级时不得回退到最近级。当前使用 `UnsupportedSliceTransitionError`，明确记录来源等级、目标等级，以及无法启动的下一批 ordinal；已闭合上一批的正式证据仍保留。

### 10. 晚帧后终态快照可能被误判为 uptime 回退

渲染帧可先观察到晚于 cutoff 的 uptime，再收到权威 DEADLINE。时钟结算本来正确，但终态快照若使用 cutoff uptime，旧单调检查会误报回退。

DEADLINE 后 active time 已封存，快照传入的 uptime 仅作信息值，不再改变或回退时钟。测试覆盖先观察 `300001ms`、再按 `300000ms` DEADLINE、随后在 cutoff 获取快照。

### 11. 生成器升级误带动训练包 anti-rollback 序号

第二轮最初把 `generatorVersion` 从 gen-1 升到 gen-2 时，同时把 `releaseSequence` 从 1 升到 2。全仓 Gate 0 信任/回滚测试证明这是越权：W2 可以升级私有生成器和 Golden Vector，但不能自行创建新的平台发布序列。

`releaseSequence` 已恢复为 baseline.8 冻结的 1；专项产物验证和全仓继承测试共同锁定该值。生成器版本仍为 `catch-light-gen-2`，两者不再错误绑定。

### 12. CORE_B 工程映射曾缺少机器级生产阻断

v1.5 只冻结 CORE_B 成员与相似度原则，v1.4 工作簿没有 CORE_B 精确成对矩阵，工作包也没有正式 sprite。仅在说明文档中写“待美术 QA”仍可能让后续集成把工程占位关系误当成已批准产品事实。

当前配置新增 `fruitContentQualification`：CORE_A 五条关系标记为工作簿确认；CORE_B 六条关系标记为 `ENGINEERING_COMPATIBILITY_UNAPPROVED`，运行范围锁为 `HEADLESS_VERTICAL_SLICE_ONLY`，生产激活状态和 production gate 均声明为阻断。TypeScript 配置校验、JSON Schema、Python 独立验证器和包索引对该对象做精确一致性校验。该私有字段不会自动改变冻结公共平台行为；接入/发布门仍需显式执行该阻断。

### 13. 回调重入曾可能先污染适配器状态

领域会话会拒绝 `BATCH_CLOSED` 回调同步重入，但旧适配器在调用会话前可能已经推进逻辑时钟，或把本地状态改成 `DEADLINE/TERMINATED`。因此，“最终被会话拒绝”仍不足以保证零副作用。

适配器现在在最外层包装 evidence hook，并在所有生命周期、输入、帧推进、查询、重试、结果构建和销毁入口执行回入门。回调反向调用 `DEADLINE` 的破坏性测试确认：调用被拒绝、时钟和模块状态保持 `RUNNING`、外层批次只提交一次，随后正常 DEADLINE 仍可产出 8 个 eligible batch。

## 自动证据

常规 W2 测试现在包含：

- 五个锚点 × 45 个固定 seed × 8 个 batchOrdinal，共 1,800 份日程的生成、约束校验和完整重放；
- 五个固定 Golden Vector 及 SHA-256；
- 伪造后重算哈希的日程拒绝；
- 配置、对象、批次、回调、结果和快照的递归冻结与调用方别名破坏测试；
- L102 首教学批抑制序列 `true,false,false,false,false,false,false,false`；
- PAUSE/RESUME 预校验、证据回调失败重试、会话与适配器双层回调重入拒绝；
- 0/1/7/8 eligible batch、299999/300000/300001ms、晚帧后 cutoff 快照；
- 已关闭批次不能生成 partial evidence；
- L1 连续失败下限保护和 L120 `UPGRADE + HOLD_MAX`。

## 未改变的边界

本轮没有把代表级扩展成 L1–L120 全量配置，也没有补 Cocos 场景、Prefab、HUD、正式水果 sprite、音频、动画或真机性能验证。P45“同波同水果唯一”与“本批固定目标 + 每波多个目标实例”的文本冲突仍按 W2 最小一致解释执行，详见 `REQUIREMENT_CONFLICTS.md`；全量生产前仍需产品侧给出正式消歧。

# W2 自动测试矩阵

`./scripts/test_catch_light.sh` 覆盖以下项目：

1. 禁用源扫描：领域与游戏配置目录中不存在 `Math.random`、`Date.now`、`setTimeout`、`setInterval` 正式逻辑源。
2. TypeScript 严格编译：ES2022、NodeNext、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
3. 配置与来源：工作簿、v1.5、公共 v1.3 SHA-256；目录、阈值、时序、版本和来源任一漂移均拒绝；调用方配置改写不能影响已接受配置；CORE_A 关系逐对核对工作簿，CORE_B 的未批准状态、headless-only 范围和生产阻断门必须完整存在。
4. PRNG：UTF-8 FNV-1a32、非法 surrogate、xorshift32 已知向量、state=0 替换、无模偏差拒绝采样和 Fisher–Yates。
5. 生成器：五个锚点 × 45 个固定 seed × 8 个 batchOrdinal，共 1,800 份日程的配额、格位、同屏、相似水果、远端强调、双光圈模式和完整确定性重放。
6. 反伪造：对约束仍合法的格位进行交换并重算 `scheduleSha256`，确认 replay validator 仍拒绝伪造日程。
7. L102/L120：L102 仅首个正式教学批第 1 波抑制，后续批恢复 wave1 候选且最多连续 2 波；L120 双光圈 6 个、每波最多 1 个、最多连续 3 波、同屏峰值 5。
8. 对象状态机：前界、起点、截止前 1ms、截止时刻、普通命中、干扰、重复、多指、双光圈第一/第二/第三击、超时和自然退场。
9. 对象与批次不可变性：实例、level config、schedule、presentation、audit 和 snapshot 均与调用方对象脱钩并递归冻结。
10. 批次：PROMPT/OPERATION/FEEDBACK/TRANSITION、H/T/F/D、重复和空白触摸、partial audit、截止封存幂等；已关闭批次不能生成竞争 partial evidence。
11. 逻辑时钟：初始 cutoff、暂停冻结、恢复剩余时长、非法命令无副作用、晚帧先到而 DEADLINE 后到、终态 cutoff 快照。
12. 会话：首败重试、二败降级、L1/L120 保护、首次进入等级教学标志、不可变只读 currentBatchView、typed 稀疏切片停止。
13. 证据通知：领域状态先提交；sink 失败后 pending 重试；同一批哈希保持不变；不重复计分/迁级；回调对象冻结；会话回入和适配器生命周期回入均在任何时钟/状态变更前拒绝。
14. 生命周期适配：PREPARE/START/PAUSE/RESUME/DEADLINE/TERMINATE 合法状态；PAUSE/RESUME 双侧预校验；暂停边界 sink 失败后按同一 uptime 恢复。
15. headless：L1/L28/L102/L120；L1 连续 FAIL；0/1/7/8 eligible batch；`299999/300000/300001ms`；未闭合审计与正式积分隔离。
16. Golden Vector：L1/L28/L67/L102/L120 的完整计划、vector hash 和生成物新鲜度。
17. Schema：配置、批次指标、会话指标、partial 指标；W2 正式分支、受限 legacy 继承分支和 Python 跨字段语义验证。
18. 正式结果与包继承：公共 `validate_game_payload`、批次自哈希、逐批 BATCH_CLOSED 内容相等、H/T/F/D 聚合、暂停审计、质量标志及重复构建幂等；训练包 `releaseSequence=1` 与 baseline.8 信任/回滚向量保持一致。

全仓继承测试由 `./scripts/test_all.sh` 运行，scope 由工作包 `verify_scope.py` 运行。

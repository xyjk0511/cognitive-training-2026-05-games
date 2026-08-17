# Contracts

- `normative/`：人类与机器均可读取的协议决策；
- `schemas/`：Draft 2020-12 结构 Schema；
- `test-vectors/`：跨语言规范化 JSON 和运行流程向量。

JSON Schema 只验证结构。跨字段、跨消息、状态、身份、账本和事务规则由 `python/a620_gate0` 执行，并由 TypeScript/Kotlin 测试镜像。

## baseline.3 机器边界

- Runtime 消息在 DTO/状态处理前执行按类型的原始字节限制与严格 JSON 解析；
- PREPARE 强制 `1 <= sessionStartLevel <= designMaxLevel <= 10000`，`plannedBatchCount` 为 `1..1024`；
- 活动消息、发送方高水位和 post-message reducer 快照在同一 SQLite 事务提交；
- 消息重放/序列状态与完整 reducer 快照可跨进程恢复；快照必须绑定活动运行身份；
- 同一任务项目的新运行必须提高 `executionAttempt`，`runtimeSessionId` 不得复用；
- PREPARE 必须先持久注册，之后才允许批次证据或正式结果提交；
- `.tpkg` 使用双遍源哈希、精确 ZIP 容器检查、当前信任策略复验和 A/B 原子激活；
- A/B 恢复只重建 durable release floor 对应的已提交包，不提升未提交 inactive 候选；
- TypeScript 规范化哈希为纯运行时代码，不依赖 Node API；
- Kotlin、TypeScript 公共包络字段与 wire Schema 通过自动测试锁步。

# A620 repository rules

1. `contracts/` 是公共协议单一事实源。不得在游戏目录复制并修改公共状态机。
2. 所有公共时间字段使用 `*UptimeMs`，禁止新增公共 `*Ns` 字段。
3. 公共 JSON 数字只能使用 JavaScript 安全整数；禁止浮点数、NaN、Infinity 和 `-0`。
4. `RESULT_READY` 只能从 `FINALIZING` 发出；正式结果必须经 Android 事务保存后才发送 `ACK_RESULT_COMMITTED`。
5. `BATCH_CLOSED` 与最终 `eligibleBatches` 必须按 ordinal 和 SHA-256 精确对账。
6. `TERMINATE`、`RUNTIME_ERROR` 不生成 `FormalTrainingResult`。
7. 游戏不得读取患者姓名、就诊号、管理端地址或上传凭据。
8. 修改公共协议时必须同时更新 Python、TypeScript、Kotlin 和 golden vectors。
9. 每次提交前运行 `./scripts/test_all.sh`。
10. 活动运行消息、sender cursor 与处理后的 reducer 快照必须同事务提交；不得先标记消息已消费再异步补写状态。
11. A/B 训练包恢复只能暴露 durable release floor 对应的已提交版本；不得把 inactive slot 中更高但未完成 pointer commit 的候选包自动提升为活动包。

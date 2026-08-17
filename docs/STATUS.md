# 单线施工状态

候选状态：`GATE_0_IMPLEMENTATION_CANDIDATE_RC3_BASELINE_3_NOT_APPROVED`

## 已完成：公共底座参考实现

- 公共协议标识与候选元数据分离；
- 公共时钟固定为 `A620-UPTIME-MS-1`；
- typed JSON Schema 与游戏专属 Schema；
- 规范 JSON 作为状态机单一事实源，并生成 TypeScript/Kotlin 转移表；
- 规范状态机的重复、重叠、不可达和终态迁移检查；
- 命令关联、发送方独立序列、幂等、时钟回退和消息字节上限；
- 活动消息、sender cursor 与 reducer 快照的同事务持久化；
- 重启后完整恢复消息缓存、时钟、边界、命令、证据账本和结果握手；
- START/PAUSE/RESUME/DEADLINE 跨消息回显与活动时间核算；
- 同毫秒竞争中 `TERMINATE > DEADLINE > PAUSE > RESUME > START`；
- PAUSE 不得与 DEADLINE 同时或晚于 DEADLINE 生效；
- `BATCH_CLOSED` 证据账本及最终结果逐批对账；
- `RESULT_READY → Android事务提交 → ACK_RESULT_COMMITTED` 参考闭环；
- 正常、终止和故障三种合法终局；
- 正式结果、执行结局和可变主控状态三类记录分离；
- A620-JCS-1 的 Python/TypeScript/Kotlin 子集实现；
- TypeScript 纯运行时 SHA-256，不依赖 Node crypto；
- Kotlin、TypeScript 消息包络与 wire Schema 字段锁步检查；
- `.tpkg` 真实归档验证、Ed25519、密钥撤销、APK兼容与防回滚；
- A/B 槽原子指针、持久发布 floor、失败保留旧版本和重启恢复；
- 恢复过程不提升未完成指针提交的暂存候选包；
- 两款游戏空插件和示例包。

## 下一批：Gate A/B 实体运行壳

- Android Studio 单 APK 工程；
- Cocos Creator 精确版本锁定；
- AIDL/Binder 双向通道；
- 可选独立训练进程；
- Android `MotionEvent.getEventTime()` 原生输入门；
- Room 生产事务、同步队列和 reducer journal；
- MockGame 可视化 300 秒逻辑会话；
- 进程杀死、Binder 延迟和候选平板文件系统验证。

## 暂不施工

- 《捕光行动》L1/L28/L102/L120；
- 《信号反应站》L1/L7/L67/L79/L90/L96；
- 120/96 级全量配置；
- 生产美术与生产密钥。

代表等级只能在 Gate A/B 的真实 Android—Cocos 闭环通过后开始；全量等级只能在代表等级通过后开始。

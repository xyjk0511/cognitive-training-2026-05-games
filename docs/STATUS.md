# 单线施工状态

候选状态：`GATE_0_IMPLEMENTATION_CANDIDATE_RC3_BASELINE_1_NOT_APPROVED`

## 已完成（首批公共地基）

- 公共协议标识与候选元数据分离；
- 公共时钟改为 `A620-UPTIME-MS-1`；
- typed JSON Schema 与游戏专属 Schema；
- 以规范 JSON 为单一事实源生成 TypeScript/Kotlin 状态机表；
- 命令关联、发送方独立序列、幂等和时钟回退检查；
- START/PAUSE/RESUME/DEADLINE 跨消息回显与活动时间核算；
- `BATCH_CLOSED` 证据账本及最终结果逐批对账；
- `RESULT_READY → Android事务提交 → ACK_RESULT_COMMITTED` 参考闭环；
- 正常、终止和故障三种合法终局；
- 正式结果、执行结局和可变主控状态三类记录分离；
- A620-JCS-1 的 Python/TypeScript/Kotlin 子集实现；
- `.tpkg` 真实归档验证、Ed25519、密钥撤销、APK兼容与防回滚；
- 两款游戏空插件和示例包。

## 下一批（Gate A）

- Android Studio 单 APK 工程；
- Cocos Creator 精确版本锁定；
- AIDL/Binder 双向通道；
- 可选独立训练进程；
- Android `MotionEvent.getEventTime()` 原生输入门；
- Room 事务保存与同步队列；
- MockGame 可视化 300 秒逻辑会话。

## 暂不施工

- 《捕光行动》L1/L28/L102/L120；
- 《信号反应站》L1/L7/L67/L79/L90/L96；
- 120/96 级全量配置；
- 生产美术与生产密钥。

代表等级只能在 Gate A/B 的真实 Android—Cocos 闭环通过后开始，全量等级只能在代表等级通过后开始。

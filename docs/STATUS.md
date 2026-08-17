# 单线施工状态

候选状态：`GATE_AB_AUTHENTICATED_DURABLE_CONTROLLER_RC3_BASELINE_8_NOT_DEVICE_APPROVED`

## 已完成

- A620-TRC-1.1 公共契约与 Python/TypeScript/Kotlin 参考实现；
- baseline.5 并发、fencing、outbox/watchdog 与训练包安装协调；
- baseline.6 boot epoch、持久化完整性、结果事务和 Android 形态运行壳；
- baseline.7 严格 canonical 入口、PFD 异步读取、有序入口、反压与触摸流取消；
- baseline.8 同 UID AIDL 通道认证、双向事件传输、SQLite v4 主控持久层、批次证据对账、正式结果单事务提交、精确 RESULT_READY/ACK 重放及 senderSeq 严格有序的持久 outbox。

## 已验证的边界

- schema 和事务在 Python SQLite 中执行；
- 公共生成器、Python、TypeScript、Kotlin/JVM 与 Android/AIDL stub 测试通过；
- PREPARE/事件身份、messageId 幂等、按 senderRole 独立 senderSeq、boot epoch 和 uptime 回退规则有机器检查；
- 正式结果与 ExecutionOutcome 互斥，结果提交失败不会留下半条结果、半条同步队列或无 ACK 的 COMPLETE 状态。

## 仍不得声称

- 没有真实 Android SDK build、AGP AIDL 生成、lint、instrumentation；
- `SQLiteOpenHelper` 事务核心不是已经完成的 Room 生产层；
- 没有真实 Binder/PFD/Cocos 进程、候选平板 kill、300 秒计时和断电证据；
- 没有可供患者使用的 APK 或正式游戏。

## 下一步

1. 在锁定工具链的 Android CI 中执行 `assembleDebug`、`lintDebug` 与 AIDL 生成；
2. 将 SQLite v4 schema 接入真实 Android 数据库测试，决定 Room facade 是否保留同一原子事务边界；
3. 接入 Cocos `:training` 进程和真实 ACTION_CANCEL；
4. 实测 Binder/PFD 反压、进程死亡、boot epoch、300 秒截止与结果 ACK 丢失；
5. 通过 Gate A/B 后开始《信号反应站》L1，再用《捕光行动》L1 检查公共底座未过拟合。

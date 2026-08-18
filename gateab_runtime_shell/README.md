# A620 Gate A/B authenticated durable controller

`rc3-baseline.8` established the authenticated same-APK controller/training boundary and SQLite v4 durability model. The current integration candidate preserves those public `A620-TRC-1.1` bytes and replaces the device MockGame wiring with the two available real game modules.

## Durable controller guarantees

- 每次绑定使用新的 256-bit token；所有 AIDL 请求/回调都校验同 UID、token 和 generation；
- inline/PFD 双向传输有消息数、字节数、超时和 stale-channel fencing；
- `A620-ACDS-1` / schema v4 保存 PREPARE、sender cursor、事件、批次证据、正式结果、同步队列和 ACK outbox；
- PREPARE 和 runtime traffic 绑定 boot epoch，同 epoch uptime 回退 fail closed；
- `BATCH_CLOSED` 与最终 `eligibleBatches` 按 ordinal、内容和 SHA-256 精确对账；
- 正式结果、同步队列、Controller 状态、ACK 和 runtime finalization 在一个事务中提交；
- ACK Binder 失败只重试原 canonical 消息，不回滚已提交正式结果。

## 当前 Android 游戏接入

- `MainActivity` 提供《捕光行动》和《信号反应站》选择；
- `TrainingActivity` 与 `TrainingRuntimeService` 运行在独立 `:training` 进程；
- 本地无网络 WebView bundle 执行 `CatchLightGameModule` / `SignalStationTrainingGameModule`；
- companion SPI 接收 Android uptime 和 pointer identity，并同步提交批次证据；
- 主进程 foreground controller service 防止 300 秒 deadline scheduler 被系统冻结；
- API 36 模拟器上两款游戏均完成 8 批、正式结果和 ACK。

源码与证据：

- Android：`android/app/src/main/java/com/a620/tablet/`
- Web 游戏入口：`../typescript/src/android-training/app.ts`
- 接入测试：`python/tests/test_android_scaffold.py`
- 交付报告：`../../../delivery/A620_GAME_INTEGRATION_VALIDATION_REPORT_20260818.md`

## 实现边界

事务核心仍直接使用 `SQLiteOpenHelper`。游戏容器当前是 Android WebView，不是 Cocos Creator；
游戏内容仍是代表级垂直切片，不是完整全等级。未完成真实候选平板、生产签名、
进程回收/断电恢复、正式素材、后台上传和患者环境验证。

该候选不允许用于患者任务。

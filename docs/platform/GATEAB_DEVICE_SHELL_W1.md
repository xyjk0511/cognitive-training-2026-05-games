# W1 Gate A/B 真实 Android 运行壳施工记录

基线固定为 `a620-trc-1.1-rc3-baseline.8` / `eb810135965c0c08bc53715c3724539bff73a0c5`，
公共 wire 固定为 `A620-TRC-1.1`。本线未修改 `contracts/`、`games/`、`packages/`，也未实现两款游戏玩法。

> 历史边界说明：本文件记录 W1 原始施工线。当前集成分支已在不修改公共 wire 的前提下，用 `InteractiveTrainingRuntime`、`TrainingActivity` 和本地 WebView bundle 接入两款代表级游戏，并完成 API 36 模拟器完整会话；当前状态以 `docs/STATUS.md` 为准。

## 进程与所有权

应用只有一个 launcher。`A620Application` 在主进程启动时打开应用私有
`a620-controller.db`，触发 schema migration、`quick_check`、外键检查及
业务不变量检查，并把 monotonic uptime 绑定到 Android boot ID/boot count。
Android 的同一 `Application` 会在每个进程初始化，因此代码显式核对当前进程名，
`:training` 进程不会打开或持有主控数据库。主控进程冷启动时，数据库中残留的
ACTIVE runtime 会保留已有证据并以 `CONTROLLER_PROCESS_RESTARTED` 形成
INTERRUPTED，释放单活动运行约束；不会把丢失的内存 reducer 伪装成恢复成功。
`PersistentPlatformController` 只允许持有一个当前 executionAttempt；终止、
训练进程死亡或主控释放后必须建立新 attempt。

训练侧只有 `TrainingRuntimeService`，manifest 固定为 `exported=false`、
`android:process=":training"`。业务层只看到 `ControllerCommandChannel`，不拿
生成的 `ITrainingRuntime`。绑定的原始 token 仅驻留内存，持久事实只使用摘要；
每次请求、回调、异步 PFD 解析前后及 actor 执行前均复核 token/generation。

## 双向 canonical / PFD

主控→训练与训练→主控都执行相同边界：

- canonical JSON `<= 49,152` bytes：inline；
- 更大且 `<= 2,097,152` bytes：PFD pipe；
- writer、reader、在途字节与消息数均有界；
- receiver 先 dup AIDL 描述符，再离开 Binder 线程执行读取、长度、SHA-256、
  canonical 解析和 AIDL/JSON 身份交叉核对；
- 有序 sequencer 阻止后到 inline 越过先到 bulk；
- channel rotation 后完成的旧 PFD 只能进入 stale audit，不能进入 reducer；
- 超时、短读、写失败、不可丢消息反压耗尽均 fail closed；只有
  `HEARTBEAT`、`STATE_SNAPSHOT` 可按公共策略丢弃。

JVM stub 的 PFD 已从空壳改为连通 pipe、dup 引用计数与可观测关闭模型，目的
是验证源码的资源所有权和故障分支；它不替代 Android Binder/PFD 实机证据。

## 持久控制器与迁移

v4 正式结果事务仍是一个 SQLite transaction：`formal_training_result`、
`result_sync_queue`、`controller_state`、`ACK_RESULT_COMMITTED` outbox 和
`runtime_session` finalization 要么全部提交，要么全部回滚。新增测试覆盖五个
故障注入位置，包括最后的 runtime finalization。

唯一支持的升级是 v1→v4。v1 缺少 system/device/task 完整身份、canonical
消息、UTC retry 与 ACK 事实，不能安全合成 v4 活动运行。因此迁移先删除旧
同名 trigger，再把五张旧表整体重命名为 `legacy_v1_*`，创建干净 v4 表，并
写入 `ARCHIVED_NEW_EXECUTION_ATTEMPT_REQUIRED` 审计。旧记录保留但不参与新
正式任务；其他升级、所有降级均 fail closed，禁止自动清库。

## MockGame 闭环

训练进程使用引擎无关 `DeviceShellMockRuntime`，只实现公共状态和公共结果：
300000 ms、暂停/恢复、DEADLINE、0/1/7/8 eligible batch、
`BATCH_CLOSED → RESULT_READY → ACK_RESULT_COMMITTED`。同一 DEADLINE 重放只
重发首次 `RESULT_READY` 的同一 envelope、senderSeq 和 canonical bytes。
Mock 不包含水果、信号、等级设计、场景、触控命中或生产计分规则。

## W1 当时的证据边界

W1 原始环境只能确认 Python/SQLite、TypeScript、Kotlin、JVM/AIDL stub 和源码 scope。
后续 W0 集成已补 Android SDK build、lint、安装及两款 300 秒模拟器会话；仍未补齐
候选平板、双进程 kill、断电恢复、Cocos 和生产签名证据。

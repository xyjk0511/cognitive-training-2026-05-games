# A620 Cognitive Training Platform — 单线施工 rc3-baseline.8

状态：`GATE_AB_AUTHENTICATED_DURABLE_CONTROLLER_CANDIDATE_NOT_DEVICE_APPROVED`

本仓库坚持一个 A620 主 APK、一个患者入口和多个受控训练包。baseline.8
仍处于公共底座施工，不提前实现《信号反应站》或《捕光行动》的正式关卡。

## 继承能力

- A620-TRC-1.1 wire、Schema、状态机、JCS、毫秒 uptime 与训练包安全参考实现；
- baseline.5 并发 inbox/outbox、租约 fencing、watchdog/retry 与安装协调；
- baseline.6 boot epoch、持久化完整性、结果事务与 Android 形态运行壳；
- baseline.7 严格 canonical 入口、PFD 异步读取、有序入口、反压与触摸流取消。

## baseline.8 新增

1. 每次绑定生成新的 256-bit 内部通道令牌；每个 AIDL 请求和回调均携带令牌与 generation；
2. 同 UID 校验、常量时间 token digest 比较，以及异步 bulk 解析前/后双重 channel fencing；
3. ControllerRuntimeClient 不再向业务代码暴露原始 AIDL 接口；
4. Cocos→Android 方向补齐 inline/PFD 双向事件传输、预算与失败收口；
5. 新增 A620-ACDS-1 / schema v4：运行身份、入站事件、发送序列、批次证据、正式结果、执行结局、同步队列、ACK outbox 与主控状态；
6. PREPARE 必须绑定当前 boot epoch；同一 epoch 内 uptime 回退 fail closed；
7. `BATCH_CLOSED` 过程证据与最终 `RESULT_READY` 按 ordinal、内容与 SHA-256 精确对账；
8. 正式结果、待上传队列、主控状态、`ACK_RESULT_COMMITTED` 和 runtime finalization 在一个 SQLite 事务中提交；
9. ACK 由持久 outbox 以 owner + claimGeneration 领取；Binder 发送失败只重试原消息，不回滚已保存正式结果；
10. 重放同一 `RESULT_READY` 返回第一次提交的 resultId、时间、hash 与 ACK 原始字节；
11. 跨重启重试使用 UTC deadline，不把旧 boot 的 uptime 当作可比较时间；
12. Android 工具链预检修正为 JDK 17 minimum，并在当前 JDK 21 上完成 JVM/stub 编译。

## 验证

```bash
./scripts/test_all.sh
```

也可分阶段运行：

```bash
./scripts/test_python.sh
./scripts/test_typescript.sh
./scripts/test_kotlin.sh
./scripts/build_sample_packages.sh
./baseline5_hardening/scripts/test_baseline5_hardening.sh
./baseline6_hardening/scripts/test_baseline6_hardening.sh
./gateab_runtime_shell/tools/test_baseline8.sh
```

Android SDK 预检：

```bash
./gateab_runtime_shell/android/ci/android_sdk_preflight.sh
```

## 必须准确理解

- baseline.8 的 SQLite schema 在 Python `sqlite3` 中真实执行，Kotlin Android 源码在 JVM/AIDL stub 下完成编译与对抗测试；
- 当前持久化核心使用 `SQLiteOpenHelper` 保持跨表单事务边界，不应被描述为已经完成 Room 生产接入；
- 当前环境缺少 Gradle 9.5.0、Android SDK 和依赖解析条件，未生成真实 APK，也未完成真实 AIDL、Binder/PFD、Room migration 或 Android lint；
- 尚无 Cocos Creator 原生工程、候选平板进程死亡/300 秒边界/断电证据；
- 尚未进入两款游戏 L1、生产素材和生产密钥阶段。

baseline.8 不能用于患者任务，也不构成 Gate A/B 通过证明。

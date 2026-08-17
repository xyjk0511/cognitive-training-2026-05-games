# A620 Cognitive Training Platform — 单线施工 rc3-baseline.7

状态：`GATE_AB_RUNTIME_INGRESS_CANDIDATE_NOT_DEVICE_APPROVED`

本仓库坚持一个 A620 主 APK、一个入口和多个受控训练包。baseline.7
仍在公共底座阶段，没有提前进入《信号反应站》或《捕光行动》的正式关卡开发。

## 继承能力

- A620-TRC-1.1 wire、Schema、状态机、JCS、毫秒 uptime 和训练包安全参考实现；
- baseline.5 并发 inbox/outbox、租约 fencing、watchdog/retry 与安装协调；
- baseline.6 持久 JSON hash、显式数据库迁移、boot epoch、跨表完整性审计、
  Android 形态 AIDL/PFD 运行壳、MockGame 和结果七步事务。

## baseline.7 新增

1. 严格、资源受限的 Kotlin canonical JSON 解析器；
2. AIDL `messageType/messageId/senderSeq` 与 canonical envelope 三项交叉核对；
3. 大载荷 PFD 读取、长度/hash/解析移出单一状态 actor；
4. bulk 独立并发和字节预算，以及 15 秒读取租约；
5. 入口顺序屏障：后完成的快速消息不能越过先到但仍在读取的 bulk 消息；
6. 紧急消息拥有独立准入容量，但不允许违反因果 FIFO；
7. `HEARTBEAT/STATE_SNAPSHOT` 可在反压时丢弃，正式批次、结果和终止消息不可丢弃；
8. 触摸跨越暂停/截止边界时返回 `CANCEL_STREAM`，不再留下 Cocos 卡住的 pointer；
9. Android 主控回调方向使用同一严格入口；
10. Android 工具链锁由规范生成，并明确标记 SDK build、依赖解析和设备验证尚未完成。

## 验证

```bash
./scripts/test_all.sh
```

也可分阶段执行：

```bash
./scripts/test_python.sh
./scripts/test_typescript.sh
./scripts/test_kotlin.sh
./scripts/build_sample_packages.sh
./baseline5_hardening/scripts/test_baseline5_hardening.sh
./baseline6_hardening/scripts/test_baseline6_hardening.sh
./gateab_runtime_shell/tools/test_baseline7.sh
```

Android SDK 预检：

```bash
./gateab_runtime_shell/android/ci/android_sdk_preflight.sh
```

## 仍未完成

- 当前环境没有 Gradle 9.5.0、Android SDK 或依赖网络，因此没有真实 `assembleDebug/lintDebug` 结果；
- 没有 Gradle Wrapper JAR、Room 生产实现、Cocos Creator 原生工程或候选平板测试；
- 没有真实 Binder/PFD、kill -9、300 秒边界、闪存断电和安装回退设备证据；
- 没有两款游戏 L1、生产素材或生产密钥。

baseline.7 不能用于患者任务，也不构成 Gate A/B 通过证明。

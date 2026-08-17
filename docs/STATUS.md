# 单线施工状态

候选状态：`GATE_AB_RUNTIME_SHELL_CANDIDATE_RC3_BASELINE_6_NOT_DEVICE_APPROVED`

## 已完成

- A620-TRC-1.1 wire、Schema、状态机、JCS、毫秒 uptime 和训练包安全参考实现；
- baseline.5 并发 inbox/outbox、租约 fencing、watchdog/retry 和安装器协调；
- baseline.6 持久 JSON hash、schema migration、时钟回退拒绝、watchdog 唯一性和跨表 integrity audit；
- Python 控制器数据库 migration、boot epoch 收口、批次证据、正式结果事务和 emergency reserve；
- Kotlin/JVM runtime channel、bounded actor、input gate、bulk transport 和 MockGame；
- TypeScript transport policy；
- Android 单入口 + `:training` 服务 + AIDL + PFD + Binder death 源码骨架。

## 必须准确理解

“JVM/Python/TypeScript 测试通过”不等于 Android APK 已编译，也不等于候选平板通过。Android 目录目前是可评审源码骨架；本环境没有完成 Android SDK 构建、instrumentation 或设备试验。

## 下一步

1. 锁定 Android SDK、AGP、Gradle、JDK 和 Cocos Creator 精确版本；
2. 生成 Gradle Wrapper并完成 `assembleDebug/lint/test`；
3. 将 Python 控制器事务语义移植为 Room Entity/DAO/Migration；
4. 将 Cocos runtime 放入 `:training` 进程并接入 AIDL；
5. 在候选平板执行 Binder 并发、PFD、kill -9、300 秒输入边界、重启和文件系统故障测试；
6. 通过后才实现《信号反应站》L1，再实现《捕光行动》L1。

## 暂不施工

- 两款游戏代表级以外的全量等级；
- 生产美术、生产密钥和患者任务。

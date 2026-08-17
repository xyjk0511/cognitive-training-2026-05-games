# 单线施工状态

候选状态：`GATE_AB_RUNTIME_INGRESS_CANDIDATE_RC3_BASELINE_7_NOT_DEVICE_APPROVED`

## 已完成

- A620-TRC-1.1 公共契约与三端参考实现；
- baseline.5 并发、fencing、outbox/watchdog 和包安装协调；
- baseline.6 持久化完整性、迁移、结果事务和 Android 形态运行壳；
- baseline.7 严格报文入口、AIDL 身份交叉核对、off-actor PFD 读取、
  有序入口屏障、紧急容量预留、遥测反压丢弃、触摸流取消和工具链锁。

## 必须准确理解

JVM/Python/TypeScript 和 Android stub 编译通过，不等于 Android APK 已通过官方
SDK 构建，也不等于候选平板通过。当前环境缺少 Gradle 9.5.0 和 Android SDK；
预检会明确失败而不是伪造通过记录。

## 下一步

1. 在具备锁定工具链的 Android CI 上执行 `assembleDebug/lintDebug`；
2. 修复真实 AGP/AIDL/lint 暴露的问题并生成 Gradle Wrapper；
3. 将控制器事务迁移为 Room，并把 generated validators 接入 sink；
4. 接入 Cocos `:training` 进程和真实 ACTION_CANCEL 适配；
5. 候选平板执行 Binder/PFD、反压、进程死亡、300 秒边界和断电试验；
6. 通过后开始《信号反应站》L1，再验证《捕光行动》L1。

## 暂不施工

- 两款游戏全量等级；
- 生产美术、生产签名和患者任务。

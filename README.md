# A620 Cognitive Training Platform — 单线施工 rc3-baseline.6

状态：`GATE_AB_RUNTIME_SHELL_CANDIDATE_NOT_DEVICE_APPROVED`

本仓库仍坚持一个 A620 主 APK、一个入口和多个受控训练包。当前版本没有进入两款游戏的正式关卡开发，而是把公共参考底座推进到“Android 形态运行壳 + 可执行持久化语义”阶段。

## baseline.6 新增

1. **持久数据统一使用 A620-JCS-1**：SQLite 内 JSON 不再用 Python 默认 `sort_keys`；与 wire 层共享 UTF-16 键排序、资源预算、非法 Unicode 和安全整数规则。
2. **读前完整性验证**：snapshot、inbox outcome、outbox ACK 集、watchdog details、包 manifest 均绑定 SHA-256，并在恢复或使用前验证规范化字节。
3. **版本化数据库迁移**：baseline.5 数据库可迁移到 runtime schema 2 / package schema 2；未知未来版本拒绝猜测性打开。
4. **单调时钟防回退**：同一 uptime epoch 内时间倒退立即失败；安装协调器发现新 boot epoch 时清锁并作废未提交安装，不跨时钟域比较租约。
5. **看门狗边界修复**：无 sourceMessageId 的 obligation 使用规范 sentinel 建立真实唯一键；同一 runtime 任一到期看门狗均优先于同毫秒到达的任意 ACK。
6. **跨表一致性审计**：启动和按需检查 SQLite、外键、hash、状态 revision、终局/租约/outbox/watchdog、active package/release floor 和安装 journal。
7. **Gate A/B 运行壳**：新增单入口 Android Studio 源码骨架、同 APK `:training` 服务、AIDL、同 UID 校验、inline/bulk PFD 传输、单消费者 actor、原生 `MotionEvent.eventTime` 半开输入门和 Binder death 中断路径。
8. **可执行 MockGame 闭环**：Kotlin/JVM 参考会话覆盖 8 个批次、300 秒逻辑截止、暂停恢复、批次证据、结果提交幂等和新 executionAttempt 隔离。
9. **控制器数据库参考**：Python/SQLite 参考实现覆盖 legacy migration、boot epoch 收口、batch evidence、正式结果 + sync queue + controller state + ACK 的同事务提交和故障注入回滚。
10. **生成式规范**：baseline.5 协调 profile、baseline.6 存储 profile 和 Gate A/B runtime shell profile 均从 normative JSON 生成到 Python/TypeScript/Kotlin；Android `RuntimePolicy.kt` 也不再手抄。

## 一键验证

```bash
./scripts/test_all.sh
```

若宿主环境对多次 Kotlin 编译存在进程限制，可分阶段执行：

```bash
./scripts/test_python.sh
./scripts/test_typescript.sh
./scripts/test_kotlin.sh
./scripts/build_sample_packages.sh
./baseline5_hardening/scripts/test_baseline5_hardening.sh
./baseline6_hardening/scripts/test_baseline6_hardening.sh
./gateab_runtime_shell/tools/test_baseline6.sh
```

## 仍未完成

- 未使用 Android SDK 编译、lint 或安装 APK；
- 未生成和验证 Gradle Wrapper；
- 未接入 Room 生成代码；
- 未接入真实 Cocos Creator 工程；
- 未在候选平板测 Binder P95/P99、进程杀死、输入边界、休眠和断电；
- 未实现《信号反应站》L1 或《捕光行动》L1；
- 未使用生产签名密钥。

因此 baseline.6 不是 Gate 0/Gate A/Gate B 通过证明，也不能用于患者任务。

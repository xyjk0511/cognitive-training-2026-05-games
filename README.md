# A620 Cognitive Training Platform — Gate 0 单线施工候选基线

状态：`GATE_0_IMPLEMENTATION_CANDIDATE_RC3_BASELINE_3_NOT_APPROVED`

本仓库是从零建立并持续加固的公共平台代码基线，不包含《捕光行动》120 级或《信号反应站》96 级的全量实现。当前范围严格限定为：

- A620-TRC-1.1 公共运行消息、结构 Schema 与机器状态机；
- A620-UPTIME-MS-1 毫秒单调时钟和消息级字节限制；
- Python 参考 reducer、语义验证器与 SQLite 持久化边界；
- TypeScript 公共状态机、纯运行时 SHA-256/JCS 子集与游戏插件接口；
- Kotlin/JVM 主控 DTO、状态机与批次账本参考实现；
- 批次证据对账及正式结果提交握手；
- 真实 `.tpkg` 构建、安全验证、签名、防回滚和 A/B 槽激活；
- 两个游戏的空插件及示例训练包。

## baseline.3 重点加固

1. **消息与 reducer 原子持久化**：活动消息、发送方高水位和处理后的完整 reducer 快照在同一 SQLite 事务中提交，避免崩溃后出现“消息已消费、状态少走一步”。
2. **重启与旧执行隔离**：消息幂等缓存、发送序列、活动运行身份和 reducer 快照可跨进程恢复；旧 `executionAttempt`、旧 `runtimeSessionId`、旧时钟纪元只进入审计。
3. **状态机完整性**：规范状态表先检查重复规则、重叠规则、不可达状态和终态非法迁移，再生成 TypeScript/Kotlin 表；两端穷举全部状态×输入组合。
4. **严格 wire 入口**：在 DTO/状态处理前按消息类型限制原始 UTF-8 字节数，并拒绝重复 JSON key、浮点数、不安全整数、非法 UTF-8 和空白膨胀。
5. **跨语言一致性**：Kotlin 与 TypeScript 消息包络字段自动对照公共 Schema；TypeScript SHA-256 不再依赖 `node:crypto`，可进入 Cocos 运行环境。
6. **结果事务加固**：PREPARE、逐批 `BATCH_CLOSED`、最终 payload、正式结果、同步队列和可变主控状态均有明确绑定及互斥规则。
7. **训练包原子激活**：构建时二次核对源文件；校验 ZIP 容器、路径、类型、大小、压缩率、哈希、Ed25519、信任根、兼容范围和发布序号；A/B 槽恢复只认已提交 release floor，不会把已暂存但未提交的新包误激活。

## 为什么先做公共线

产品边界要求一个主 APK、一个入口；训练包不能绕过 Android 总控形成正式结果。公共层未冻结前，不允许两款游戏各写一套计时、暂停、结果或训练包逻辑。

## 一键验证

```bash
./scripts/bootstrap_vectors.sh
./scripts/test_all.sh
```

当前参考验证输出：

```text
55 passed
TYPESCRIPT_GATE0_TESTS_PASS
KOTLIN_GATE0_TESTS_PASS
SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS
ALL_GATE0_IMPLEMENTATION_TESTS_PASS
```

Python 参考依赖锁定文件：

```text
python/requirements.lock.txt
```

## 版本约定

线上 wire 字段使用最终标识：

```text
contractVersion = A620-TRC-1.1
clockProfile = A620-UPTIME-MS-1
canonicalJsonProfile = A620-JCS-1
```

候选信息不进入线上协议语义，保存在：

```text
release/candidate.json
candidateRevision = rc3-baseline.3
```

Gate 0 只有在 Android、Cocos Creator、候选平板和故障注入全部完成后才能批准。当前仓库仍是实现候选基线，不能据此宣称 Gate 0 已通过。

## 当前未包含

- Android Studio 主 APK 与真实 AIDL/Binder 集成；
- Cocos Creator 原生工程、训练进程与 Asset Bundle；
- Android `MotionEvent.getEventTime()` 原生输入门；
- Room 生产数据库和管理软件生产接口；
- 生产签名密钥；
- 两款游戏正式素材和代表等级；
- 候选平板上的真实 IPC 延迟、休眠、进程杀死和断电文件系统验证。

这些属于后续 Gate A–F。当前代码提供可编译、可执行、可恢复、可审查的公共参考基线和 Mock Host。

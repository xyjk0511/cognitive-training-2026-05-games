# A620 Cognitive Training Platform — Gate 0 单线施工候选基线

状态：`GATE_0_IMPLEMENTATION_CANDIDATE_RC3_BASELINE_5_NOT_APPROVED`

本仓库是从零建立并持续加固的公共平台代码基线，不包含《捕光行动》120 级或《信号反应站》96 级的全量实现。当前范围严格限定为：

- A620-TRC-1.1 公共运行消息、结构 Schema 与机器状态机；
- A620-UPTIME-MS-1 毫秒单调时钟和消息级字节限制；
- Python 参考 reducer、语义验证器、持久日志、可靠投递和看门狗；
- TypeScript 公共状态机、纯运行时 SHA-256/JCS 子集、IPC 帧与游戏插件接口；
- Kotlin/JVM 主控 DTO、状态机、IPC 帧与批次账本参考实现；
- 批次证据对账及正式结果提交握手；
- 真实 `.tpkg` 构建、安全验证、签名、防回滚和 A/B 槽激活；
- 两个游戏的空插件及示例训练包。

## baseline.5 重点加固

1. **并发入站单次提交**：SQLite `BEGIN IMMEDIATE` 将消息去重、sender 序列、纯 reducer、快照和 revision 放入同一事务；两个工作线程同时处理同一消息时只有一条已提交状态迁移。
2. **运行租约与 fencing token**：过期工作线程在新 owner 接管后无法继续提交；新执行代次会原子废止旧运行、取消旧 outbox/watchdog 并删除旧 lease。
3. **持久化 outbox claim generation**：并发发送者领取集合互斥，重试保持首次 canonical bytes、`messageId` 与 `senderSeq`；过期 claim 在重启后按运行终态确定返回 PENDING 或 CANCELLED。
4. **看门狗—重试确定性竞争**：同一 uptime 毫秒固定 `WATCHDOG > RETRY > ACK`；超时原子写入中断结局并取消待发消息，不伪造正式结果。
5. **训练包安装器 fencing**：同一游戏串行、不同游戏可并行；active pointer、durable release floor 与安装 journal 在同一事务提交，旧 fence 无法激活包。
6. **故障注入**：覆盖 inbox 插入后、snapshot 更新后、commit 前，以及训练包 pointer/floor/journal 提交窗口，验证事务完整回滚。
7. **规范单一事实源**：`A620-CCP-1`、`A620-PIL-1`、`A620-RWC-1` 从 normative JSON 生成到 Python、TypeScript 和 Kotlin。
8. **继承 baseline.4**：跨语言 JSON 预算、流式 IPC 帧、持久重发、看门狗、审计链、紧凑快照、真实 `.tpkg` 校验与 A/B 槽继续生效。

## 为什么先做公共线

产品边界要求一个主 APK、一个入口；训练包不能绕过 Android 总控形成正式结果。公共层未冻结前，不允许两款游戏各写一套计时、暂停、结果或训练包逻辑。

## 一键验证

```bash
./scripts/bootstrap_vectors.sh
./scripts/test_all.sh
```

当前参考验证输出：

```text
75 passed
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
candidateRevision = rc3-baseline.5
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

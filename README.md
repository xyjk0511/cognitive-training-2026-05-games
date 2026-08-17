# A620 Cognitive Training Platform — Gate 0 单线施工候选基线

状态：`GATE_0_IMPLEMENTATION_CANDIDATE_RC3_BASELINE_4_NOT_APPROVED`

本仓库是从零建立并持续加固的公共平台代码基线，不包含《捕光行动》120 级或《信号反应站》96 级的全量实现。当前范围严格限定为：

- A620-TRC-1.1 公共运行消息、结构 Schema 与机器状态机；
- A620-UPTIME-MS-1 毫秒单调时钟和消息级字节限制；
- Python 参考 reducer、语义验证器、持久日志、可靠投递和看门狗；
- TypeScript 公共状态机、纯运行时 SHA-256/JCS 子集、IPC 帧与游戏插件接口；
- Kotlin/JVM 主控 DTO、状态机、IPC 帧与批次账本参考实现；
- 批次证据对账及正式结果提交握手；
- 真实 `.tpkg` 构建、安全验证、签名、防回滚和 A/B 槽激活；
- 两个游戏的空插件及示例训练包。

## baseline.4 重点加固

1. **跨语言 JSON 资源预算**：最大深度、节点数、对象成员、数组长度、单字符串、键长和总字符串字节由同一规范生成到 Python、TypeScript、Kotlin；循环对象、深层嵌套和字符串放大在规范化前拒绝。
2. **流式 IPC 帧**：4 字节大端长度头、2 MiB 单帧上限和 8 MiB 单次输入上限；支持拆帧与粘包，内部最多保留一个未完成帧，协议错误后该 decoder 永久失败并要求重建通道。
3. **持久重发队列**：关键命令、`RESULT_READY` 与 `BATCH_CLOSED` 使用原始规范化字节、原 `messageId` 和原 `senderSeq` 重发；进程重启后继续，完成、取消和证据释放均有确定规则。
4. **运行看门狗**：READY、COMMAND_ACCEPTED、状态确认、心跳、RESULT_READY 和本地结果提交均有机器化期限；超时只会形成中断，不会伪造正式结果。看门狗快照可持久化并在进程重启后恢复。
5. **可验证运行审计链**：消息日志与哈希链、链头锚点同事务提交；baseline.3 旧库只允许一次迁移，迁移标记存在后链缺失或截断均拒绝启动，不再静默重建。
6. **紧凑 reducer 快照**：快照由保存完整报文字节改为 `messageId → SHA-256`，降低重启状态体积；仍可只读迁移 baseline.3 的 v1.1 快照。
7. **规范单一事实源**：资源预算、IPC 帧、重试、消息响应义务、看门狗和审计链关键常量从 normative JSON 自动生成到三端，避免手工漂移。
8. **保留 baseline.3 的事务与训练包加固**：消息+reducer 原子持久化、旧执行隔离、正式结果三表事务、真实 ZIP 校验、Ed25519、防回滚和 A/B 槽恢复继续生效。

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
candidateRevision = rc3-baseline.4
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

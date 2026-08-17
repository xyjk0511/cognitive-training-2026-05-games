# A620 Cognitive Training Platform — Gate 0 单线施工候选基线

状态：`GATE_0_IMPLEMENTATION_CANDIDATE_RC3_BASELINE_2_NOT_APPROVED`

本仓库是从零建立的公共平台首批代码，不包含《捕光行动》120 级或《信号反应站》96 级的全量实现。当前范围严格限定为：

- A620-TRC-1.1 公共运行消息与机器状态机；
- A620-UPTIME-MS-1 毫秒单调时钟；
- Python 参考验证器与 SQLite 事务边界；
- TypeScript 公共运行状态机与游戏插件接口；
- Kotlin/JVM 主控参考状态机与批次账本；
- 批次证据对账及正式结果提交握手；
- 真实 `.tpkg` 构建、安全验证、签名和防回滚；
- 两个游戏的空插件及示例训练包。

## 为什么先做公共线

产品边界要求一个主 APK、一个入口；训练包不能绕过 Android 总控形成正式结果。公共层未冻结前，不允许两款游戏各写一套计时、暂停、结果或训练包逻辑。

## 一键验证

```bash
./scripts/bootstrap_vectors.sh
./scripts/test_all.sh
```

当前验证内容：

1. JSON Schema、游戏专属 Schema 与 Python 语义测试；
2. 正常完成、暂停后完成、终止、同毫秒终止优先和运行故障；
3. 缺失 ACK、错误回显、错误状态、时钟错误、批次替换、等级链篡改等对抗样例；
4. TypeScript 与 Kotlin 状态机由同一份规范 JSON 生成并编译测试；
5. Python / TypeScript / Kotlin 规范化 JSON golden vectors；
6. SQLite 中批次证据、正式结果、同步队列和主控状态的原子提交；
7. 实际 `.tpkg` 的路径、重复项、普通文件类型、大小、压缩比、文件哈希、Ed25519 签名、密钥状态、APK 兼容和 releaseSequence 防回滚；
8. 相同输入生成字节一致的 `.tpkg` 与源码 ZIP。

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
candidateRevision = rc3-baseline.2
```

Gate 0 只有在 Android、Cocos Creator、候选平板和故障注入全部完成后才能批准。当前仓库只是实现候选基线，不能据此宣称 Gate 0 已通过。

## 当前未包含

- Android Studio 主 APK 与真实 AIDL/Binder 集成；
- Cocos Creator 原生工程、训练进程与 Asset Bundle；
- Android `MotionEvent.getEventTime()` 原生输入门；
- Room 生产数据库和管理软件生产接口；
- 生产签名密钥；
- 两款游戏正式素材和代表等级。

这些属于后续 Gate A–F。当前代码提供可编译、可执行、可审查的公共基线和 Mock Host。

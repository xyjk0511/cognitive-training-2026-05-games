# A620 Gate 0 rc3-baseline.3 测试报告

日期：2026-08-17

## 结论

当前参考实现输出：

```text
55 passed
TYPESCRIPT_GATE0_TESTS_PASS
KOTLIN_GATE0_TESTS_PASS
SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS
ALL_GATE0_IMPLEMENTATION_TESTS_PASS
```

该结论只说明本候选仓库中的规范、参考实现、测试向量和样例训练包自洽，**不等于 Gate 0 已通过，也不等于已有可安装 APK**。

## baseline.3 已验证

### 公共协议与状态机

- 所有公共 Schema 通过 Draft 2020-12 元校验；
- 规范状态表不存在重复、重叠、未知或不可达状态；
- TypeScript 与 Kotlin 由同一状态规范生成，并穷举全部已声明状态×输入组合；
- `RESULT_READY` 不能从 `RUNNING` 发出；
- `TERMINATE`、`DEADLINE`、`PAUSE` 同毫秒优先级固定，PAUSE 不得与 cutoff 同时或晚于 cutoff；
- PREPARE 的起始等级、最高等级和计划批次数跨字段边界被强制执行；
- 缺少或迟到 `COMMAND_ACCEPTED`、错误 correlation、错误回显、时钟倒退、错误快照和非法状态均被拒绝。

### 严格 wire 与跨语言确定性

- 原始消息在解析前应用全局及按消息类型的 UTF-8 字节上限；
- 重复 JSON key、浮点数、不安全整数、非法代理字符和空白膨胀被拒绝；
- Python、TypeScript、Kotlin 规范化 JSON golden vectors 一致；
- TypeScript SHA-256 已通过已知向量，且运行源码不导入 `node:crypto`；
- Kotlin、TypeScript 的 `MessageEnvelope` 字段集合与公共 wire Schema 逐项一致。

### 重启安全与幂等

- `messageId` 相同且内容相同为幂等重放；相同 ID 不同内容为硬冲突；
- 活动消息、sender cursor 和 post-message reducer 快照在同一 SQLite 事务提交；
- 故障注入发生在 journal insert 后时，消息、cursor 和快照整体回滚；
- 重启后能恢复完整 reducer、命令、时钟边界、证据账本和结果握手；
- 旧执行、旧 runtime session 和旧 monotonic epoch 只进入审计，不改变新运行；
- 同一任务项目替换时 `executionAttempt` 必须提高，`runtimeSessionId` 不得复用；
- 旧运行中曾为 NEW 的消息在新运行激活后重放，不返回旧 reducer 快照。

### 正式结果事务

- PREPARE 必须先持久注册，批次证据和正式结果才能进入数据库；
- 每条 `BATCH_CLOSED` 校验身份、senderSeq、活动时间、ordinal、内容哈希和精确重放；
- `RESULT_READY` 与 PREPARE、批次证据账本、等级链、原始积分和游戏专属 Schema 对账；
- 正式结果、同步队列和主控状态同事务提交，故障不会形成半条正式结果；
- ACK 丢失后重试返回第一次事务提交时间，不生成第二份结果；
- `ExecutionOutcome` 与 `FormalTrainingResult` 互斥；终止和故障不能形成正式成绩。

### `.tpkg` 与 A/B 激活

- 两份空插件样例包完成确定性构建、Ed25519 签名、内容树哈希和真实归档验证；
- 拒绝路径穿越、绝对路径、重复条目、软链接、非普通文件、加密、注释、前后附加数据、多磁盘、异常尺寸和高压缩率；
- 信任根要求唯一 ACTIVE、最多一个 NEXT、唯一 keyId，并执行 REVOKED；
- APK 版本范围、请求 gameCode 和 releaseSequence 防回滚被验证；
- 构建输出采用临时文件、fsync 和原子替换，失败不破坏旧文件；
- A/B 安装仅允许 `IDLE_NO_TASK`，指针提交前失败仍暴露旧包；
- 首次安装在指针提交前失败，恢复后保持无活动包；
- 指针损坏时只恢复 durable release floor 对应的最后已提交包，不提升 inactive slot 中未提交的新包；
- 当前活动包的精确重放不能绕过新的信任根或兼容策略。

## 代码与规范规模

排除 `.git`、构建产物、缓存和第三方依赖后：

- 文本源码、规范、Schema、测试向量和文档：103 个文件；
- 总计约 23,553 行。

该行数包含机器 Schema、生成表、测试向量和文档，不等同于纯业务代码行数。

## 尚未验证

- Android APK、AIDL/Binder、Android 生命周期和受控前台；
- Cocos Creator、Asset Bundle、真实触摸事件、渲染帧和进程隔离；
- 候选平板上的 IPC P95/P99、暂停 guard、300 秒边界和系统调度；
- Room 生产数据库、管理软件接口、跨平板继续与最多 20 台通信；
- Android 真实私有目录上的断电、闪存损坏、文件锁和原子 rename 行为；
- 两款游戏代表等级、正式素材和儿童/成人可用性；
- 生产密钥的硬件/受控保管、轮换、撤销发布和现场权限。

## 复验入口

```bash
./scripts/bootstrap_vectors.sh
./scripts/test_all.sh
```

交付打包入口：

```bash
./scripts/package_delivery.sh /mnt/data
```

打包脚本还会从源码 ZIP 和 Git bundle 分别在全新目录重建、重新生成状态机和测试向量，并重跑 Python、TypeScript、Kotlin 与样例训练包测试。

# A620 Gate 0 rc3-baseline.4 测试报告

日期：2026-08-17

## 结论

当前参考实现输出：

```text
75 passed
TYPESCRIPT_GATE0_TESTS_PASS
KOTLIN_GATE0_TESTS_PASS
SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS
ALL_GATE0_IMPLEMENTATION_TESTS_PASS
```

该结论只说明本候选仓库中的规范、参考实现、测试向量和样例训练包自洽，**不等于 Gate 0 已通过，也不等于已有可安装 APK**。

## baseline.4 新增验证

### JSON 资源预算与流式 IPC

- Python、TypeScript、Kotlin 共用 A620-JRP-1 深度、节点、容器和字符串预算；
- 超深对象、超大数组、字符串总量放大、循环对象和非法 Unicode 被拒绝；
- A620-IPC-FRAME-1 支持任意拆帧与多帧粘包；随机 200 帧碎片回放保持顺序和内容；
- 一次读取包含两个约 1.2 MiB 的合法帧不会因总读取量超过单帧上限而误拒绝；
- 非规范 JSON、超长声明、超大输入块和关闭时半帧均 fail closed。

### 持久投递与重启恢复

- durable outbox 重启后继续使用第一次入队的原始 canonical bytes、`messageId` 和 `senderSeq`；
- 重试间隔、最大 pending 数和最大 pending 字节从 A620-DRP-1 生成；
- START 等复合命令必须同时收到 `COMMAND_ACCEPTED` 和最终状态确认后才完成；
- `BATCH_CLOSED` 证据在结果提交 ACK 前保持待投递，不能因 RESULT_READY 已发出而提前删除；
- 新执行替代旧执行时可显式取消旧 runtime 全部 pending 消息；
- senderSeq 复用、相同 messageId 不同内容、索引元数据篡改和非法清理被拒绝。

### 看门狗

- PREPARE/READY、命令接收、状态确认、QUERY_STATE、心跳、FINALIZING 和本地结果提交期限均有边界测试；
- 超时输出唯一中断动作，不生成正式结果；
- RUNTIME_ERROR 立即形成看门狗失败；
- A620-RWS-1.1 看门狗快照可恢复待处理 deadline 和已经形成的终止失败；
- 负时间、重复 deadline key、非法状态和不一致 failure 快照被拒绝。

### 审计链与快照迁移

- 运行消息、链条目和 anchor 同事务提交；链内容篡改、链哈希篡改、尾部截断被检测；
- baseline.3 无链数据库可执行一次回填；
- 迁移标记形成后，即使整条链被删除且 anchor 被重置，也不会再次静默回填；
- A620-RSN-1.2 reducer 快照使用消息摘要而非完整 canonical hex，并可迁移 v1.1；
- 2048 个消息指纹的最大快照仍在既定体积预算内。

### 规范生成

- 资源、IPC、重试、响应义务、证据保留、看门狗和审计链常量由同一批 normative JSON 生成到 Python、TypeScript、Kotlin；
- 生成器 `--check` 确认仓库内生成文件未过期；
- TypeScript/Kotlin 对 START 响应义务和 BATCH_CLOSED 保留规则执行镜像测试。

## baseline.3 延续验证

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
- 同一任务项目替换时 `executionAttempt` 必须提高，`runtimeSessionId` 不得复用。

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
- 指针损坏时只恢复 durable release floor 对应的最后已提交包，不提升 inactive slot 中未提交的新包。

## 代码与规范规模

最终文件数和行数由交付打包阶段重新计算并写入交付清单；该统计包含机器 Schema、生成表、测试向量和文档，不等同于纯业务代码行数。

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

打包脚本还会从源码 ZIP 和 Git bundle 分别在全新目录重建、重新生成状态机及运行配置常量，并重跑 Python、TypeScript、Kotlin 与样例训练包测试。

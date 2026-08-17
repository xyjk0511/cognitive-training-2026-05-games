# A620 Gate 0 单线施工首批测试报告

日期：2026-08-17  
候选修订：`candidateRevision=rc3`  
线上协议标识：`A620-TRC-1.1`

## 结论

```text
ALL_GATE0_IMPLEMENTATION_TESTS_PASS
```

该结论仅表示当前源码仓库中的公共协议参考实现、状态归约器、结果事务和训练包验证工具内部自洽并通过自动化测试；它不等于候选平板上的跨进程 Gate 0 已经通过，也不代表两款正式游戏已完成。

## 自动化验证结果

- Python：`30 passed`。覆盖 JSON Schema、严格 JSON 解析、JCS 子集、运行状态机、活动时钟、跨消息回显、批次证据对账、游戏专属 Schema、正式结果语义、执行结局/主控状态分离、SQLite 事务、训练包构建和归档攻击测试；
- TypeScript：`TYPESCRIPT_GATE0_TESTS_PASS`。覆盖规范化 JSON、公共 DTO、运行状态归约、非法迁移、批次账本与结果提交握手；
- Kotlin/JVM：`KOTLIN_GATE0_TESTS_PASS`。覆盖规范化 JSON、公共 DTO、主控状态归约、批次证据和提交确认；
- 训练包：`CATCH_LIGHT` 与 `SIGNAL_STATION` 两份空插件样例 `.tpkg` 完成确定性构建、Ed25519 测试签名、信任根状态、文件哈希、版本范围、releaseSequence 和真实归档安全校验；
- 总入口：`./scripts/test_all.sh` 最终输出 `ALL_GATE0_IMPLEMENTATION_TESTS_PASS`。

## 已通过的合法运行终局

1. 正常完整完成并提交；
2. 暂停、恢复后正常完成；
3. 管理端终止，形成 `ExecutionOutcome(DISCARDED)`，不形成正式结果；
4. 同一毫秒发生竞争时按 `TERMINATE > DEADLINE > PAUSE > RESUME > START` 收口；
5. 运行故障，形成 `ExecutionOutcome(INTERRUPTED)`，不形成正式结果。

## 14 组必须拒绝的运行对抗向量

- `COMMAND_ACCEPTED` 缺失；
- `READY.runtimeConfigHash` 错误；
- `STARTED` 的开始时刻或截止时刻错误；
- `RESULT_READY` 从 `RUNNING` 直接发出；
- `BATCH_CLOSED` 证据被最终结果替换；
- `ACK_RESULT_COMMITTED` 的结果哈希错误；
- 同一发送方消息时间倒退；
- `HEARTBEAT` 谎报运行状态；
- `QUERY_STATE` 没有对应快照；
- 运行配置哈希被替换；
- 暂停后的活动时间继续增长；
- 批次等级链不连续；
- `sessionHighestPresentedLevel` 被夸大；
- `HEARTBEAT.activeElapsedMs` 与活动时钟账本不一致。

以上向量均由同一参考验证器执行，不是只做 JSON 类型检查。

## 正式结果事务测试

SQLite 参考存储将以下内容放在同一事务中：

```text
batch_evidence
formal_training_result
controller_state
sync_queue
```

已验证：

- 正常提交全部写入；
- 在“正式结果插入后、同步队列插入前”注入故障时全部回滚；
- 相同 `resultId`、相同规范化内容属于幂等重放；
- 相同 `resultId`、不同内容被拒绝；
- `INTERRUPTED / DISCARDED` 只写入 `execution_outcome` 和 `controller_state`，不生成正式结果和正式同步队列。

## 训练包安全测试

真实 ZIP 归档验证覆盖：

- 绝对路径、`..`、反斜杠、NUL 与非规范路径；
- 重复 ZIP 条目和重复规范化路径；
- symlink、hardlink、device、FIFO 等非普通文件；
- 单文件/总解压尺寸、压缩率和 ZIP bomb；
- manifest 与实际文件的双向清单、尺寸和 SHA-256 对账；
- 版本范围 `minInclusive < maxExclusive`；
- `releaseSequence` 防回滚；
- `ACTIVE / NEXT / REVOKED` 信任根状态；
- JCS 投影与 Ed25519 测试签名；
- 相同输入两次构建得到字节完全一致的 `.tpkg`。

测试使用 RFC 8032 固定测试密钥，仅供自动化验证，禁止进入生产 APK 或生产发布流程。

## 代码规模

- 源文件数：88；
- 可读源码、Schema、规范、测试和文档约：18965 行。

统计排除了 `.git`、`build`、`node_modules`、编译产物和缓存目录。

## 当前明确未完成

- 这不是 Android APK；
- 尚未建立 Android Studio 应用、真实 AIDL/Binder、独立训练进程、Room 数据库和原生 `MotionEvent` 输入门；
- 尚未建立 Cocos Creator 原生工程与 Asset Bundle 加载；
- Windows 管理软件仍只有 Mock Gateway 边界；
- 两款游戏目前只有空插件 Schema 和样例训练包，尚未进入代表等级；
- 尚未在候选平板上验证 IPC 延迟、暂停 guard、帧率、内存、崩溃隔离和长时间运行；
- 未使用生产签名密钥。

## 复验入口

```bash
./scripts/bootstrap_vectors.sh
./scripts/test_all.sh
./scripts/package_delivery.sh /mnt/data
```

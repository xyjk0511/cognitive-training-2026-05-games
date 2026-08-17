# 单线施工状态

状态：`GATE_0_IMPLEMENTATION_BASELINE_RC3`

## 已完成（公共单线首批）

### 契约与版本

- 线上协议标识固定为 `A620-TRC-1.1`；
- 候选身份独立为 `candidateRevision=rc3`，不改变 wire 字节；
- 公共时钟统一为 `A620-UPTIME-MS-1`；
- 公共消息、正式结果、执行结局、主控状态和训练包 manifest 均有 Draft 2020-12 Schema；
- 两款游戏的 `gameConfig / gameMetrics / gameBatchMetrics / partialMetrics` 使用各自专属 Schema；
- 嵌入公共 Schema 的游戏专属 Schema 由同步工具生成并做漂移检查。

### 运行与结果

- 机器可执行公共状态机；
- 活动时间账本、START/PAUSE/RESUME/DEADLINE 边界和竞争优先级；
- `runtimeConfigHash` 由 PREPARE 规范投影计算，不接受游戏自报替换；
- `senderRole / senderSeq / messageId / correlationId / monotonicEpochId`；
- 重复消息幂等、同 ID 不同内容硬错误、发送时间回退检查；
- START/PAUSE/RESUME 跨消息回显校验；
- `BATCH_CLOSED` 证据账本与最终 `eligibleBatches` 精确对账；
- `RESULT_READY → Android 校验 → 本地事务 → ACK_RESULT_COMMITTED`；
- 正常、终止和故障三种合法终局；
- `FormalTrainingResult`、`ExecutionOutcome`、`ControllerStateRecord` 分离；
- 正式结果、批次证据、主控状态和待上传队列原子写入；
- 幂等提交、内容冲突拒绝和故障回滚。

### 跨语言与训练包

- Python 参考实现；
- TypeScript 公共运行内核；
- Kotlin/JVM 主控参考实现；
- A620-JCS-1 受限规范化 JSON 跨语言测试向量；
- 严格 JSON：拒绝重复键、不安全整数、浮点、非配对 surrogate；
- `.tpkg` 真实归档构建和验证；
- Ed25519 测试签名；
- `ACTIVE / NEXT / REVOKED` 信任根与 `minimumAcceptedReleaseSequence`；
- 路径、条目类型、尺寸、压缩率、哈希、版本、防回滚与确定性构建；
- 《捕光行动》和《信号反应站》空插件样例包。

## 自动化状态

```text
Python: 30 passed
TypeScript: TYPESCRIPT_GATE0_TESTS_PASS
Kotlin: KOTLIN_GATE0_TESTS_PASS
Total: ALL_GATE0_IMPLEMENTATION_TESTS_PASS
```

这表示仓库内参考实现通过，不表示实机 Gate 0 已批准。

## 下一批（Gate A）

- 创建 Android Studio 单 APK 工程；
- 锁定 Cocos Creator 精确补丁版本和 Android 构建工具链；
- 主进程与 `:training` 独立进程；
- AIDL/Binder 双向通道；
- Room 正式数据库、事务、任务槽和同步队列；
- Android `MotionEvent.getEventTime()` 原生输入门；
- Cocos 公共 Runtime、Asset Bundle Loader 和两个空 Game Plugin；
- Mock Management Gateway；
- 可视化 MockGame 完整执行开始、暂停、恢复、截止、结果提交和崩溃中断。

## 暂不施工

- 《捕光行动》L1/L28/L102/L120；
- 《信号反应站》L1/L7/L67/L79/L90/L96；
- 120/96 级全量配置；
- 生产美术与生产密钥。

Gate A 公共闭环通过后，才进入两款游戏代表等级的交错双线。

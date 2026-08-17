# A620 Gate 0 rc3-baseline.3 底座加固记录

## 裁决

baseline.2 保留为历史实现证据；baseline.3 取代它成为下一阶段唯一参考代码基线，但状态仍为 `GATE_0_IMPLEMENTATION_CANDIDATE_NOT_APPROVED`。

## 本轮关闭的高风险缺口

### 1. 消息已落库、状态未落库

旧实现可以先持久化消息去重记录，再单独写 reducer 快照。两次写入之间崩溃时，重启后消息会被识别为重放，却没有对应状态迁移。baseline.3 新增原子 `apply`：活动消息、sender cursor 和处理后的完整 reducer 快照在同一 SQLite 事务提交；故障注入证明任一失败会整体回滚。

### 2. 旧执行重放返回旧状态

活动运行切换后，旧运行中曾经为 NEW 的消息再次到达，只保留幂等审计结果，不再返回旧 reducer 快照。相同任务项目替换运行时必须提高 `executionAttempt`，且 `runtimeSessionId` 禁止复用。

### 3. reducer 快照可被任意对象冒充

持久快照现在必须是完整 `A620-RSN-1.1`，先通过 `FlowValidator.from_snapshot` 全量恢复校验，并要求内嵌身份与活动运行身份一致；读取时再次核对内容哈希、结构和存储 key。

### 4. 同毫秒暂停覆盖截止

`effectivePauseUptimeMs` 必须严格早于权威 cutoff；同毫秒固定由 DEADLINE 获胜。新增非法向量和回归测试。

### 5. wire 输入可通过空白或大对象消耗资源

在 DTO 与状态机之前按原始 UTF-8 字节限制消息；拒绝重复 key、浮点、不安全整数、非法 UTF-8 和空白膨胀。PREPARE 还增加等级与计划批次数上限。

### 6. TypeScript 哈希依赖 Node

规范化 JSON 的 SHA-256 改成纯 TypeScript 实现，测试确认源码不再导入 `node:crypto`，可供后续 Cocos 运行层复用。

### 7. DTO 与 Schema 漂移

Kotlin 消息包络改为与 wire JSON 完全相同的扁平身份字段；Python 回归测试从 Schema 提取字段集，并与 TypeScript/Kotlin 声明逐项比较。

### 8. A/B 恢复误激活未提交候选包

新训练包可能已完整写入 inactive slot，但在 active pointer 提交前断电。恢复逻辑不再选择“最高有效版本”，而只重建 durable release floor 对应的最后已提交版本；首次安装在指针提交前失败时保持无活动包。

### 9. 训练包重放与信任策略

当前活动包的精确重放只有在活动槽已按当前信任根、APK 兼容和 release floor 重新验证后才视为幂等；撤销密钥或策略变化不能被“相同文件”绕过。

## 仍未关闭

- Android Room 与 Binder 中的真实同事务/单线程归约实现；
- Cocos 进程、原生触摸门和真实帧调度；
- 候选平板上的 IPC 延迟分布、休眠、系统杀进程和闪存断电；
- 生产密钥保管、轮换审批和现场维护权限；
- 两款游戏代表等级及可用性。

# A620-TRC-1.1 rc3-baseline.4 底座加固说明

日期：2026-08-17

## 本轮目标

baseline.3 已经关闭了状态、事务、训练包和重启幂等的主要结构性缺口；baseline.4 不再扩展产品语义，而是处理真实 Android—Cocos 进程边界前最容易暴露的可靠性问题：大报文资源耗尽、流式传输拆帧/粘包、消息丢失与重发、运行卡死、审计链重建漏洞和快照体积增长。

## 1. A620-JRP-1 JSON 资源预算

新增统一的最大深度、节点数、对象成员、数组长度、字符串与键 UTF-8 字节预算。Python、TypeScript 和 Kotlin 均在规范化前执行预算，拒绝循环对象、恶意深层结构和字符串放大。预算由 normative JSON 自动生成，三端不能手工调整成不同数值。

## 2. A620-IPC-FRAME-1 流式帧

使用 4 字节无符号大端长度头和 A620-JCS-1 canonical UTF-8 payload。decoder 支持一个帧跨多次读取，以及一次读取包含多个帧；内部只保留部分头或一个已声明 payload。协议错误后实例永久失败，通道必须重建；关闭时存在半帧也视为错误。

开发中发现并修复了一个真实缺陷：初版 decoder 把整次读取先合并到保留缓冲，两个合法的大帧粘在一次读取中时，总字节超过“单帧上限”会被错误拒绝。修订后按帧顺序消费，不再把多个帧误当成一个超大帧。

## 3. A620-DRP-1 持久可靠投递

新增 SQLite durable outbox。关键命令和结果消息按原始规范化字节保存，重试不分配新的消息 ID 或发送序列。START、PAUSE、RESUME、TERMINATE 等必须等到全部规定响应义务满足才完成；`BATCH_CLOSED` 证据必须保留到最终结果事务收到 `ACK_RESULT_COMMITTED`。

pending 数量和总字节均有限制；新执行替代旧执行时旧 runtime 的 pending 消息必须显式取消，不能继续注入新执行。

## 4. A620-RWP-1 运行看门狗

READY、COMMAND_ACCEPTED、STARTED/PAUSED/RESUMED/TERMINATED、STATE_SNAPSHOT、心跳、RESULT_READY 和本地结果提交均有明确期限。到期行为唯一为 `INTERRUPT_EXECUTION_WITHOUT_FORMAL_RESULT`；看门狗不生成 RESULT_READY、ACK 或正式结果。

看门狗可输出 A620-RWS-1.1 快照并严格恢复；进程重启后未到期的 deadline 不会消失，已经形成的终止失败也不会被重新解释为正常运行。

## 5. A620-RAC-1 审计链迁移锁

运行日志、哈希链条目和链头锚点同事务提交。baseline.3 数据库在不存在任何链条记录时允许一次顺序回填；完成后写入永久迁移标记。此后无论部分链丢失、尾部截断或整条链删除，都不得再次按“旧库”静默补建。

该链用于发现事故性或低复杂度本地篡改，不替代硬件密钥、设备证明或服务端外部锚定。

## 6. A620-RSN-1.2 紧凑 reducer 快照

快照不再保存全部已见报文的 canonical hex，只保留 `messageId → SHA-256`。完整原始报文仍由持久 journal/outbox 保存。支持从 baseline.3 的 A620-RSN-1.1 快照只读迁移，并对最大 2048 个消息指纹执行体积回归测试。

## 7. 单一事实源扩大

资源预算、IPC 帧、重试间隔、响应义务、证据保留类型、看门狗超时和审计链关键常量均从 `contracts/normative` 生成到三端。生成器 `--check` 在测试中运行，手改生成文件或忘记同步规范会使构建失败。

## 明确边界

baseline.4 仍是跨语言参考实现，不是 Android 生产实现。真实 AIDL/Binder 的 parcel/pipe 选择、Room 事务、Cocos 进程生命周期、原生触摸门、候选平板 IPC 延迟和真实闪存断电仍须在 Gate A/B 与实机阶段验证。

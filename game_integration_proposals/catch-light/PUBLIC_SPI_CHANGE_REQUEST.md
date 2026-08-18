# Catch Light 公共 SPI 变更请求

## 结论

A620-TRC-1.1 wire 本身足以表达 PREPARE、START、PAUSE、RESUME、DEADLINE、BATCH_CLOSED 和 RESULT_READY，本施工线未请求修改 wire。当前不足位于共享 TypeScript 主机 SPI：`A620TrainingGameModule` 只能接收生命周期命令，缺少渲染帧/输入入口、批次证据输出和输入流取消通知。

## 最小复现

W2 的 `CatchLightGameModule` 可以实现现有接口并构建结果，但主机无法仅靠该接口完成以下动作：

1. 把某一 uptime 的触摸事件及命中实例 ID 交给游戏；
2. 推进无系统定时器的逻辑帧；
3. 在批次闭合时取得 `EligibleBatch` 并发送公共 `BATCH_CLOSED`；
4. 在暂停、截止或终止边界取消仍在进行的原生触摸流。

`minimal-repro.ts` 展示了必须向具体实现做类型下转才能完成输入和批次输出的问题。

## 建议的兼容扩展

不改变现有 `A620TrainingGameModule`，新增主机侧可选 companion interface：

```ts
interface A620InteractiveTrainingGameModule extends A620TrainingGameModule {
  advanceToUptime(uptimeMs: number): number;
  onPointerEvent(event: Readonly<TrainingPointerEvent>): void;
  onInputStreamsCancelled(reason: "PAUSE" | "DEADLINE" | "TERMINATE"): void;
  setEvidenceSink(sink: (batch: EligibleBatch) => void): void;
}
```

其中 `TrainingPointerEvent` 只携带主机 uptime、pointer ID、phase、坐标和可选命中 token；游戏继续使用 Android 提供的 uptime，不读取系统时钟。`setEvidenceSink` 只把已经符合公共 payload 的批次交给平台封装消息，不引入新 wire 字段。

## W2 临时兼容方式

- `CatchLightGameModule` 暴露本地 `advanceToUptime`、`touchInstanceAtUptime`、`touchBlankAtUptime`。
- 构造函数接收 `onBatchClosed` hook，headless harness 验证该证据与最终结果哈希一致；本地适配器在所有可变入口前拒绝 hook 同步回入。
- Cocos 接入层后续可做一次类型守卫并适配上述方法；共享文件保持不变。

## 另一个低优先级请求

`PrepareContext.gameConfig` 当前仅为 `Readonly<Record<string, unknown>>`。建议未来以 gameCode 为判别键提供泛型注册表，但不应把 Catch Light 私有类型写入共享 wire 或 `contracts/**`。

此外，现有 `PrepareContext` 只给游戏 `runtimeConfigHash` 的结果值，没有“平台已经按公共 canonical 投影验证过”的显式证明位，也没有完整 PREPARE 投影供游戏自行重算。W2 不因此改 wire：平台 flow validator 继续作为权威，游戏校验 64 位小写十六进制格式并在结果中原样回传。后续若要收紧主机 SPI，可在本地调用上下文增加只读 `runtimeConfigHashVerified: true`，但不得把该主机内部证明位写入 A620-TRC-1.1 消息。

## BATCH_CLOSED sink 的交付语义建议

W2 本地适配采用“批次领域状态先提交，外部通知失败可重试”的有序 at-least-once 语义。公共 companion interface 若增加 evidence sink，应同时冻结以下约束：

- sink 每次接收递归不可变的完整 `EligibleBatch`；
- sink 失败不得要求游戏回滚或重新关闭批次；
- 重试必须保留相同 `batchPayloadSha256` 和完整内容；
- 主机按 `batchPayloadSha256` 幂等去重；
- sink 回调不得同步重入游戏生命周期或输入方法；
- 如果主机需要 exactly-once 可见效果，应在主机持久层实现 ACK/去重，不应修改 A620-TRC-1.1 wire 或让游戏伪造确认状态。

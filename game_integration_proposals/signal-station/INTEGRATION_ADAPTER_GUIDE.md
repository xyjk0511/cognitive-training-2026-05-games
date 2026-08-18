# 《信号反应站》兼容适配建议

平台装配层可按 `gameCode === "SIGNAL_STATION"` 实例化 `SignalStationTrainingGameModule`，并把 PREPARE 中的完整 `gameConfig`、canonical `runtimeConfigHash`、`sessionSeed`、`sessionStartLevel` 和 300000 ms 时长原样传入。

生命周期映射：

- START 调用 `onStart(effectiveStartUptimeMs, cutoffUptimeMs)`；
- PAUSE 调用 `onPause(effectivePauseUptimeMs)`；
- RESUME 调用 `onResume(resumeInputEnabledUptimeMs, cutoffUptimeMs)`；
- 正常截止调用 `onDeadline(cutoffUptimeMs)`，随后读取 `buildResultDraft()`；
- 终止调用 `onTerminate(reason)`，终止态不生成正式结果草稿；
- 渲染层通过 `currentPlan()` 读取当前批次的目标卡、波次、实例 ID、格位和逻辑时序；
- 指针按下通过 `onPointerDown(instanceId, pointerEventId, sourceUptimeMs)` 注入；
- 每次推进后可调用 `drainBatchClosedDrafts()` 获取尚未发送的闭合批次草稿。

适配器只接受冻结六级配置。完整 96 级解锁前，平台不应把未实现等级作为本游戏的 sessionStartLevel。

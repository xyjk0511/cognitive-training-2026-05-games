# 《信号反应站》兼容适配建议

平台装配层可按 `gameCode === "SIGNAL_STATION"` 实例化 `SignalStationTrainingGameModule`，并把 PREPARE 中的完整 `gameConfig`、canonical `runtimeConfigHash`、`sessionSeed`、`sessionStartLevel` 和 300000 ms 时长原样传入。

训练包内容修订号为 `1.2.1-r2`，但 PREPARE 中声明的配置 Schema ID 必须保持 `urn:a620:signal-station:config:1.2.1`。这是冻结公共校验器的兼容身份，不应替换成带 `-r2` 的 ID。`tools/signal-station/verify_schema_assets.py` 已把训练包索引中的 Schema 声明送入公共 `validate_game_config` 做端到端校验。

生命周期映射：

- START 调用 `onStart(effectiveStartUptimeMs, cutoffUptimeMs)`；
- PAUSE 调用 `onPause(effectivePauseUptimeMs)`；
- RESUME 调用 `onResume(resumeInputEnabledUptimeMs, cutoffUptimeMs)`；
- 正常截止调用 `onDeadline(cutoffUptimeMs)`，随后读取 `buildResultDraft()`；
- 终止调用 `onTerminate(reason)`；公共状态机允许的准备期、运行期、暂停期及正常截止后待提交阶段均可终止，终止态不生成正式结果草稿；
- 渲染层通过 `currentPlan()` 读取当前批次的目标卡、波次、实例 ID、格位和逻辑时序；
- 指针按下通过 `onPointerDown(instanceId, pointerEventId, sourceUptimeMs)` 注入；
- 每次推进后可调用 `drainBatchClosedDrafts()` 获取尚未发送的闭合批次草稿。

适配器只接受冻结六级配置。完整 96 级解锁前，平台不得把未实现等级作为本游戏的 `sessionStartLevel`。

若一个已实现代表级在批次结算后迁移到未实现等级，游戏本地适配器采用 fail-closed 策略：

1. 已闭合批次照常生成草稿并保留真实等级迁移；
2. 不自动生成或呈现未实现等级的下一批；
3. `coverageBlock()` 返回 `LEVEL_NOT_IMPLEMENTED`、被阻断等级和发生批次；
4. `buildResultDraft().gameMetrics` 写入同一组覆盖阻断审计字段；
5. 不抛未捕获异常，不回退到最近代表级，也不改写公共事件。

平台可把该状态视为当前训练包覆盖不足，并在测试/内测界面显示明确诊断。正式完整 96 级包发布前，不应让产品任务配置触发这一状态。

`drainBatchClosedDrafts()` 与 `buildResultDraft()` 返回的是不可变证据副本。平台应把它们视为只读值；不得尝试复用对象并原地补字段。Android 派生质量标志仍由平台侧在公共流程中生成。

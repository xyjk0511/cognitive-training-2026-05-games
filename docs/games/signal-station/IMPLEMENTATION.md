# 《信号反应站》W3 实现说明

## 判定源

所有正式判定只读取外部注入的 active time。`DeterministicActiveClock` 不读取操作系统时间；暂停期间 active time 不增长。信号实例在 `[enterStartActiveMs, naturalExitEndActiveMs)` 内可点击，正好位于自然结束时刻的输入无效。×2 的第二击窗口同样采用半开边界。

生成器使用 `generatorVersion + sessionSeed + level + batchOrdinal + waveOrdinal + scope` 派生确定性子流。`scope` 仅用于把目标卡、布局和波内容分流；同一正式键始终生成相同结果。布局选择显式限制每波对象数、目标数、干扰数、×2 数、格位复用和全批象限平衡，约束无法满足时抛出错误。

## 计分隔离

批次结果仅由 H、T、F、D 和冻结阈值决定。反应时间、二击间隔、暂停次数及暂停时长均为审计字段。测试以相同 seed 和相同 H/F、不同反应延迟运行两次，要求 `batchScore`、`resultZone` 和 `levelTransition` 完全相同，同时反应时间审计值不同。

## 结果与公共边界

游戏本地适配器实现现有 `A620TrainingGameModule`，不修改共享 `typescript/src/game-plugin.ts`。正常截止可输出 0、1、7 或 8 个 eligible batch；最多一条未闭合批次审计。批次哈希使用公共 canonical JSON 算法。游戏草稿不生成 Android 派生质量标志。

适配器只接受与冻结六级配置 canonical hash 完全一致的 `gameConfig`。继承的 baseline.8 公共协议向量仍携带空对象，因此 `game_config`、`partial_metrics` 和 `game_metrics` Schema 各保留一个仅用于继承向量的空对象兼容分支；实际游戏适配器拒绝该空配置。`game_batch_metrics` 不保留空对象分支。

## 当前限制

完整 96 级配置没有导入，状态保持 `HOLD`。六个代表级之外的等级会显式报未实现。Cocos 场景、生产素材、音频、Android 接线、设备性能、真实触控和患者环境均不在本次验证范围内。

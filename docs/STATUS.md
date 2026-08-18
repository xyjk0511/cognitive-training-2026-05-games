# 集成候选状态

候选状态：`AVAILABLE_VERTICAL_SLICES_PLAYABLE_END_TO_END_NOT_DEVICE_APPROVED`

## 已完成

- A620-TRC-1.1 公共契约与 Python/TypeScript/Kotlin 参考实现；
- baseline.5–8 的并发、fencing、boot epoch、canonical/PFD、AIDL 通道认证和 SQLite v4 结果事务；
- 《捕光行动》四个代表级和《信号反应站》六个代表级 TypeScript 领域模块；
- Android 单入口任务选择页和独立 `:training` 训练页；
- 本地 WebView bundle 到真实游戏模块的触摸、计时、暂停/继续/截止接入；
- Controller→Binder→训练模块→`BATCH_CLOSED`/`RESULT_READY`→SQLite→ACK 完整路径；
- 前台主控 service，确保训练页位于独立进程时权威 300 秒 deadline 仍可调度；
- API 36 Pixel Tablet 模拟器上的 Debug APK 构建、单测、lint、安装和两款游戏完整 300 秒会话。

## 当前证据

- 两款游戏各产生 8 条 ordinal 1–8 批次证据；
- 两款游戏均提交 1 条正式结果；
- 两个 ACK outbox 均为 `ACKED / attempt_count=1`；
- Controller 状态均为 `COMPLETE / PENDING_UPLOAD`；
- SQLite `quick_check=ok`、schema version 4；
- 最终 APK smoke 未发现 `FATAL EXCEPTION`。

详细证据见交付目录：
`delivery/A620_GAME_INTEGRATION_VALIDATION_REPORT_20260818.md`。

## 仍不得声称

- 完整 L1–L120《捕光行动》或 L1–L96《信号反应站》；
- Cocos Creator 原生场景、生产水果素材、音频、动画或正式内容批准；
- Room 生产接入或后台上传完成；
- 候选真实平板、生产签名、进程回收、断电恢复、性能/热量/内存验证；
- Gate A/B、生产发布或患者任务批准。

## 下一步

1. 补齐全等级冻结配置和正式素材；
2. 如产品仍要求 Cocos，提供并接入 Cocos Creator 原生工程，保持现有 companion SPI；
3. 在候选平板验证 Binder/PFD 大载荷、进程死亡、断电恢复和完整性能指标；
4. 接入受控上传端并验证 `PENDING_UPLOAD` 生命周期；
5. 使用生产签名重新执行发布 Gate。

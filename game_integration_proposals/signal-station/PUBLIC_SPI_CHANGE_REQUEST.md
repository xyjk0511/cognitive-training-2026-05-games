# 公共 SPI 变更请求

无。

现有 A620-TRC-1.1 SPI 足以承载本次六级垂直切片；共享 `typescript/src/game-plugin.ts` 未修改。

代表级迁移到未施工等级时，适配器使用游戏本地 `coverageBlock()` 状态及 `game_metrics` 审计字段 fail closed，不需要新增或恢复公共事件。最小兼容路径位于 `typescript/src/games/signal-station/adapter/training-game-module.ts`，集成说明见同目录 `INTEGRATION_ADAPTER_GUIDE.md`。

兼容约束：训练包可以使用 `1.2.1-r2` 内容身份，但配置 Schema `$id` 必须继续使用公共冻结值 `urn:a620:signal-station:config:1.2.1`。本地资产验证器已调用 baseline.8 公共 `validate_game_config` 作为最小复现和回归门；因此这里不提出 SPI 或 Schema 身份升级请求。

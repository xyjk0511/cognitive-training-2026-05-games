# 测试覆盖

`typescript/src/test/signal-station/run-tests.ts` 覆盖 A/C/H 时序边界、×2 首击/二击/其他实例/第三击/超时/暂停冻结、四种模板整数边界、反应时间计分隔离、六级固定 seed、象限和连续格位约束、L90 密度上限、0/1/7/8 eligible batch、部分批次审计、L96 `HOLD_MAX`、公共 SPI 本地适配和配置严格绑定。

`tools/signal-station/verify_schema_assets.py` 覆盖四份 Schema、公共结果外层、game-specific validator、canonical hash、六个 golden vectors 和 package/source 资产一致性。

# 需求—实现—证据追踪

| 冻结要求 | 实现位置 | 自动证据 |
|---|---|---|
| 300000ms、8×37500ms、3s/30s/2s/2.5s | `types.ts`, `batch-engine.ts`, `session-engine.ts` | 8 批精确在 300000ms 闭合；0/1/7/8 场景 |
| A/C/H 生命周期 3300/3200/3100ms | `config.ts`, `object-machine.ts` | 配置和 Schema 生命周期求和、最后波尾缓冲检查 |
| 暂停和恢复倒计时冻结 active 时间 | `logical-clock.ts`, `adapter.ts` | 双光圈暂停边界、暂停输入屏蔽、暂停次数/墙钟时长测试 |
| 半开输入窗口 | `object-machine.ts`, `session-engine.ts` | 实例起点/截止，以及会话 299999/300000/300001ms 测试 |
| 控制器 cutoff 权威 | `logical-clock.ts`, `adapter.ts` | 先观察晚帧、后接收 DEADLINE 仍精确结算 300000ms |
| 重复、多指、同毫秒不同对象 | `object-machine.ts`, `batch-engine.ts` | 同对象同毫秒抑制；不同对象同毫秒 H/F 均生效 |
| 双光圈第一、第二、第三击和超时 | `object-machine.ts` | 第一击不加 H、二击完成、第三击忽略、精确截止失败；超时自然退场且不播放命中反馈 |
| 固定 seed 算法 | `prng.ts`, `generator.ts` | FNV/xorshift 已知向量、五级固定 SHA-256 |
| 12 水果、三池、四网格 | `assets.ts` | 唯一性、池覆盖、格位数和冻结 56dp 最小命中区测试 |
| 同屏上限和 L120=5 | `generator.ts` | 所有 Golden 波次 cap 检查，L120 峰值 5 |
| L102 波1无双光圈 | `generator.ts` | `SEP_NO_W1` 与非连续双光圈测试 |
| L120 双光圈6、MAX3_CONSEC | `generator.ts` | 数量和最长连续波测试 |
| H/T/F/D 三态与整数边界 | `scoring.ts` | D=0/5/10、80%/70%、F 边界测试 |
| RoundHalfUp | `scoring.ts` | 1/2、1/3、2/3 与产品示例得分 |
| 首败重试、二败降级、上下限 | `scoring.ts`, `session-engine.ts` | RETRY/DOWN/HOLD_MIN/HOLD_MAX 测试 |
| 未闭合批次不计分/不迁级 | `session-engine.ts`, `batch-engine.ts` | 0/1/7 场景审计存在但 raw score 只汇总 eligible；未呈现目标不计 unresolved |
| 正式游戏 Schema | `games/catch-light/schemas/` | JSON Schema + Python 跨字段校验；批次身份字段、会话 H/T/F/D 与暂停审计 |
| Excel 审核源与运行 JSON 可追溯 | `config.ts`, 生成配置, `content/bundle/index.json` | 工作簿/需求书/公共规则 SHA-256、编译配置 canonical SHA-256、配置漂移拒绝测试 |
| 训练包声明版本及 runtimeConfigHash 责任 | `manifest.base.json`, `content/bundle/index.json` | generator/scoring/result/schema 版本一致；会话级 PREPARE 哈希算法和权威来源校验 |
| BATCH_CLOSED 证据一致 | `session-engine.ts`, headless hook | emitted hash 与结果 eligibleBatches 一致 |
| 公共 wire 禁止修改 | 本地 adapter + SPI proposal | scope verifier |

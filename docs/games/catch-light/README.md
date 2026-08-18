# 《捕光行动》W2 四级垂直切片

本目录记录 W2 在 `A620-TRC-1.1 / rc3-baseline.8` 上完成的实现边界。代码位于 `typescript/src/games/catch-light/`，不依赖 Cocos Creator、系统时钟或系统定时器即可完成规则验证。

## 已实现

- 纯 TypeScript 领域模型：活动逻辑时钟、批次/会话、对象状态机、双光圈、计数、积分和等级迁移。
- 固定 seed 生成链：UTF-8 FNV-1a32 → xorshift32 → Fisher–Yates。
- 12 种水果、`FP_CORE_A`、`FP_CORE_B`、`FP_TRANSFER`、四种网格及最小命中区元数据。
- L1、L28、L102、L120 headless 垂直切片；L67 作为中段 Golden Vector 锚点。
- 300000ms 会话、8×37500ms 批次、0/1/7/8 个 eligible batch 截止边界，以及 `299999/300000/300001ms` 半开输入边界。
- 正式 `game_config`、`game_batch_metrics`、`game_metrics`、`partial_metrics` Schema；批次携带难度、时序、内容、波次和 seed 标识，会话携带 H/T/F/D 聚合及暂停审计。
- 离线编译产物记录原 v1.4 数值工作簿、v1.5 需求书和公共 v1.3 的 SHA-256；包索引同时声明正式 Schema/生成器/计分/结果版本、编译配置 canonical SHA-256 和会话级 `runtimeConfigHash` 计算责任。
- `parseStrictGameConfig` 除 Schema/跨字段检查外还校验冻结编译配置的 canonical SHA-256，拒绝结构合法但目录、阈值、时序或来源信息漂移的运行 JSON。
- 代表级完整 Golden Vector、headless 结果证据、跨字段 Python 验证器。
- `CatchLightGameModule` 本地适配器，实现冻结的 `A620TrainingGameModule`，未修改共享 `game-plugin.ts`。

## 目录

- `typescript/src/games/catch-light/`：领域实现与公共导出。
- `typescript/src/test/catch-light/`：边界、生成器、状态机、会话和适配器测试。
- `games/catch-light/configs/vertical-slices/`：W2 配置集。
- `games/catch-light/golden-vectors/`：固定 QA seed 生成结果。
- `games/catch-light/schemas/`：正式游戏 Schema；仅为继承 Gate 0 向量保留受限旧分支。
- `packages/catch-light/content/`：训练包中的配置、Golden Vector 和原工作包提供的 8 张背景。
- `tools/catch-light/`：Schema/配置/Golden/结果证据生成与校验。
- `game_integration_proposals/catch-light/`：公共 SPI 不足的变更请求和兼容建议。

## 验证

```bash
./scripts/test_catch_light.sh
./scripts/test_all.sh
python3 /path/to/workpack/TOOLS/verify_scope.py \
  --repo . \
  --contract /path/to/workpack/TASK_CONTRACT.json \
  --branch chatgpt/parallel-catch-light-vertical-slices
```

`test_catch_light.sh` 会执行领域目录禁用源扫描、TypeScript 编译与测试、生成物新鲜度检查、JSON Schema 和跨字段语义验证。

当前编译配置明确把 `捕光行动-120级数值设计-v1.4.xlsx` 标为 `HISTORICAL_NUMERIC_INPUT_ONLY`。冲突裁决仍以 v1.5 需求书和公共 v1.3 为准，不把旧表提升为新的产品规则。

## 明确边界

W2 没有导入 L1–L120 全量数值表，也没有实现 Cocos 场景、HUD、触控节点、音频、动画和水果正式美术。缺失等级会直接拒绝，不会映射到最近代表级。8 张背景来自自包含工作包；水果路径是待 Cocos 资产线补齐的冻结引用。未进行 Android/Cocos 实机或性能验证。

# 《信号反应站》W3 六级垂直切片

本目录保存游戏专属 Schema、冻结运行配置和 golden vectors。可执行 TypeScript 源码位于 `typescript/src/games/signal-station/`；测试位于 `typescript/src/test/signal-station/`。领域模型不依赖 Cocos、Tween、帧数、系统随机数或系统时钟。

第二轮修订身份为：生成器 `signal-station-gen-1.2.1-r2`、内容 `signal-station-six-slice-1.2.1-r2`、训练包 `1.2.1-r2`。Schema `$id` 仍使用冻结公共身份 `1.2.1`，用于兼容 baseline.8 的公共 PREPARE 校验器；内容修订号不得替换公共 Schema 身份。

## 已实现范围

实现等级为 L1、L7、L67、L79、L90、L96。每个等级包含固定配置、确定性信号生成、8 波布局、目标/干扰符号、普通目标与 ×2 状态机、批次积分和固定 seed golden vector。L96 达到升区时使用 `HOLD_MAX`。

正式时间轴为每局 300000 ms、每批 37500 ms、每批 8 波。输入窗口采用半开区间；暂停只冻结外部驱动的 active time。反应时间及二击间隔只进入审计指标，不参与积分、结果区或等级迁移。输入事件 ID 在会话内全局幂等，跨批重放不会重复计分。

冻结配置和正式结果在运行时进行 fail-closed 校验。JSON Schema 与资产验证器同时检查结构和跨字段守恒，不把结构合法但语义矛盾的载荷判为通过。正式结果证据以不可变副本导出，调用方不能通过保留引用修改已结算证据。

## 目录映射

- `configs/vertical-slices/runtime-config.json`：六级冻结运行配置。
- `schemas/`：正式游戏专属 Schema。
- `golden-vectors/vertical-slices.json`：六个固定 seed 的代表级结果向量，以及 L1→L2、L96→L95 两个覆盖阻断向量。
- `typescript/src/games/signal-station/domain/`：逻辑时钟、实例、批次和会话模型。
- `typescript/src/games/signal-station/generator/`：PRNG、符号和布局生成器。
- `typescript/src/games/signal-station/scoring/`：四种 T/D 模板的整数判定和 RoundHalfUp 积分。
- `typescript/src/games/signal-station/adapter/`：headless harness 与现有公共 SPI 的游戏本地适配器。
- `docs/games/signal-station/REQUIREMENT_TRACEABILITY.md`：v1.2.1 需求锚点、实现位置、自动证据和第二轮加固记录。

## 验证

从仓库根目录运行：

```bash
./scripts/test_signal_station.sh
```

该命令编译 TypeScript、运行领域/适配器测试、执行 12,288 个批次计划的多 seed 生成器压力测试、重生成并比较配置与 golden vectors、验证四份 Schema 及语义不变量、将配置 Schema 送入冻结公共校验器做 PREPARE 兼容检查、构建并校验训练包，并扫描系统时间、系统随机、异步定时器和已废止公共事件。

## 明确边界

本施工线只实现六个代表级，完整 96 级配置仍为 `HOLD`。从代表级迁移到未实现的相邻等级后，适配器会停止开启下一批并写入 `LEVEL_NOT_IMPLEMENTED` 覆盖阻断审计，而不是崩溃或静默套用近似配置。视觉素材仍是占位或历史参考，没有制作生产美术。后续 W0 已在 API 36 模拟器完成 Android WebView/Binder 全会话接入，但没有进行候选真实设备、临床环境或患者验证。

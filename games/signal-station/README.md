# 《信号反应站》W3 六级垂直切片

本目录保存游戏专属 Schema、冻结运行配置和 golden vectors。可执行 TypeScript 源码位于 `typescript/src/games/signal-station/`；测试位于 `typescript/src/test/signal-station/`。领域模型不依赖 Cocos、Tween、帧数、系统随机数或系统时钟。

## 已实现范围

实现等级为 L1、L7、L67、L79、L90、L96。每个等级包含固定配置、确定性信号生成、8 波布局、目标/干扰符号、普通目标与 ×2 状态机、批次积分和固定 seed golden vector。L96 达到升区时使用 `HOLD_MAX`。

正式时间轴为每局 300000 ms、每批 37500 ms、每批 8 波。输入窗口采用半开区间；暂停只冻结外部驱动的 active time。反应时间及二击间隔只进入审计指标，不参与积分、结果区或等级迁移。

## 目录映射

- `configs/vertical-slices/runtime-config.json`：六级冻结运行配置。
- `schemas/`：正式游戏专属 Schema。
- `golden-vectors/vertical-slices.json`：六个固定 seed 的计划、批次结果和结果草稿。
- `typescript/src/games/signal-station/domain/`：逻辑时钟、实例、批次和会话模型。
- `typescript/src/games/signal-station/generator/`：PRNG、符号和布局生成器。
- `typescript/src/games/signal-station/scoring/`：四种 T/D 模板的整数判定和 RoundHalfUp 积分。
- `typescript/src/games/signal-station/adapter/`：headless harness 与现有公共 SPI 的游戏本地适配器。

## 验证

从仓库根目录运行：

```bash
./scripts/test_signal_station.sh
```

该命令编译 TypeScript、运行领域/适配器测试、重生成并比较配置与 golden vectors、验证四份 Schema、构建并校验训练包，并执行禁止模式扫描。

## 明确边界

本施工线只实现六个代表级，完整 96 级配置仍为 `HOLD`。从代表级迁移到未实现的相邻等级后，下一批会显式拒绝启动，而不是静默套用近似配置。视觉素材仍是占位或历史参考，没有制作生产美术，也没有进行 Android 实机、临床环境或患者验证。

# A620 Cognitive Training Platform — Android game-integration candidate

状态：`AVAILABLE_VERTICAL_SLICES_PLAYABLE_END_TO_END_NOT_DEVICE_APPROVED`

本仓库保持一个 A620 主 APK、一个患者入口和两个受控训练模块。公共 wire 仍为
`A620-TRC-1.1`；`contracts/**` 没有因游戏接入而改变。

## 当前可运行能力

- Android 首页可选择《捕光行动》和《信号反应站》；
- 主进程持有 `PersistentPlatformController`、SQLite schema v4 和权威 300 秒截止；
- 游戏页面与 `TrainingRuntimeService` 位于独立 `:training` 进程；
- 主控与训练侧通过同 UID、token、generation 鉴权的 AIDL/Binder 通道通信；
- 游戏运行时采用无网络权限的本地 WebView bundle，执行现有 TypeScript 游戏模块；
- 支持触摸、暂停、继续、主动结束、8 批证据、正式结果事务和 ACK outbox；
- 主进程训练期间由非导出的 foreground controller service 保持可调度，避免独立训练页面在前台时权威 DEADLINE 被系统冻结；
- API 36 模拟器已分别完成两款游戏的 300000 ms / 8 批完整会话，结果均提交为 `COMPLETE`。

数据流：

```text
MainActivity
→ PersistentPlatformController
→ authenticated AIDL/Binder
→ :training TrainingRuntimeService + TrainingActivity
→ CatchLightGameModule / SignalStationTrainingGameModule
→ BATCH_CLOSED / RESULT_READY
→ AndroidControllerStore transaction
→ ACK_RESULT_COMMITTED
```

## 构建与验证

```bash
cd typescript
npm ci
npm test
npm run build:android-training
cd ..

./scripts/build_android_gateab.sh
```

Android 构建入口执行 `assembleDebug`、`testDebugUnitTest` 和 `lintDebug`，要求锁定的
Gradle 9.5.0、AGP 9.3.1、JDK 17+、Android platform/build-tools 36。

接入结构回归：

```bash
python -m pytest gateab_runtime_shell/python/tests/test_android_scaffold.py -q
```

当前原生 Windows 环境运行整仓 `scripts/test_all.sh` 仍会触发既有 Unix 假设：
Python `fcntl` 和把 Windows 盘符直接用于 Node ESM import 的生成物脚本。应在 Linux/WSL
运行完整聚合脚本；Android SDK build/lint、游戏 TypeScript 测试和接入测试可分别运行。

## 已实现游戏范围

- 《捕光行动》：L1、L28、L102、L120 代表级；L67 是 golden anchor；
- 《信号反应站》：L1、L7、L67、L79、L90、L96 代表级。

未实现等级会 fail closed，不会套用最近代表级。当前 Android 渲染属于工程验证 UI：
水果使用 emoji/占位表现，信号使用程序化轮廓；不是生产美术或 Cocos Creator 原生场景。

## 必须准确理解

- 持久化核心仍直接使用 `SQLiteOpenHelper` 保证跨表事务，不应描述为 Room 生产层；
- 当前没有后台上传实现，正式结果进入本机 `PENDING_UPLOAD`；
- 尚未提供完整 L1–L120 / L1–L96 数值、正式水果 sprites、CORE_B 产品批准、音频和生产动画；
- 尚未验证候选真实平板、生产签名、进程回收/断电恢复、性能、热量、内存和临床环境；
- WebView 运行容器不是尚未提供的 Cocos Creator 原生工程。

该候选是可玩的端到端工程验证版，不能用于患者任务，也不构成 Gate A/B 或生产批准。

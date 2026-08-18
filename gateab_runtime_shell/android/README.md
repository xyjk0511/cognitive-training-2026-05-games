# A620 Android playable game-integration candidate

该模块构建单一 `com.a620.tablet` APK，公共 wire 保持 `A620-TRC-1.1`。

## 组件

- `MainActivity`：唯一 exported launcher，提供两款游戏任务选择；
- `A620Application` / `PersistentPlatformController`：主进程 SQLite v4 和单活动 execution 所有者；
- `ControllerKeepAliveService`：训练期间保持主进程权威 deadline scheduler 可调度；
- `TrainingRuntimeService`：非导出 AIDL 服务，运行在 `:training`；
- `TrainingActivity`：非导出本地 WebView 游戏页面，同样运行在 `:training`；
- `InteractiveTrainingRuntime`：把 canonical Controller 命令转给真实 TypeScript 游戏模块，并把游戏证据重新封装成受控 runtime events；
- `AndroidControllerStore`：保存运行身份、事件、批次证据、正式结果、同步队列、ACK outbox 和 Controller 状态。

训练 WebView 只加载 `file:///android_asset/training/`，WebViewClient 拒绝其他 scheme/path，
manifest 不声明 INTERNET 权限。构建会把两款冻结配置和 Catch Light 背景复制到 APK assets，
并验证 `training-runtime.bundle.js` 已生成。

## 运行链路

```text
任务选择
→ PREPARE / authenticated Binder
→ :training WebView game module
→ pointer + injected Android uptime
→ BATCH_CLOSED
→ DEADLINE / RESULT_READY
→ SQLite one-transaction formal commit
→ ACK_RESULT_COMMITTED
```

小于等于 49,152 bytes 的 canonical 消息使用 inline；更大消息使用受限
`ParcelFileDescriptor` pipe。每次 AIDL 调用和回调都带内部 token/generation，异步解析前后重新 fencing。

## 构建

```bash
cd ../../typescript
npm ci
npm run build:android-training
cd ../gateab_runtime_shell/android

../../scripts/build_android_gateab.sh
```

正式入口要求 Gradle 9.5.0、AGP 9.3.1、JDK 17+、Android platform/build-tools 36，
并执行 `assembleDebug`、`testDebugUnitTest`、`lintDebug`。

## 已验证与限制

API 36 Pixel Tablet 模拟器已经分别完成两款游戏的 300000 ms / 8 批完整会话，
包括正式结果事务和 ACK。该证据仍不等同于候选真实平板、Cocos、生产签名、
进程回收/断电恢复、性能或患者环境批准。

Android 页面运行的是仓库现有代表级 TypeScript 模块，不是完整全等级内容：Catch Light
只有四个代表级，Signal Station 只有六个代表级。视觉层仍是工程验证 UI，不是生产美术。

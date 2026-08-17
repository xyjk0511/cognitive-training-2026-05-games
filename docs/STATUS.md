# 单线施工状态

## 已完成（本批）

- 公共协议标识与候选元数据分离；
- 公共时钟改为 `A620-UPTIME-MS-1`；
- typed JSON Schema；
- 可执行状态机；
- 命令关联、发送方独立序列、幂等和时钟回退检查；
- START/PAUSE/RESUME 跨消息回显校验；
- `BATCH_CLOSED` 证据账本；
- `RESULT_READY → ACK_RESULT_COMMITTED` 参考闭环；
- 正常、终止和故障三种终局；
- 规范化 JSON 的 Python/TypeScript/Kotlin 子集实现；
- `.tpkg` 真实归档验证；
- 两款游戏空插件和示例包。

## 下一批（Gate A）

- Android Studio 工程与单 APK；
- Cocos Creator 精确版本锁定；
- AIDL/Binder 双向通道；
- 独立训练进程；
- Android `MotionEvent.getEventTime()` 原生输入门；
- Room 事务保存与同步队列；
- MockGame 可视化 300 秒逻辑会话。

## 暂不施工

- 《捕光行动》L1/L28/L102/L120；
- 《信号反应站》L1/L7/L67/L79/L90/L96；
- 120/96 级全量配置；
- 生产美术与生产密钥。

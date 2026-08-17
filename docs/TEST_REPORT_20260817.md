# A620 Gate 0 单线施工首批测试报告

日期：2026-08-17

## 结论

参考实现当前输出：

```text
34 passed
TYPESCRIPT_GATE0_TESTS_PASS
KOTLIN_GATE0_TESTS_PASS
SAMPLE_TPKG_BUILD_AND_VALIDATE_PASS
ALL_GATE0_IMPLEMENTATION_TESTS_PASS
```

该结论只说明本候选仓库中的参考实现和测试向量自洽，**不等于 Gate 0 已通过，也不等于已有可安装 APK**。

## 已验证

- Python：34 项结构、语义、状态机、游戏专属字段、批次证据、SQLite 事务和训练包安全测试通过；
- TypeScript：规范化 JSON、由规范生成的公共状态机及非法迁移测试通过；
- Kotlin/JVM：规范化 JSON、由规范生成的状态机、非法迁移和批次账本测试通过；
- `.tpkg`：两份空插件样例包完成确定性构建、Ed25519 签名、文件哈希和真实归档验证；
- 正常完成、暂停后完成、管理端终止、同毫秒终止优先和运行故障均有合法终局；
- 缺少 `COMMAND_ACCEPTED`、READY/STARTED 回显错误、运行中直接 `RESULT_READY`、批次替换、等级链篡改、ACK 哈希错误、发送时钟倒退、活动时间谎报和 QUERY_STATE 无响应均被拒绝；
- 密钥 `ACTIVE/NEXT/REVOKED`、releaseSequence 防回滚、APK 版本范围、请求游戏身份、路径穿越、重复 ZIP entry、软链接、高压缩比和内容篡改均有回归测试；
- 正式结果重试返回第一次事务提交时间，不会因为 ACK 丢失时使用了新的重试时间而生成冲突；
- 正式结果中不能混入 `syncState` 或 `taskSlotState`，中断/作废执行不能产生正式结果。
- 发布脚本会分别从源码 ZIP 与 Git bundle 在全新临时目录重建并重跑全部测试，防止交付包遗漏文件、丢失脚本执行权限或只在原工作区可用。

## 代码与规范规模

在排除 `.git`、构建产物、缓存和第三方依赖后：

- 文本源码、规范、Schema、测试向量和文档：92 个文件；
- 总计约 19,335 行。

该行数包含机器 Schema 和测试向量，不等同于纯业务代码行数。

## 尚未验证

- Android APK、AIDL/Binder 和 Android 生命周期；
- Cocos Creator、Asset Bundle、真实触摸事件与渲染帧；
- 候选平板上的 IPC P95/P99、暂停 guard 和 300 秒边界；
- Room、生产同步队列、管理软件接口与跨平板继续；
- 训练包 A/B 槽原子激活和断电恢复；
- 两款游戏代表等级、正式素材和完整可用性；
- 生产密钥管理、轮换、撤销发布和现场维护流程。

## 复验入口

```bash
./scripts/bootstrap_vectors.sh
./scripts/test_all.sh
```

交付打包入口：

```bash
./scripts/package_delivery.sh /mnt/data
```

# A620 Cognitive Training Platform — Gate 0 单线施工基线

状态：`GATE_0_IMPLEMENTATION_BASELINE_RC3`

本仓库是从零建立的公共平台首批代码，不包含《捕光行动》120 级或《信号反应站》96 级的全量实现。当前范围严格限定为：

- A620-TRC-1.1 公共运行消息与状态机；
- A620-UPTIME-MS-1 毫秒单调时钟；
- Python 参考验证器；
- TypeScript 公共运行内核；
- Kotlin/JVM 主控参考实现；
- 批次证据账本与正式结果提交握手；
- 真实 `.tpkg` 构建和安全验证；
- 两个游戏的空插件与示例训练包。

## 为什么先做公共线

产品边界要求一个主 APK、一个入口；训练包不能绕过 Android 总控形成正式结果。公共层未冻结前，不允许两款游戏各写一套计时、暂停、结果或训练包逻辑。

## 一键验证

```bash
./scripts/test_all.sh
```

验证内容：

1. JSON Schema 与 Python 语义测试；
2. 正常完成、终止、故障三类流程；
3. 缺失 ACK、错误回显、错误状态、批次替换等对抗样例；
4. TypeScript 编译和状态机测试；
5. Kotlin 编译和状态机测试；
6. Python / TypeScript / Kotlin 规范化 JSON golden vectors；
7. 实际 `.tpkg` 文件清单、路径、哈希、签名和压缩安全校验。
8. 相同输入生成字节一致的 `.tpkg` 与交付 ZIP。

## 版本约定

线上 wire 字段使用最终标识：

```text
contractVersion = A620-TRC-1.1
clockProfile = A620-UPTIME-MS-1
canonicalJsonProfile = A620-JCS-1
```

候选信息不进入线上协议语义，保存在：

```text
release/candidate.json
candidateRevision = rc3
```

Gate 0 通过后只改变审批状态，不修改 wire 字段、Schema ID 或签名投影。

## 当前未包含

- Android APK 与真实 AIDL/Binder 集成；
- Cocos Creator 原生工程与 Asset Bundle；
- 生产签名密钥；
- 两款游戏正式素材和代表等级；
- Windows 管理软件生产接口。

这些属于后续 Gate A–F。当前代码提供可编译、可执行、可审查的公共基线和 Mock Host。

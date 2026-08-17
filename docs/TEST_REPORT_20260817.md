# A620 Gate 0 单线施工首批测试报告

日期：2026-08-17

## 结论

`ALL_GATE0_IMPLEMENTATION_TESTS_PASS`

## 已验证

- Python：22 项结构、语义、状态机、批次证据、SQLite 事务和训练包安全测试通过；
- TypeScript：规范化 JSON 与公共状态机测试通过；
- Kotlin/JVM：规范化 JSON、状态机和批次账本测试通过；
- `.tpkg`：两份空插件样例包完成构建、Ed25519 签名验证、文件哈希和归档安全校验；
- 正常完成、暂停后完成、管理端终止、同毫秒终止优先和运行故障均有合法终局；
- 缺少 `COMMAND_ACCEPTED`、READY/STARTED 回显错误、运行中直接 RESULT_READY、批次替换、ACK 哈希错误、发送时钟倒退、HEARTBEAT 谎报状态和 QUERY_STATE 无响应均被拒绝。

## 代码规模

- 源文件数：79
- 可读源码/规范约：13073 行

## 尚未宣称完成

- 这不是 Android APK；
- 尚未接入真实 AIDL/Binder、Room、Cocos Creator 和原生触摸门；
- 两款游戏目前只有空插件和样例训练包，尚未进入代表等级；
- 测试密钥仅为 RFC 8032 固定测试向量，禁止用于生产。

完整命令输出见 `build/reports/test_all_20260817.txt`。

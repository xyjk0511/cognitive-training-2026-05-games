# W2 自动测试矩阵

`./scripts/test_catch_light.sh` 覆盖以下项目：

1. 禁用源扫描：领域与游戏配置目录中不存在正式逻辑随机、系统时钟和系统定时器 API。
2. TypeScript 严格编译：ES2022、NodeNext、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
3. 生成器：FNV-1a32、xorshift32、Fisher–Yates、相同 seed 重现、batchOrdinal 差异、配额、格位、同屏和双光圈模式。
4. 对象状态机：前界、起点、截止前 1ms、截止时刻、重复、多指、不同对象同毫秒、双光圈全路径。
5. 逻辑时钟：暂停冻结、暂停输入屏蔽、恢复输入启用时刻、暂停审计，以及晚帧先到而 DEADLINE 后到的 cutoff 权威性。
6. 计分/迁级：D=0/5/10、RoundHalfUp、升/持/失败、首次/连续失败和 L1/L120 保护。
7. headless 会话：L1、L28、L102、L120；0/1/7/8 eligible batch；`299999/300000/300001ms` 边界；未闭合审计仅统计已呈现实例并与正式积分隔离。
8. Golden Vector：L1、L28、L67、L102、L120 的完整计划及 SHA-256 新鲜度。
9. 配置溯源与防漂移：工作簿/需求书/公共规则 SHA-256、正式版本身份、编译配置 canonical SHA-256；来源、目录或阈值任一漂移均拒绝。
10. Schema：配置、批次指标、会话指标、部分指标；继承旧向量和 W2 正式分支。
11. 结果语义：公共 `validate_game_payload`、批次自哈希、BATCH_CLOSED 证据、难度/时序/内容标识、H/T/F/D 聚合、暂停审计和质量标志。

全仓继承测试由 `./scripts/test_all.sh` 运行，scope 由工作包 `verify_scope.py` 运行。

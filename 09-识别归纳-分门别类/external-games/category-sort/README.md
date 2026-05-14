# 分门别类 HTML5 游戏

入口：打开 `index.html`。

这是一个本地可运行的 HTML5 物体识别分类训练游戏。当前包已经完成规则实现、文档一致性修复、代码审查修复和二次精细打磨。

## 已实现内容

- 游戏名称：分门别类
- 游戏 ID：4711
- 版本：1.0.2
- 训练类型：言语——物体识别训练
- 三个难度入口：容易从第 1 关开始，普通从第 15 关开始，困难从第 30 关开始
- 100 关运行配置
- 92 个物品 SVG 素材
- 开机页康康、欢迎页康康坐飞机、引导图、帮助图、整体布局图
- 提示、正确、错误、结算音效
- 小关生成逻辑：图示与正确项从目标池随机且不重复，干扰项优先从干扰池随机
- 展示流程：先展示图示，再播放提示音/提示文字，最后展示选项飞入动画
- 反馈：正确/错误动画、所属类别提示浮现；选错时额外高亮本轮正确项
- 小关结束：倒计时为 0，或连续选错 2 次
- 小关通关判定：小关结束时正确次数达到 PassTarget
- 积分：通关按基础分、选项数量、剩余时长、超额正确奖励计算；未通关固定 10 分
- 难度变化：通关 +1；失败 1 次原等级继续，失败 2 次 -1，失败 3 次 -3，最低等级 1
- 新手教程：游戏内弹窗 + 本关准备遮罩 + `docs/BEGINNER_TUTORIAL.md`
- 键盘操作：数字键 1-4 选择选项，Escape 暂停或关闭弹窗
- 适配：响应式布局、键盘焦点、动效敏感用户的 `prefers-reduced-motion`

## 本轮精细打磨重点

- 首页增加素材预加载进度，素材准备完成后才允许进入训练。
- 难度页增加快速上手说明和难度定位标签。
- 游戏页 HUD 增加“连错”和“轮次”。
- 选择难度后先显示“本关准备”，说明类别粒度、选项数量、倒计时和过关目标。
- 结算页增加结果、准确率、剩余时间和计分解释。
- 新增 `tools/playtest_simulation.py`，用于模拟所有关卡的轮次生成。
- 新增 `docs/POLISH_CHANGELOG.md` 和 `docs/QA_CHECKLIST.md`。

## 运行方式

直接双击 `index.html`。如果浏览器限制本地音频，可在工程目录执行：

```bash
python -m http.server 8000
```

然后访问：

```text
http://localhost:8000
```

## 文件结构

- `index.html`：入口页面
- `style.css`：界面与动画样式
- `src/data.js`：运行时游戏配置
- `src/game.js`：游戏逻辑
- `assets/items/`：92 个物品素材
- `assets/ui/`：康康、欢迎、引导、帮助、布局素材
- `assets/sfx/`：音效素材
- `source/extracted_workbook_data.json`：源表抽取数据
- `source/runtime_game_data.json`：修复后的运行时完整数据
- `source/data_mapping_summary.json`：类别映射与源表差异摘要
- `docs/CODE_REVIEW_AND_CONSISTENCY.md`：代码审查与一致性报告
- `docs/BEGINNER_TUTORIAL.md`：详细新手教程
- `docs/POLISH_CHANGELOG.md`：精细打磨变更记录
- `docs/QA_CHECKLIST.md`：手工验收清单
- `tools/validate_project.py`：静态校验脚本
- `tools/playtest_simulation.py`：关卡生成模拟脚本

## 校验

在工程目录运行：

```bash
python tools/validate_project.py
python tools/playtest_simulation.py
node --check src/game.js
node --check src/data.js
```

当前版本已通过上述校验。

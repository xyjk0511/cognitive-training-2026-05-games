规律小火车｜可玩版本 v1

打开方式：
1. 解压 14-number-sequence-playable-v1.zip。
2. 双击 index.html 即可试玩。
3. 如浏览器限制本地文件，也可在解压目录运行：python3 -m http.server 5173，然后访问 http://localhost:5173/

本包内容：
- index.html：无外网依赖的完整单文件游戏。
- assets/*.png：全部为 GPTImage2 生成的本地 PNG 资产。

试玩检查：
- 首页卡片感、详情/说明、封面页、6 屏教学、低压练习、准备开始弹窗、正式训练 HUD、结算页均已包含。
- 游戏全中文。
- localStorage 会记录本轮表现，并在下轮自动推荐难度。
- 第 1–3 级为轻松起步，第 7 级以后显示“进阶挑战”。

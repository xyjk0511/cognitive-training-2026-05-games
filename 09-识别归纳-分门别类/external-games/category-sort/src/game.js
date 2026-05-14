(() => {
  "use strict";

  const DATA = window.GAME_DATA;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    difficulty: null,
    level: 1,
    score: 0,
    timeLeft: 0,
    timerId: null,
    paused: false,
    stageDone: true,
    awaitingChoice: false,
    correctCount: 0,
    wrongStreak: 0,
    failStreak: 0,
    roundIndex: 0,
    current: null,
    answerHistory: [],
    recentItemIds: [],
    lastTargetKey: null,
    audioUnlocked: false,
    muted: false,
    stageToken: 0,
    roundToken: 0,
    activeTimeouts: new Set()
  };

  const audio = {
    tip: new Audio("assets/sfx/tip.wav"),
    correct: new Audio("assets/sfx/correct.wav"),
    wrong: new Audio("assets/sfx/wrong.wav"),
    settlement: new Audio("assets/sfx/settlement.wav")
  };

  Object.values(audio).forEach((snd) => {
    snd.preload = "auto";
    snd.volume = 0.55;
  });

  function setText(id, text) {
    const el = $("#" + id);
    if (el) el.textContent = text;
  }

  function safeReadJson(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeWriteJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function showScreen(id) {
    $$(".screen").forEach((screen) => screen.classList.remove("active"));
    const target = $("#" + id);
    if (target) target.classList.add("active");
  }

  function randomOf(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function shuffle(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function sample(arr, n) {
    return shuffle(arr).slice(0, n);
  }

  function uniqueById(arr) {
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  function randomFresh(items, avoidIds) {
    const avoid = new Set(Array.isArray(avoidIds) ? avoidIds : Array.from(avoidIds || []));
    const fresh = items.filter((item) => !avoid.has(item.id));
    return randomOf(fresh.length ? fresh : items);
  }

  function rememberItems(...items) {
    for (const item of items) {
      if (item && Number.isFinite(item.id)) state.recentItemIds.push(item.id);
    }
    state.recentItemIds = state.recentItemIds.slice(-14);
  }

  function levelConfig(level = state.level) {
    return DATA.levels.find((entry) => entry.level === level) || DATA.levels[DATA.levels.length - 1];
  }

  function depthLabel(depth) {
    return ["一级类别", "二级类别", "三级类别"][depth] || "类别";
  }

  function typeName(depth, idx) {
    const row = DATA.types.byDepth[depth] || [];
    return row[idx] ?? `类别${idx}`;
  }

  function itemCategory(item, depth) {
    return item.typePath[depth];
  }

  function categoryLine(item) {
    return [
      DATA.types.primary[item.primary],
      DATA.types.secondary[item.secondary],
      item.tertiary !== null ? DATA.types.tertiary[item.tertiary] : null
    ].filter(Boolean).join(" / ");
  }

  function itemsInCategory(depth, categoryId) {
    return DATA.items.filter((item) => itemCategory(item, depth) === categoryId);
  }

  function targetNamesFor(cfg) {
    if (Array.isArray(cfg.targetNames) && cfg.targetNames.length) return cfg.targetNames;
    return cfg.target.map((cat) => typeName(cfg.typeDepth, cat));
  }

  function play(name) {
    if (state.muted) return;
    const snd = audio[name];
    if (!snd) return;
    try {
      snd.currentTime = 0;
      snd.play().catch(() => {});
    } catch (_) {}
  }

  function unlockAudio() {
    if (state.audioUnlocked) return;
    state.audioUnlocked = true;
    Object.values(audio).forEach((snd) => {
      try {
        snd.play().then(() => {
          snd.pause();
          snd.currentTime = 0;
        }).catch(() => {});
      } catch (_) {}
    });
  }

  function clearStageTimeouts() {
    state.activeTimeouts.forEach((id) => window.clearTimeout(id));
    state.activeTimeouts.clear();
  }

  function scheduleRound(callback, delay, roundToken = state.roundToken) {
    const stageToken = state.stageToken;
    const id = window.setTimeout(() => {
      state.activeTimeouts.delete(id);
      if (stageToken !== state.stageToken) return;
      if (roundToken !== state.roundToken) return;
      if (state.stageDone) return;
      callback();
    }, delay);
    state.activeTimeouts.add(id);
    return id;
  }

  function scheduleStage(callback, delay) {
    const stageToken = state.stageToken;
    const id = window.setTimeout(() => {
      state.activeTimeouts.delete(id);
      if (stageToken !== state.stageToken) return;
      if (state.stageDone) return;
      callback();
    }, delay);
    state.activeTimeouts.add(id);
    return id;
  }

  function updateHud() {
    const cfg = levelConfig();
    const diff = DATA.difficulties[state.difficulty];
    setText("hudDifficulty", diff?.label || "-");
    setText("hudLevel", String(state.level));
    setText("hudScore", String(state.score));
    setText("hudGoal", `${state.correctCount}/${cfg.passTarget}`);
    setText("hudWrongStreak", `${state.wrongStreak}/2`);
    setText("hudTimer", `${Math.max(0, state.timeLeft)}s`);
    setText("hudRound", String(state.roundIndex));
    setText("hudTrend", trendText());
    const progress = $("#goalProgress");
    if (progress) {
      const pct = Math.min(100, Math.round((state.correctCount / Math.max(1, cfg.passTarget)) * 100));
      progress.style.width = `${pct}%`;
    }
  }

  function trendText() {
    const saved = safeReadJson("fenmenbielei_last", null);
    if (!saved) return "初次";
    return saved.trend || "持平";
  }

  function modalHtmlFor(kind) {
    if (kind === "guide") {
      return {
        title: "固定引导内容",
        body: `<img class="help-media" src="assets/ui/引导.jpg" alt="引导图">
          <p>流程固定为：先出现图示，再出现提示文字和提示音，随后选项飞入。用户只需要点击与提示类别匹配的那一张图片。</p>`
      };
    }
    if (kind === "layout") {
      return {
        title: "游戏布局",
        body: `<img class="help-media" src="assets/ui/整体效果图.jpg" alt="整体效果图">
          <p>顶部为训练状态；中间左侧是图示，右侧是选项；底部显示结束条件和反馈。右上角可以暂停、静音、查看教程或帮助。</p>`
      };
    }
    if (kind === "tutorial") {
      return {
        title: "新手教程",
        body: `<div class="tutorial-block">
          <div class="tutorial-grid">
            <div class="tutorial-card"><strong>1. 先看图示</strong>图示先单独出现。此时不要急着点击，先确认它是什么物品。</div>
            <div class="tutorial-card"><strong>2. 再看提示</strong>提示会告诉你要找的类别，例如“动物”“水果”“鱼类”。</div>
            <div class="tutorial-card"><strong>3. 等选项飞入</strong>选项中只有 1 个指定正确项，其余都是干扰项。</div>
            <div class="tutorial-card"><strong>4. 点击正确图片</strong>也可以用键盘数字 1-4 选择对应位置的选项。</div>
          </div>
          <ol class="tutorial-steps">
            <li><strong>选择难度：</strong>容易从第 1 关开始，普通从第 15 关开始，困难从第 30 关开始。难度入口只改变起始关卡，不单独改规则。</li>
            <li><strong>理解目标：</strong>界面“目标 2/3”表示已经正确 2 次，本关至少需要正确 3 次才算通关。</li>
            <li><strong>理解结束：</strong>达到目标不会立即结束。小关只会因为倒计时为 0 或连续选错 2 次而结束。</li>
            <li><strong>理解反馈：</strong>选对会显示绿色反馈；选错会显示所选物品的真实类别，并用高亮提示本轮正确项。</li>
            <li><strong>理解结算：</strong>小关结束时再根据正确次数是否达到 PassTarget 判定通关。通关升 1 级；失败按连续失败次数决定是否降级。</li>
          </ol>
          <div class="tutorial-note"><strong>积分规则：</strong>未通关固定 10 分；通关时按基础分、选项数量倍率、剩余时间、超额正确奖励和通关加分计算。继续答对比“刚好达标”更有收益。</div>
        </div>`
      };
    }
    return {
      title: "帮助",
      body: `<img class="help-media" src="assets/ui/帮助.jpg" alt="帮助图">
        <p>本训练不适合色盲或色弱用户。小关按关卡配置生成目标池、干扰池、选项数量、倒计时、基础分、奖励分和过关目标。</p>
        <p>结束条件为倒计时归零或连续选错 2 次；PassTarget 用于结算是否通关，不是即时结束条件。</p>`
    };
  }

  function openModal(kind = "help") {
    const modal = modalHtmlFor(kind);
    setText("infoTitle", modal.title);
    const body = $("#infoBody");
    if (body) body.innerHTML = modal.body;
    $("#infoModal")?.classList.add("show");
  }

  function closeModal() {
    $("#infoModal")?.classList.remove("show");
  }

  function showStageIntro() {
    clearInterval(state.timerId);
    clearStageTimeouts();
    const cfg = levelConfig();
    const diff = DATA.difficulties[state.difficulty];

    state.stageDone = true;
    state.paused = false;
    state.awaitingChoice = false;
    state.current = null;
    state.correctCount = 0;
    state.wrongStreak = 0;
    state.roundIndex = 0;
    state.answerHistory = [];
    state.timeLeft = cfg.stageTime;

    $("#pauseLayer")?.classList.remove("show");
    $("#stageIntroLayer")?.classList.add("show");
    $("#startStageBtn")?.removeAttribute("disabled");
    const pauseBtn = $("#pauseBtn");
    if (pauseBtn) pauseBtn.disabled = true;
    setText("pauseBtn", "暂停");
    $("#pauseBtn")?.setAttribute("aria-pressed", "false");

    const names = targetNamesFor(cfg);
    setText("introTitle", `${diff?.label || "训练"} · 第 ${state.level} 关`);
    setText("introBody", `本关训练 ${depthLabel(cfg.typeDepth)}。目标池包括：${names.join("、")}。请先观察图示，再根据提示类别选择选项。`);
    setText("introDepth", depthLabel(cfg.typeDepth));
    setText("introOptions", `${cfg.optionalQuantity} 个`);
    setText("introTime", `${cfg.stageTime}s`);
    setText("introPass", `${cfg.passTarget} 次`);

    setText("promptStep", "准备");
    setText("promptMain", `第 ${state.level} 关准备开始`);
    setText("promptSub", `选项数量 ${cfg.optionalQuantity}，倒计时 ${cfg.stageTime}s，过关目标 ${cfg.passTarget} 次。`);
    setText("promptBadge", depthLabel(cfg.typeDepth));
    const clue = $("#clueCard");
    if (clue) {
      clue.className = "clue-card empty";
      clue.innerHTML = "<span>点击“开始本关”后显示图示</span>";
    }
    const grid = $("#optionsGrid");
    if (grid) {
      grid.className = `options-grid cols-${cfg.optionalQuantity} preparing`;
      grid.innerHTML = "<div class=\"option-placeholder\">等待本关开始</div>";
    }
    updateHud();
  }

  function makeRound() {
    const cfg = levelConfig();
    const depth = cfg.typeDepth;
    const scope = Array.isArray(cfg.scope) && cfg.scope.length ? cfg.scope : cfg.target;
    const targetCategories = cfg.target.filter((cat) => itemsInCategory(depth, cat).length >= 2);

    if (!targetCategories.length) {
      finishStage("目标池无有效物品");
      return;
    }

    const lastKey = state.lastTargetKey;
    const freshCategories = targetCategories.filter((cat) => `${depth}:${cat}` !== lastKey);
    const targetCategory = randomOf(freshCategories.length ? freshCategories : targetCategories);
    state.lastTargetKey = `${depth}:${targetCategory}`;

    const targetItems = itemsInCategory(depth, targetCategory);
    const clue = randomFresh(targetItems, state.recentItemIds);
    const correctPool = targetItems.filter((item) => item.id !== clue.id);
    const correct = randomFresh(correctPool, [...state.recentItemIds, clue.id]) || randomOf(correctPool) || clue;
    const excludedIds = new Set([clue.id, correct.id]);

    // 按策划：干扰池优先取“完整范围 - 目标池”；若表内范围太窄导致数量不足，再逐级兜底。
    const configuredDistractors = DATA.items.filter((item) => {
      const cat = itemCategory(item, depth);
      return scope.includes(cat) && !cfg.target.includes(cat) && !excludedIds.has(item.id);
    });
    const sameScopeFallback = DATA.items.filter((item) => {
      const cat = itemCategory(item, depth);
      return scope.includes(cat) && cat !== targetCategory && !excludedIds.has(item.id);
    });
    const globalFallback = DATA.items.filter((item) => {
      const cat = itemCategory(item, depth);
      return cat !== targetCategory && !excludedIds.has(item.id);
    });

    const distractors = uniqueById([
      ...configuredDistractors,
      ...sameScopeFallback,
      ...globalFallback
    ]);
    const needed = Math.max(0, cfg.optionalQuantity - 1);
    const selectedDistractors = sample(distractors, needed);

    if (selectedDistractors.length < needed) {
      finishStage("干扰项素材不足");
      return;
    }

    const options = shuffle([correct, ...selectedDistractors]);
    state.roundIndex += 1;
    state.current = {cfg, depth, scope, targetCategory, clue, correct, options, roundIndex: state.roundIndex};
    updateHud();
    renderRound();
  }

  function renderRound() {
    if (state.stageDone || !state.current) return;
    const roundToken = ++state.roundToken;
    const {cfg, depth, targetCategory, clue, options, roundIndex} = state.current;
    const category = typeName(depth, targetCategory);
    state.awaitingChoice = false;

    setText("promptStep", `第 ${roundIndex} 轮 · 观察`);
    setText("promptMain", "请先观察图示");
    setText("promptSub", `图示：${clue.name} · ${categoryLine(clue)}`);
    setText("promptBadge", category);

    const clueEl = $("#clueCard");
    if (clueEl) {
      clueEl.className = "clue-card";
      clueEl.innerHTML = `<div><img src="${clue.asset}" alt="${clue.name}" draggable="false"><div class="clue-caption">${clue.name}</div></div>`;
    }

    const grid = $("#optionsGrid");
    if (grid) {
      grid.className = `options-grid cols-${cfg.optionalQuantity} preparing`;
      grid.innerHTML = `<div class="option-placeholder">先看图示，随后选项飞入……</div>`;
    }

    scheduleRound(() => {
      $("#clueCard")?.classList.add("shift");
    }, 120, roundToken);

    scheduleRound(() => {
      setText("promptStep", `第 ${roundIndex} 轮 · 提示`);
      const main = $("#promptMain");
      if (main) main.innerHTML = `请点击选择 <span class="category-badge">“${category}”类</span> 的图片`;
      setText("promptSub", `选项数量：${cfg.optionalQuantity}。小关结束时至少正确 ${cfg.passTarget} 次即通关。`);
      play("tip");
    }, 560, roundToken);

    scheduleRound(() => {
      renderOptions(options, roundToken);
    }, 800, roundToken);
  }

  function isCurrentRound(token) {
    return token === state.roundToken && !state.stageDone && state.current !== null;
  }

  function renderOptions(options, token) {
    if (!isCurrentRound(token)) return;
    const cfg = state.current.cfg;
    const grid = $("#optionsGrid");
    if (!grid) return;

    grid.className = `options-grid cols-${cfg.optionalQuantity}`;
    grid.innerHTML = "";
    options.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.className = "option-card";
      btn.style.animationDelay = `${index * 80}ms`;
      btn.type = "button";
      btn.dataset.index = String(index);
      btn.dataset.itemId = String(item.id);
      btn.disabled = state.paused;
      btn.setAttribute("aria-label", `选择第 ${index + 1} 项：${item.name}`);
      btn.innerHTML = `<span class="option-index">${index + 1}</span><img src="${item.asset}" alt="${item.name}" draggable="false"><div class="item-name">${item.name}</div>`;
      btn.addEventListener("click", () => chooseOption(item, btn, token));
      grid.appendChild(btn);
    });
    state.awaitingChoice = true;
    setText("promptStep", `第 ${state.current.roundIndex} 轮 · 选择`);
    setOptionControlsDisabled();
  }

  function setOptionControlsDisabled() {
    const disabled = state.paused || !state.awaitingChoice;
    $$(".option-card").forEach((card) => {
      if (card.classList.contains("disabled")) {
        card.disabled = true;
      } else {
        card.disabled = disabled;
      }
    });
  }

  function chooseOption(item, btn, token) {
    if (!isCurrentRound(token) || !state.awaitingChoice || state.paused) return;
    const {depth, clue, correct, cfg, targetCategory, roundIndex} = state.current;
    state.awaitingChoice = false;
    $$(".option-card").forEach((card) => {
      card.classList.add("disabled");
      card.disabled = true;
    });

    const isCorrect = item.id === correct.id;
    const realCat = typeName(depth, itemCategory(item, depth));
    const targetCat = typeName(depth, targetCategory);
    rememberItems(clue, correct, item);
    state.answerHistory.push({
      round: roundIndex,
      selected: item.name,
      selectedCategory: realCat,
      target: targetCat,
      correct: isCorrect
    });

    if (isCorrect) {
      state.correctCount += 1;
      state.wrongStreak = 0;
      btn.classList.add("correct");
      showFeedback(`正确！${item.name} 属于 <span class="type">${realCat}</span>`);
      play("correct");
    } else {
      state.wrongStreak += 1;
      btn.classList.add("wrong");
      const correctBtn = $(`.option-card[data-item-id="${correct.id}"]`);
      correctBtn?.classList.add("missed");
      showFeedback(`错误，${item.name} 属于 <span class="type">${realCat}</span>；本轮目标是“${targetCat}”`);
      play("wrong");
    }

    setText("promptStep", `第 ${roundIndex} 轮 · 反馈`);
    updateHud();

    if (state.wrongStreak >= 2) {
      scheduleStage(() => finishStage("连续选错 2 次"), 780);
      return;
    }

    scheduleStage(() => {
      if (!state.stageDone) makeRound();
    }, isCorrect ? 760 : 1120);
  }

  function showFeedback(html) {
    const feedback = $("#feedback");
    if (!feedback) return;
    feedback.innerHTML = html;
    feedback.classList.remove("show");
    void feedback.offsetWidth;
    feedback.classList.add("show");
  }

  function startTimer() {
    clearInterval(state.timerId);
    state.timerId = setInterval(() => {
      if (state.paused || state.stageDone) return;
      state.timeLeft = Math.max(0, state.timeLeft - 1);
      updateHud();
      if (state.timeLeft <= 0) finishStage("倒计时结束");
    }, 1000);
  }

  function startStage() {
    clearInterval(state.timerId);
    clearStageTimeouts();
    state.stageToken += 1;
    state.roundToken += 1;
    const cfg = levelConfig();
    state.stageDone = false;
    state.paused = false;
    state.awaitingChoice = false;
    state.correctCount = 0;
    state.wrongStreak = 0;
    state.roundIndex = 0;
    state.answerHistory = [];
    state.timeLeft = cfg.stageTime;
    $("#stageIntroLayer")?.classList.remove("show");
    $("#startStageBtn")?.setAttribute("disabled", "");
    $("#pauseLayer")?.classList.remove("show");
    const pauseBtn = $("#pauseBtn");
    if (pauseBtn) pauseBtn.disabled = false;
    setText("pauseBtn", "暂停");
    $("#pauseBtn")?.setAttribute("aria-pressed", "false");
    const feedback = $("#feedback");
    if (feedback) feedback.innerHTML = "";
    updateHud();
    makeRound();
    startTimer();
  }

  function scoreDetailsForStage(passed, cfg) {
    if (!passed) {
      return {
        score: 10,
        formula: "未达到 PassTarget：未通关固定获得 10 分。"
      };
    }
    const optionMultiplier = 1 + (cfg.optionalQuantity - 2) / 10;
    const basePart = cfg.baseScore * optionMultiplier;
    const timeBonus = Math.max(0, state.timeLeft) * 2;
    const excessCorrect = Math.max(0, state.correctCount - cfg.passTarget);
    const excessBonus = excessCorrect * cfg.rewardScore;
    const completionBonus = 10;
    const score = Math.round(basePart + timeBonus + excessBonus + completionBonus);
    return {
      score,
      formula: `通关计分：基础分 ${cfg.baseScore} × 选项倍率 ${optionMultiplier.toFixed(1)} + 剩余时间奖励 ${timeBonus} + 超额正确奖励 ${excessBonus} + 通关加分 ${completionBonus} = ${score} 分。`
    };
  }

  function resolveTrend(currentScore, fromLevel, toLevel) {
    const last = safeReadJson("fenmenbielei_last", null);
    if (!last) return "初次";
    if (currentScore > last.score && toLevel > last.toLevel) return "提升";
    if (currentScore >= last.score && toLevel === last.toLevel) return "持平";
    if (currentScore >= last.score && toLevel < last.toLevel) return "持平";
    if (currentScore < last.score && toLevel < last.toLevel) return "下降";
    if (currentScore < last.score && toLevel > last.toLevel) return "提升";
    return "持平";
  }

  function finishStage(reason) {
    if (state.stageDone) return;
    state.stageDone = true;
    state.awaitingChoice = false;
    state.roundToken += 1;
    clearStageTimeouts();
    clearInterval(state.timerId);
    const pauseBtn = $("#pauseBtn");
    if (pauseBtn) pauseBtn.disabled = true;

    const cfg = levelConfig();
    const passed = state.correctCount >= cfg.passTarget;
    const fromLevel = state.level;
    const details = scoreDetailsForStage(passed, cfg);
    const stageScore = details.score;
    state.score += stageScore;

    let toLevel = fromLevel;
    let resultClass = "result-flat";
    let title = "太可惜了";
    let resultText = "等级无变化";
    if (passed) {
      toLevel = Math.min(100, fromLevel + 1);
      state.failStreak = 0;
      title = "等级提升";
      resultText = fromLevel === toLevel ? "已在最高等级，第 100 关继续训练" : `通过第 ${fromLevel} 关，进入第 ${toLevel} 关`;
      resultClass = "result-up";
      burstConfetti();
    } else {
      state.failStreak += 1;
      if (state.failStreak === 1) {
        resultText = "未达到过关目标，本等级继续训练";
      } else if (state.failStreak === 2) {
        toLevel = Math.max(1, fromLevel - 1);
        title = "等级下降";
        resultText = `连续失败 2 次，降至第 ${toLevel} 关`;
        resultClass = "result-down";
      } else {
        toLevel = Math.max(1, fromLevel - 3);
        state.failStreak = 0;
        title = "等级下降";
        resultText = `连续失败 3 次，降至第 ${toLevel} 关`;
        resultClass = "result-down";
      }
    }

    const trend = resolveTrend(stageScore, fromLevel, toLevel);
    safeWriteJson("fenmenbielei_last", {score: stageScore, fromLevel, toLevel, trend, time: Date.now()});
    state.level = toLevel;
    updateHud();
    play("settlement");

    const accuracy = state.roundIndex > 0 ? Math.round((state.correctCount / state.roundIndex) * 100) : 0;
    const settleTitle = $("#settleTitle");
    if (settleTitle) {
      settleTitle.textContent = title;
      settleTitle.className = resultClass;
    }
    setText("settleReason", `${resultText}。结束原因：${reason}。`);
    setText("settlePass", passed ? "通关" : "未通关");
    setText("settleScore", `+${stageScore}`);
    setText("settleCorrect", `${state.correctCount}/${cfg.passTarget}`);
    setText("settleAccuracy", `${accuracy}%`);
    setText("settleTime", `${Math.max(0, state.timeLeft)}s`);
    setText("settleLevel", `${fromLevel} → ${toLevel}`);
    setText("settleTrend", trend);
    setText("settleNextHint", `点击继续后将按第 ${toLevel} 关配置开始下一小关。`);
    const formula = $("#settleFormula");
    if (formula) formula.textContent = details.formula;
    setText("nextStageBtn", `继续第 ${toLevel} 关`);
    $("#settleModal")?.classList.add("show");
  }

  function burstConfetti() {
    const box = $("#confetti");
    if (!box) return;
    box.innerHTML = "";
    const colors = ["#facc15", "#22c55e", "#38bdf8", "#a78bfa", "#fb7185"];
    for (let i = 0; i < 42; i += 1) {
      const particle = document.createElement("span");
      particle.style.left = Math.random() * 100 + "%";
      particle.style.top = "-30px";
      particle.style.background = colors[i % colors.length];
      particle.style.animationDelay = Math.random() * 0.4 + "s";
      particle.style.transform = `rotate(${Math.random() * 180}deg)`;
      box.appendChild(particle);
    }
  }

  function chooseDifficulty(key) {
    const diff = DATA.difficulties[key];
    if (!diff) return;
    state.difficulty = key;
    state.level = diff.startLevel;
    state.score = 0;
    state.failStreak = 0;
    state.stageDone = true;
    state.paused = false;
    state.recentItemIds = [];
    state.lastTargetKey = null;
    $("#settleModal")?.classList.remove("show");
    showScreen("gameScreen");
    showStageIntro();
  }

  function togglePause(forceValue = null) {
    if (state.stageDone) return;
    state.paused = typeof forceValue === "boolean" ? forceValue : !state.paused;
    $("#pauseLayer")?.classList.toggle("show", state.paused);
    setText("pauseBtn", state.paused ? "继续" : "暂停");
    $("#pauseBtn")?.setAttribute("aria-pressed", state.paused ? "true" : "false");
    setOptionControlsDisabled();
  }

  function preloadAssets() {
    const uniqueAssets = Array.from(new Set([
      ...DATA.items.map((item) => item.asset),
      "assets/ui/kangkang.svg",
      "assets/ui/kangkang_airplane.svg",
      "assets/ui/引导.jpg",
      "assets/ui/帮助.jpg",
      "assets/ui/整体效果图.jpg"
    ]));

    const enterBtn = $("#enterBtn");
    const progress = $("#assetProgress");
    const status = $("#assetStatus");
    const percent = $("#assetPercent");
    if (!enterBtn) return;
    enterBtn.disabled = true;

    let loaded = 0;
    let failed = 0;
    const update = () => {
      const pct = uniqueAssets.length ? Math.round((loaded / uniqueAssets.length) * 100) : 100;
      if (progress) progress.style.width = `${pct}%`;
      if (percent) percent.textContent = `${pct}%`;
      if (status) status.textContent = failed ? `素材已准备，${failed} 项加载失败但不阻塞运行` : "正在准备素材……";
    };

    if (!uniqueAssets.length) {
      enterBtn.disabled = false;
      setText("assetStatus", "素材准备完成");
      setText("assetPercent", "100%");
      if (progress) progress.style.width = "100%";
      return;
    }

    Promise.all(uniqueAssets.map((src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        loaded += 1;
        update();
        resolve(true);
      };
      img.onerror = () => {
        loaded += 1;
        failed += 1;
        update();
        resolve(false);
      };
      img.src = src;
    }))).then(() => {
      enterBtn.disabled = false;
      if (status) status.textContent = failed ? `素材准备完成；${failed} 项需检查路径` : "素材准备完成";
      if (progress) progress.style.width = "100%";
      if (percent) percent.textContent = "100%";
    });
  }

  function handleKeyboard(e) {
    const infoOpen = $("#infoModal")?.classList.contains("show");
    const settleOpen = $("#settleModal")?.classList.contains("show");
    if (e.key === "Escape") {
      if (infoOpen) {
        closeModal();
        return;
      }
      if (!settleOpen && $("#gameScreen")?.classList.contains("active") && !state.stageDone) {
        togglePause();
      }
      return;
    }
    if (infoOpen || settleOpen || state.paused || !state.awaitingChoice) return;
    if (!["1", "2", "3", "4"].includes(e.key)) return;
    const index = Number(e.key) - 1;
    const btn = $(`.option-card[data-index="${index}"]`);
    if (btn && !btn.disabled) btn.click();
  }

  function bindEvents() {
    document.addEventListener("pointerdown", unlockAudio, {once: true});
    document.addEventListener("keydown", handleKeyboard);

    $("#enterBtn")?.addEventListener("click", () => showScreen("welcomeScreen"));
    $$(".difficulty-card").forEach((btn) => btn.addEventListener("click", () => chooseDifficulty(btn.dataset.difficulty)));
    $$(".open-help").forEach((btn) => btn.addEventListener("click", () => openModal(btn.dataset.kind || "help")));
    $("#openCoachBtn")?.addEventListener("click", () => openModal("tutorial"));
    $("#closeInfo")?.addEventListener("click", closeModal);
    $("#closeInfoX")?.addEventListener("click", closeModal);
    $("#infoModal")?.addEventListener("click", (e) => {
      if (e.target.id === "infoModal") closeModal();
    });
    $("#pauseBtn")?.addEventListener("click", () => togglePause());
    $("#muteBtn")?.addEventListener("click", () => {
      state.muted = !state.muted;
      setText("muteBtn", state.muted ? "打开声音" : "静音");
      $("#muteBtn")?.setAttribute("aria-pressed", state.muted ? "true" : "false");
    });
    $("#startStageBtn")?.addEventListener("click", startStage);
    $("#nextStageBtn")?.addEventListener("click", () => {
      $("#settleModal")?.classList.remove("show");
      startStage();
    });
    $("#restartBtn")?.addEventListener("click", () => {
      $("#settleModal")?.classList.remove("show");
      clearInterval(state.timerId);
      clearStageTimeouts();
      state.stageDone = true;
      showScreen("welcomeScreen");
    });
    $("#resumeBtn")?.addEventListener("click", () => togglePause(false));
    $("#modalGuideBtn")?.addEventListener("click", () => openModal("guide"));
    $("#modalLayoutBtn")?.addEventListener("click", () => openModal("layout"));
    $("#modalTutorialBtn")?.addEventListener("click", () => openModal("tutorial"));
  }

  bindEvents();
  preloadAssets();
  showScreen("splashScreen");
})();

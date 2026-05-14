(() => {
  "use strict";

  const DATA = window.KX_DATA || {};
  const ASSET_BASE = window.KX_ASSET_BASE || "../assets";
  const BOOT = window.KX_BOOT_CONFIG || { version: "child" };
  const VERSION_ID = BOOT.version || "child";
  const VERSION = (DATA.versions && DATA.versions[VERSION_ID]) || (DATA.versions && DATA.versions.child) || { label: "儿童版", levels: [] };
  const LEVELS = VERSION.levels || [];
  const SHAPES = DATA.shapes || [];
  const COLORS = DATA.colors || {};
  const SHAPE_NAMES = DATA.shapeNames || {};
  const TEXTURE_NAMES = DATA.textureNames || {};
  const SHAPE_RANGES = DATA.shapeRanges || { "1": [1, 100] };
  const GAME_TITLE = DATA.meta?.gameTitle || "快闪图形";
  const MAX_LEVEL = LEVELS.reduce((max, lv) => Math.max(max, Number(lv.Level || 1)), 1);
  const AUTO_CONTINUE_MS = Number(BOOT.autoContinueMs || VERSION.autoContinueMs || 850);
  const FIRST_CARD_MS = Number(BOOT.firstCardMs || VERSION.firstCardMs || 1000);
  const POST_MESSAGE_TARGET_ORIGIN = typeof BOOT.postMessageTargetOrigin === "string" ? BOOT.postMessageTargetOrigin : "*";
  const DIFFICULTY_PRESETS = normalizeDifficultyPresets(VERSION.difficultyPresets || DATA.meta?.difficultyPresets);

  const state = {
    screen: "welcome",
    selectedDifficulty: "easy",
    difficultyStartLevel: 1,
    currentLevel: Number(VERSION.defaultStartLevel || 1),
    startLevelValue: Number(VERSION.defaultStartLevel || 1),
    sessionRemaining: Number(VERSION.defaultTrainingSeconds || 180),
    initialSessionSeconds: Number(VERSION.defaultTrainingSeconds || 180),
    levelRemaining: 0,
    levelCfg: null,
    previousShape: null,
    currentShape: null,
    expectedSame: false,
    canAnswer: false,
    levelActive: false,
    trainingActive: false,
    paused: false,
    timerId: null,
    questionDelayId: null,
    questionDelayFn: null,
    questionDelayDueAt: 0,
    questionDelayRemainingMs: 0,
    autoContinueId: null,
    levelEndTimeoutId: null,
    runId: 0,
    lastTick: 0,
    correctCount: 0,
    wrongCount: 0,
    answerCount: 0,
    consecutiveWrong: 0,
    failStreak: 0,
    failSequenceBaseLevel: null,
    totalScore: 0,
    levelIndex: 0,
    trainingPassFlag: false,
    lastLevelPassed: false,
    resultEmitted: false,
    lastPayload: null,
    history: [],
    soundEnabled: true,
    musicEnabled: false,
    audioCtx: null,
    bgm: null,
    imageCache: [],
    audioCache: {},
    guideStep: 0,
    guidePrev: null,
    guideCurrent: null,
    guideExpectedSame: false,
    guideAnswerLocked: false,
    guideComplete: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    initUI();
    showScreen("welcomeScreen");
  });

  function cacheElements() {
    [
      "welcomeScreen", "menuScreen", "gameScreen", "modeLabel", "welcomeVersion", "menuVersion",
      "btnWelcomeStart", "btnStartTraining", "btnReplayGuide", "btnSkipToMenu",
      "trainingSeconds", "startLevel", "difficultyPicker", "selectedDifficultyText", "difficultyLabel", "levelTimer", "sessionTimer",
      "targetCounter", "streakCounter", "questionText", "card", "answerRow", "btnDifferent", "btnSame",
      "floatLayer", "progressDots", "historyText", "pauseBtn", "pauseOverlay", "btnResume",
      "btnSound", "btnMusic", "btnHelp", "btnCloseHelp", "helpOverlay", "resultOverlay",
      "resultRibbon", "resultInfo", "btnContinueLevel", "btnRestartTraining", "btnResultMenu",
      "btnResultReplayGuide"
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function initUI() {
    document.title = `${GAME_TITLE} - ${VERSION.label || ""}`;
    setText(els.modeLabel, VERSION.label || "儿童版");
    setText(els.welcomeVersion, VERSION.label || "儿童版");
    setText(els.menuVersion, VERSION.label || "儿童版");

    const defaultSeconds = readBootNumber(["trainingSeconds", "seconds", "duration", "time"], BOOT.defaultTrainingSeconds || VERSION.defaultTrainingSeconds || 180, 10, 3600);
    const initialPreset = getInitialDifficultyPreset();
    if (els.trainingSeconds) els.trainingSeconds.value = String(defaultSeconds);
    if (els.startLevel) {
      els.startLevel.max = String(MAX_LEVEL);
    }
    setupDifficultyPicker();
    selectDifficulty(initialPreset.id, { silent: true });

    els.btnWelcomeStart?.addEventListener("click", beginGuide);
    els.welcomeScreen?.addEventListener("click", (ev) => {
      if (ev.target === els.btnWelcomeStart) return;
      beginGuide();
    });
    els.btnStartTraining?.addEventListener("click", startTraining);
    els.btnReplayGuide?.addEventListener("click", beginGuide);
    els.btnSkipToMenu?.addEventListener("click", () => showScreen("menuScreen"));

    els.btnDifferent?.addEventListener("click", () => handleAnswer(false));
    els.btnSame?.addEventListener("click", () => handleAnswer(true));

    els.pauseBtn?.addEventListener("click", pauseGame);
    els.btnResume?.addEventListener("click", resumeGame);
    els.btnSound?.addEventListener("click", toggleSound);
    els.btnMusic?.addEventListener("click", toggleMusic);
    els.btnHelp?.addEventListener("click", openHelp);
    els.btnCloseHelp?.addEventListener("click", closeHelp);

    els.btnContinueLevel?.addEventListener("click", () => {
      if (!state.trainingActive) return;
      window.clearTimeout(state.autoContinueId);
      state.autoContinueId = null;
      closeResult();
      if (state.sessionRemaining <= 0) {
        finishTraining("训练时间=0");
      } else {
        startLevel();
      }
    });
    els.btnRestartTraining?.addEventListener("click", () => {
      closeResult();
      startTraining();
    });
    els.btnResultMenu?.addEventListener("click", () => {
      if (state.trainingActive) {
        abortTrainingToMenu("用户返回设置");
        return;
      }
      closeResult();
      stopAllTimers();
      showScreen("menuScreen");
    });
    els.btnResultReplayGuide?.addEventListener("click", () => {
      closeResult();
      beginGuide();
    });

    window.addEventListener("keydown", (ev) => {
      if (state.screen === "game" && state.levelActive && !state.paused) {
        if (ev.key === "ArrowLeft" || ev.key === "a" || ev.key === "A") handleAnswer(false);
        if (ev.key === "ArrowRight" || ev.key === "d" || ev.key === "D") handleAnswer(true);
        if (ev.key === "Escape") pauseGame();
      } else if (state.paused && ev.key === "Escape") {
        resumeGame();
      }
    });

    updateToggleButtons();
    renderProgressDots();
    preloadCriticalAssets();
  }

  function setupDifficultyPicker() {
    if (!els.difficultyPicker) return;
    els.difficultyPicker.querySelectorAll(".difficulty-option").forEach((button) => {
      button.addEventListener("click", () => selectDifficulty(button.dataset.difficulty));
    });
  }

  function selectDifficulty(id, options = {}) {
    const preset = DIFFICULTY_PRESETS.find((item) => item.id === normalizeDifficultyId(id)) || DIFFICULTY_PRESETS[0];
    state.selectedDifficulty = preset.id;
    state.difficultyStartLevel = clampNumber(Number(preset.startLevel || 1), 1, MAX_LEVEL);
    if (els.startLevel) els.startLevel.value = String(state.difficultyStartLevel);
    if (els.selectedDifficultyText) {
      els.selectedDifficultyText.textContent = `当前：${preset.label}（从第${state.difficultyStartLevel}关开始）`;
    }
    els.difficultyPicker?.querySelectorAll(".difficulty-option").forEach((button) => {
      const active = normalizeDifficultyId(button.dataset.difficulty) === preset.id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (!options.silent) playSfx("click", 520, 0.06);
    return preset;
  }

  function getSelectedDifficultyPreset() {
    return DIFFICULTY_PRESETS.find((item) => item.id === state.selectedDifficulty) || DIFFICULTY_PRESETS[0];
  }

  function getInitialDifficultyPreset() {
    let queryDifficulty = "";
    let queryLevel = null;
    try {
      const params = new URLSearchParams(window.location.search || "");
      for (const name of ["difficulty", "difficultyId", "difficultyMode", "levelMode"]) {
        if (params.has(name)) {
          queryDifficulty = params.get(name) || "";
          break;
        }
      }
      for (const name of ["startLevel", "level"]) {
        if (params.has(name)) {
          queryLevel = Number(params.get(name));
          break;
        }
      }
    } catch {
      queryDifficulty = "";
      queryLevel = null;
    }

    const byQueryText = DIFFICULTY_PRESETS.find((item) => item.id === normalizeDifficultyId(queryDifficulty));
    if (byQueryText) return byQueryText;

    if (Number.isFinite(queryLevel)) {
      const byQueryLevel = DIFFICULTY_PRESETS.find((item) => Number(item.startLevel) === clampNumber(queryLevel, 1, MAX_LEVEL));
      if (byQueryLevel) return byQueryLevel;
    }

    const byBootText = DIFFICULTY_PRESETS.find((item) => item.id === normalizeDifficultyId(BOOT.defaultDifficulty || VERSION.defaultDifficulty || ""));
    if (byBootText) return byBootText;

    const bootLevel = Number(BOOT.defaultStartLevel || VERSION.defaultStartLevel || 1);
    return DIFFICULTY_PRESETS.find((item) => Number(item.startLevel) === clampNumber(bootLevel, 1, MAX_LEVEL)) || DIFFICULTY_PRESETS[0];
  }

  function normalizeDifficultyPresets(raw) {
    const fallback = [
      { id: "easy", label: "容易", startLevel: 1, description: "从第1关开始" },
      { id: "normal", label: "普通", startLevel: 15, description: "从第15关开始" },
      { id: "hard", label: "困难", startLevel: 30, description: "从第30关开始" }
    ];
    const list = Array.isArray(raw) && raw.length ? raw : fallback;
    const normalized = list.map((item, index) => {
      const base = fallback[index] || fallback[0];
      const id = normalizeDifficultyId(item.id || item.key || item.label || base.id);
      return {
        id: id || base.id,
        label: item.label || base.label,
        startLevel: clampNumber(Number(item.startLevel || item.level || base.startLevel), 1, 50),
        description: item.description || `从第${item.startLevel || item.level || base.startLevel}关开始`
      };
    });
    const required = { easy: 1, normal: 15, hard: 30 };
    for (const base of fallback) {
      if (!normalized.some((item) => item.id === base.id)) normalized.push(base);
    }
    return normalized
      .filter((item) => Object.prototype.hasOwnProperty.call(required, item.id))
      .map((item) => ({ ...item, startLevel: required[item.id] }))
      .sort((a, b) => a.startLevel - b.startLevel);
  }

  function normalizeDifficultyId(value) {
    const text = String(value || "").trim().toLowerCase();
    if (["easy", "e", "1", "容易", "简单", "low"].includes(text)) return "easy";
    if (["normal", "medium", "m", "2", "普通", "中等", "默认"].includes(text)) return "normal";
    if (["hard", "h", "3", "困难", "难", "high"].includes(text)) return "hard";
    return text;
  }

  function formatDifficultyLabel() {
    const preset = getSelectedDifficultyPreset();
    return preset ? preset.label : "容易";
  }

  function beginGuide() {
    stopAllTimers();
    state.runId += 1;
    closeResult();
    closeHelp();
    state.guideStep = 0;
    state.guideAnswerLocked = false;
    state.guideComplete = false;
    state.history = [];
    state.paused = false;
    showScreen("gameScreen");
    state.screen = "guide";
    setText(els.difficultyLabel, "引导");
    setText(els.levelTimer, "--:--");
    setText(els.sessionTimer, "--:--");
    setText(els.targetCounter, "0/0");
    setText(els.streakCounter, "0/2");
    renderProgressDots();
    renderGuideStep();
  }

  function renderGuideStep() {
    state.guideAnswerLocked = false;
    const pool = getShapePool(1);
    const shapeA = pool[0] || SHAPES[0];
    const shapeB = pool[1] || SHAPES[1] || shapeA;

    if (state.guideStep === 0) {
      state.guidePrev = shapeA;
      state.guideCurrent = shapeA;
      state.guideExpectedSame = false;
      setText(els.questionText, "记住这张图形（3秒后进入下一条引导）");
      renderCard(shapeA, "enter");
      state.guideAnswerLocked = true;
      hideAnswerRow();
      scheduleQuestionDelay(() => {
        if (state.screen !== "guide" || state.guideStep !== 0) return;
        state.guideStep = 1;
        renderGuideStep();
      }, 3000);
      return;
    }

    if (state.guideStep === 1) {
      state.guideCurrent = state.guidePrev;
      state.guideExpectedSame = true;
      setText(els.questionText, "判断这张图形与上一张图形是否相同：点击绿色按钮");
      renderCard(state.guideCurrent, "enter");
      showAnswerRow();
      decorateGuideButton(true);
      return;
    }

    if (state.guideStep === 2) {
      state.guidePrev = shapeA;
      state.guideCurrent = shapeB.ID === shapeA.ID ? (pool[2] || shapeB) : shapeB;
      state.guideExpectedSame = false;
      setText(els.questionText, "继续判断这张图形与上一张图形是否相同：点击蓝色按钮");
      renderCard(state.guideCurrent, "enter");
      showAnswerRow();
      decorateGuideButton(false);
      return;
    }

    state.guideAnswerLocked = true;
    hideAnswerRow();
    setText(els.questionText, "做得好！准备开始训练吧！");
    renderMenuAfterGuide();
  }

  function decorateGuideButton(expectSame) {
    clearGuideHands();
    const target = expectSame ? els.btnSame : els.btnDifferent;
    if (!target) return;
    const hand = document.createElement("span");
    hand.className = "guide-hand";
    hand.innerHTML = `<img src="${ASSET_BASE}/ui/hand_pointer.svg" alt="" aria-hidden="true">`;
    target.appendChild(hand);
  }

  function clearGuideHands() {
    document.querySelectorAll(".guide-hand").forEach((node) => node.remove());
  }

  function renderMenuAfterGuide() {
    state.guideComplete = true;
    const html = `
      <div>准备开始训练吧！</div>
      <small>正式训练会按配置表读取一致率、关卡倒计时、通关目标、图形范围、积分字段与升降难度规则。</small>
      <div class="result-actions" style="margin-top:20px">
        <button class="primary-btn" id="guideAgainInline">重新演示</button>
        <button class="primary-btn" id="guideEnterInline">进入训练</button>
      </div>`;
    els.resultRibbon.textContent = "做得好！";
    els.resultInfo.innerHTML = html;
    setFinalResultButtons("guide");
    els.resultOverlay.classList.add("active");
    document.getElementById("guideAgainInline")?.addEventListener("click", () => {
      closeResult();
      beginGuide();
    });
    document.getElementById("guideEnterInline")?.addEventListener("click", () => {
      closeResult();
      showScreen("menuScreen");
    });
  }

  function startTraining() {
    ensureAudio();
    stopAllTimers();
    state.runId += 1;

    const secs = clampNumber(Number(els.trainingSeconds?.value || VERSION.defaultTrainingSeconds || 180), 10, 3600);
    const preset = getSelectedDifficultyPreset();
    const startLv = clampNumber(Number(preset.startLevel || 1), 1, MAX_LEVEL);
    if (els.trainingSeconds) els.trainingSeconds.value = String(secs);
    if (els.startLevel) els.startLevel.value = String(startLv);
    selectDifficulty(preset.id, { silent: true });

    state.selectedDifficulty = preset.id;
    state.difficultyStartLevel = startLv;
    state.currentLevel = startLv;
    state.startLevelValue = startLv;
    state.initialSessionSeconds = secs;
    state.sessionRemaining = secs;
    state.levelRemaining = 0;
    state.failStreak = 0;
    state.failSequenceBaseLevel = null;
    state.trainingPassFlag = false;
    state.lastLevelPassed = false;
    state.resultEmitted = false;
    state.lastPayload = null;
    state.totalScore = 0;
    state.levelIndex = 0;
    state.history = [];
    state.paused = false;
    state.trainingActive = true;
    state.screen = "game";
    showScreen("gameScreen");
    closeResult();
    playSfx("level_start", 523, 0.10);
    startGlobalTimer();
    startLevel();
  }

  function startGlobalTimer() {
    if (state.timerId) window.clearInterval(state.timerId);
    state.lastTick = performance.now();
    state.timerId = window.setInterval(tick, 100);
  }

  function startLevel() {
    if (!state.trainingActive) return;
    clearPendingTimeouts();
    closeResult();
    if (state.sessionRemaining <= 0) {
      finishTraining("训练时间=0");
      return;
    }

    state.levelCfg = getLevelConfig(state.currentLevel);
    state.levelRemaining = Math.min(Number(state.levelCfg.Time || 20), Math.max(0, state.sessionRemaining));
    state.correctCount = 0;
    state.wrongCount = 0;
    state.answerCount = 0;
    state.consecutiveWrong = 0;
    state.canAnswer = false;
    state.levelActive = true;
    state.paused = false;
    state.levelIndex += 1;
    state.previousShape = randomFrom(getShapePool(state.levelCfg));
    state.currentShape = state.previousShape;
    clearGuideHands();
    setText(els.questionText, "记住这张图形");
    hideAnswerRow();
    renderCard(state.previousShape, "enter");
    updateHUD();
    renderProgressDots();
    state.lastTick = performance.now();

    scheduleQuestionDelay(() => {
      if (!state.levelActive || state.paused || state.screen !== "game" || state.sessionRemaining <= 0) return;
      nextQuestion();
    }, FIRST_CARD_MS);
  }

  function nextQuestion() {
    if (!state.levelActive || state.screen !== "game" || state.sessionRemaining <= 0) return;
    const cfg = state.levelCfg;
    const pool = getShapePool(cfg);
    const sameRate = Number(cfg.Rate || 50);
    state.expectedSame = Math.random() * 100 < sameRate;
    if (state.expectedSame) {
      state.currentShape = state.previousShape;
    } else {
      state.currentShape = randomDifferent(pool, state.previousShape);
    }

    state.canAnswer = true;
    setText(els.questionText, "这个图形和上一个图形相同吗？");
    renderCard(state.currentShape, "enter");
    showAnswerRow();
    updateHUD();
  }

  function handleAnswer(answerSame) {
    if (state.screen === "guide") {
      handleGuideAnswer(answerSame);
      return;
    }
    if (!state.levelActive || !state.canAnswer || state.paused) return;

    state.canAnswer = false;
    hideAnswerRow();
    state.answerCount += 1;
    const isCorrect = answerSame === state.expectedSame;
    if (isCorrect) {
      state.correctCount += 1;
      state.consecutiveWrong = 0;
      showFloat("正确", "correct");
      playSfx("correct", 680, 0.09);
    } else {
      state.wrongCount += 1;
      state.consecutiveWrong += 1;
      showFloat("错误", "wrong");
      playSfx("wrong", 170, 0.14);
    }
    updateHUD();

    if (!isCorrect && state.consecutiveWrong >= 2) {
      endLevel("连续选错两次", true);
      return;
    }

    state.previousShape = state.currentShape;
    scheduleQuestionDelay(() => {
      if (!state.levelActive || state.paused || state.sessionRemaining <= 0) return;
      nextQuestion();
    }, 450);
  }

  function handleGuideAnswer(answerSame) {
    if (state.guideStep !== 1 && state.guideStep !== 2) return;
    if (state.guideAnswerLocked) return;
    const ok = answerSame === state.guideExpectedSame;
    if (!ok) {
      showFloat("再试一次", "wrong");
      playSfx("wrong", 170, 0.14);
      return;
    }
    state.guideAnswerLocked = true;
    hideAnswerRow();
    showFloat("正确", "correct");
    beep(680, 0.09);
    clearGuideHands();
    if (state.guideStep === 1) {
      state.guideStep = 2;
      scheduleQuestionDelay(renderGuideStep, 450);
    } else {
      state.guideStep = 3;
      scheduleQuestionDelay(renderGuideStep, 450);
    }
  }

  function tick() {
    if (!state.trainingActive || state.screen !== "game") return;
    const now = performance.now();
    if (state.paused) {
      state.lastTick = now;
      return;
    }
    const delta = Math.max(0, (now - state.lastTick) / 1000);
    state.lastTick = now;

    state.sessionRemaining = Math.max(0, state.sessionRemaining - delta);
    if (state.levelActive) state.levelRemaining = Math.max(0, state.levelRemaining - delta);
    updateHUD();

    if (state.sessionRemaining <= 0) {
      if (state.levelActive) {
        endLevel("训练时间=0", false, true);
      } else {
        finishTraining("训练时间=0");
      }
      return;
    }

    if (state.levelActive && state.levelRemaining <= 0) {
      endLevel("倒计时=0", false);
    }
  }

  function endLevel(reason, forcedFail, sessionTimeout = false) {
    if (!state.levelActive) return;
    state.levelActive = false;
    state.canAnswer = false;
    clearQuestionDelay();
    hideAnswerRow();
    animateCardExit();

    const cfg = state.levelCfg;
    const oldLevel = Number(cfg.Level || state.currentLevel);
    const target = getTargetCount(cfg);
    const pass = !forcedFail && state.correctCount >= target;
    state.lastLevelPassed = pass;
    if (pass) state.trainingPassFlag = true;

    const score = calcScore(cfg, state.correctCount, pass);
    state.totalScore += score;

    const nextLevel = adjustDifficulty(pass, oldLevel);
    const trend = nextLevel > oldLevel ? "上升" : (nextLevel < oldLevel ? "下降" : "持平");
    const row = {
      index: state.levelIndex,
      level: oldLevel,
      nextLevel,
      pass,
      reason,
      correct: state.correctCount,
      wrong: state.wrongCount,
      answerCount: state.answerCount,
      target,
      score,
      trend,
      failStreakAfter: state.failStreak,
      shapeRange: getShapeRange(cfg),
      remainingSession: Math.ceil(state.sessionRemaining)
    };
    state.history.push(row);
    state.currentLevel = nextLevel;
    renderProgressDots();
    updateHUD();

    window.clearTimeout(state.levelEndTimeoutId);
    const runToken = state.runId;
    state.levelEndTimeoutId = window.setTimeout(() => {
      state.levelEndTimeoutId = null;
      if (runToken !== state.runId) return;
      if (state.sessionRemaining <= 0 || sessionTimeout) {
        finishTraining(sessionTimeout ? "训练时间=0" : reason, row);
      } else {
        showLevelResult(row);
      }
    }, 220);
  }

  function adjustDifficulty(pass, oldLevel) {
    if (pass) {
      state.failStreak = 0;
      state.failSequenceBaseLevel = null;
      return Math.min(MAX_LEVEL, oldLevel + 1);
    }

    if (state.failStreak === 0) state.failSequenceBaseLevel = oldLevel;
    const baseLevel = Number(state.failSequenceBaseLevel || oldLevel);
    state.failStreak += 1;

    if (state.failStreak === 1) return oldLevel;
    if (state.failStreak === 2) return Math.max(1, baseLevel - 1);

    const next = Math.max(1, baseLevel - 3);
    state.failStreak = 0;
    state.failSequenceBaseLevel = null;
    return next;
  }

  function calcScore(cfg, correct, pass) {
    if (!pass) return 10;
    const target = getTargetCount(cfg);
    const passScore = Number(cfg.PassScore ?? cfg.Scores ?? 0);
    const rewardScore = Number(cfg.RewardScore ?? cfg.BonusScore ?? cfg.Score ?? 0);
    return Math.round(passScore + (correct - target) * rewardScore + 10);
  }

  function showLevelResult(row) {
    if (!state.trainingActive) return;
    playSfx(row.pass ? "success" : "fail", row.pass ? 880 : 180, 0.14);
    els.resultOverlay.classList.add("active");
    setFinalResultButtons("auto");

    els.resultRibbon.textContent = row.pass ? "完成" : "失败";
    els.resultInfo.innerHTML = `
      <div>得分：${row.score}</div>
      <div>趋势：${row.trend}，下一难度：${row.nextLevel}</div>
      <div>通关目标：${row.correct}/${row.target}</div>
      <small>结束原因：${row.reason}；失败计数：${row.failStreakAfter}/3。训练总时长未到 0，将自动继续下一小关。</small>`;

    window.clearTimeout(state.autoContinueId);
    const runToken = state.runId;
    state.autoContinueId = window.setTimeout(() => {
      state.autoContinueId = null;
      if (runToken !== state.runId || !state.trainingActive) return;
      closeResult();
      if (state.sessionRemaining <= 0) finishTraining("训练时间=0", row);
      else startLevel();
    }, AUTO_CONTINUE_MS);
  }

  function finishTraining(reason, finalRow) {
    if (state.resultEmitted && !state.trainingActive) return state.lastPayload;

    const lastRow = finalRow || state.history[state.history.length - 1] || null;
    state.trainingActive = false;
    state.levelActive = false;
    state.canAnswer = false;
    state.paused = false;
    clearPendingTimeouts();
    stopGlobalTimer();
    hideAnswerRow();
    els.gameScreen?.classList.remove("paused-blur");
    els.pauseOverlay?.classList.remove("active");

    const payload = emitTrainingResult(reason, lastRow, false);
    playSfx(payload.passFlag ? "success" : "fail", payload.passFlag ? 880 : 180, 0.16);
    showFinalResult(payload);
    return payload;
  }

  function abortTrainingToMenu(reason) {
    state.runId += 1;
    state.trainingActive = false;
    state.levelActive = false;
    state.canAnswer = false;
    clearPendingTimeouts();
    stopGlobalTimer();
    const lastRow = state.history[state.history.length - 1] || null;
    emitTrainingResult(reason || "用户中止", lastRow, true);
    closeResult();
    showScreen("menuScreen");
  }

  function emitTrainingResult(reason, finalRow, aborted) {
    const usedSeconds = Math.max(0, Math.round(state.initialSessionSeconds - state.sessionRemaining));
    const payload = {
      type: "KX_TRAINING_END",
      gameId: "flash-shape",
      gameTitle: GAME_TITLE,
      version: VERSION_ID,
      versionLabel: VERSION.label || VERSION_ID,
      difficultyId: state.selectedDifficulty,
      difficultyLabel: formatDifficultyLabel(),
      difficultyStartLevel: state.difficultyStartLevel,
      completed: !aborted && state.sessionRemaining <= 0,
      aborted: Boolean(aborted),
      passFlag: state.trainingPassFlag ? 1 : 0,
      passed: Boolean(state.trainingPassFlag),
      passText: state.trainingPassFlag ? "已通关" : "未通关",
      lastLevelPassed: Boolean(state.lastLevelPassed),
      startLevel: state.startLevelValue,
      finalLevel: finalRow ? finalRow.nextLevel : state.currentLevel,
      totalScore: state.totalScore,
      assignedTrainingSeconds: state.initialSessionSeconds,
      usedTrainingSeconds: usedSeconds,
      remainingSeconds: Math.max(0, Math.ceil(state.sessionRemaining)),
      endReason: reason || "训练结束",
      endedAt: new Date().toISOString(),
      history: state.history.map((h) => ({ ...h }))
    };

    state.resultEmitted = true;
    state.lastPayload = payload;

    try {
      if (typeof window.KX_onTrainingEnd === "function") window.KX_onTrainingEnd(payload);
    } catch (err) {
      console.warn("KX_onTrainingEnd failed", err);
    }
    try {
      window.dispatchEvent(new CustomEvent("KX_TRAINING_END", { detail: payload }));
    } catch (err) {
      console.warn("KX_TRAINING_END event failed", err);
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "KX_TRAINING_END", payload }, POST_MESSAGE_TARGET_ORIGIN);
      } else {
        window.postMessage({ type: "KX_TRAINING_END", payload }, POST_MESSAGE_TARGET_ORIGIN);
      }
    } catch (err) {
      console.warn("postMessage failed", err);
    }
    try {
      window.localStorage?.setItem("KX_LAST_TRAINING_RESULT", JSON.stringify(payload));
    } catch {
      // localStorage may be unavailable under file:// or strict browser settings; result has already been emitted above.
    }
    return payload;
  }

  function showFinalResult(payload) {
    els.resultOverlay.classList.add("active");
    setFinalResultButtons("final");
    els.resultRibbon.textContent = payload.passFlag ? "通关啦" : "训练结束";
    els.resultInfo.innerHTML = `
      <div>总得分：${payload.totalScore}</div>
      <div>选择难度：${escapeHtml(payload.difficultyLabel)}（从第${payload.difficultyStartLevel}关开始）</div>
      <div>通关标识：${payload.passText}（passFlag=${payload.passFlag}）</div>
      <div>结束原因：${escapeHtml(payload.endReason)}</div>
      <small>训练时间已到 0 或训练被中止；结果已通过 KX_onTrainingEnd、CustomEvent、postMessage 与 localStorage 传出。</small>
      ${renderHistoryTable()}`;
  }

  function setFinalResultButtons(mode) {
    if (!els.btnContinueLevel || !els.btnRestartTraining || !els.btnResultMenu || !els.btnResultReplayGuide) return;
    if (mode === "guide") {
      els.btnContinueLevel.style.display = "none";
      els.btnRestartTraining.style.display = "none";
      els.btnResultMenu.style.display = "none";
      els.btnResultReplayGuide.style.display = "none";
      return;
    }
    if (mode === "auto") {
      els.btnContinueLevel.style.display = "";
      els.btnContinueLevel.textContent = "立即继续";
      els.btnRestartTraining.style.display = "none";
      els.btnResultMenu.style.display = "";
      els.btnResultReplayGuide.style.display = "none";
      return;
    }
    els.btnContinueLevel.style.display = "none";
    els.btnRestartTraining.style.display = "";
    els.btnResultMenu.style.display = "";
    els.btnResultReplayGuide.style.display = "none";
  }

  function renderHistoryTable() {
    const rows = state.history.slice(-10).map((h) => `
      <tr>
        <td>${h.index}</td><td>${h.level}</td><td>${h.pass ? "通关" : "未通关"}</td>
        <td>${h.correct}/${h.target}</td><td>${h.score}</td><td>${h.trend}</td>
      </tr>`).join("");
    return `
      <table class="table-like">
        <thead><tr><th>小关</th><th>难度</th><th>结果</th><th>N/M</th><th>积分</th><th>趋势</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">暂无小关记录</td></tr>`}</tbody>
      </table>`;
  }

  function pauseGame() {
    if (state.screen !== "game" || !state.levelActive || state.paused) return;
    state.paused = true;
    pauseQuestionDelay();
    els.gameScreen?.classList.add("paused-blur");
    els.pauseOverlay?.classList.add("active");
    updateToggleButtons();
  }

  function resumeGame() {
    if (!state.paused) return;
    state.paused = false;
    state.lastTick = performance.now();
    els.gameScreen?.classList.remove("paused-blur");
    els.pauseOverlay?.classList.remove("active");
    const resumedPending = resumeQuestionDelay();
    if (!resumedPending && state.levelActive && state.screen === "game" && !state.canAnswer) {
      scheduleQuestionDelay(() => {
        if (state.levelActive && state.screen === "game" && !state.paused && !state.canAnswer) nextQuestion();
      }, 250);
    }
  }

  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    updateToggleButtons();
    if (state.soundEnabled) playSfx("click", 520, 0.06);
  }

  function toggleMusic() {
    state.musicEnabled = !state.musicEnabled;
    updateToggleButtons();
    if (state.musicEnabled) {
      try {
        if (!state.bgm) {
          state.bgm = new Audio(`${ASSET_BASE}/audio/bgm_loop.wav`);
          state.bgm.loop = true;
          state.bgm.volume = 0.28;
        }
        state.bgm.play().catch(() => {});
      } catch { /* optional */ }
    } else if (state.bgm) {
      state.bgm.pause();
      state.bgm.currentTime = 0;
    }
  }

  function updateToggleButtons() {
    if (els.btnSound) {
      els.btnSound.textContent = `音效：${state.soundEnabled ? "开" : "关"}`;
      els.btnSound.setAttribute("aria-pressed", String(state.soundEnabled));
    }
    if (els.btnMusic) {
      els.btnMusic.textContent = `音乐：${state.musicEnabled ? "开" : "关"}`;
      els.btnMusic.setAttribute("aria-pressed", String(state.musicEnabled));
    }
  }

  function openHelp() {
    els.helpOverlay?.classList.add("active");
  }

  function closeHelp() {
    els.helpOverlay?.classList.remove("active");
  }

  function closeResult() {
    els.resultOverlay?.classList.remove("active");
    if (els.resultInfo) els.resultInfo.innerHTML = "";
    if (els.btnContinueLevel) {
      els.btnContinueLevel.style.display = "";
      els.btnContinueLevel.textContent = "继续";
    }
    if (els.btnRestartTraining) els.btnRestartTraining.style.display = "";
    if (els.btnResultMenu) els.btnResultMenu.style.display = "";
    if (els.btnResultReplayGuide) els.btnResultReplayGuide.style.display = "";
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((node) => node.classList.remove("active"));
    const target = document.getElementById(id);
    target?.classList.add("active");
    state.screen = id === "gameScreen" ? state.screen : id.replace("Screen", "");
  }

  function getLevelConfig(levelNum) {
    const match = LEVELS.find((lv) => Number(lv.Level) === Number(levelNum));
    return match || LEVELS[0] || { Level: 1, Rate: 50, Type: 1, Time: 20, Score: 10, Scores: 60, TargetCount: 6, Fault: 2, ShapeRange: [1, 30] };
  }

  function getTargetCount(cfg) {
    if (Number(cfg.TargetCount || 0) > 0) return Number(cfg.TargetCount);
    if (Number(cfg.TargetNum || 0) > 0) return Number(cfg.TargetNum);
    const unit = Number(cfg.Score || 1);
    return Math.max(1, Math.ceil(Number(cfg.Scores || 0) / Math.max(1, unit)));
  }

  function getShapeRange(cfgOrType) {
    if (Array.isArray(cfgOrType)) return cfgOrType;
    const cfg = typeof cfgOrType === "object" && cfgOrType ? cfgOrType : null;
    if (cfg) {
      if (Array.isArray(cfg.ShapeRange) && cfg.ShapeRange.length >= 2) return [Number(cfg.ShapeRange[0]), Number(cfg.ShapeRange[1])];
      if (Number(cfg.ShapeMin) > 0 && Number(cfg.ShapeMax) > 0) return [Number(cfg.ShapeMin), Number(cfg.ShapeMax)];
      if (Number(cfg.RangeStart) > 0 && Number(cfg.RangeEnd) > 0) return [Number(cfg.RangeStart), Number(cfg.RangeEnd)];
    }
    const type = cfg ? cfg.Type : cfgOrType;
    const range = SHAPE_RANGES[String(type || 1)] || SHAPE_RANGES["1"] || [1, 100];
    return [Number(range[0]), Number(range[1])];
  }

  function getShapePool(cfgOrType) {
    const range = getShapeRange(cfgOrType);
    let pool = SHAPES.filter((shape) => Number(shape.ID) >= range[0] && Number(shape.ID) <= range[1]);
    if (pool.length < 2) pool = SHAPES.slice();
    return pool;
  }

  function randomFrom(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function randomDifferent(pool, prev) {
    const candidates = pool.filter((shape) => !prev || shape.ID !== prev.ID);
    return randomFrom(candidates.length ? candidates : pool);
  }

  function renderCard(shape, animation) {
    if (!els.card || !shape) return;
    els.card.classList.remove("card-enter", "card-exit");
    els.card.innerHTML = renderShapeImg(shape);
    attachCardFallback(shape);
    if (animation) {
      void els.card.offsetWidth;
      els.card.classList.add(animation === "exit" ? "card-exit" : "card-enter");
    }
  }

  function animateCardExit() {
    if (!els.card) return;
    els.card.classList.remove("card-enter");
    void els.card.offsetWidth;
    els.card.classList.add("card-exit");
  }

  function renderShapeImg(shape) {
    const label = shapeLabel(shape);
    const src = resolveIconSrc(shape, "svg");
    return `<img class="shape-img" draggable="false" loading="eager" decoding="async" src="${escapeAttr(src)}" alt="${escapeAttr(label)}" data-icon="${escapeAttr(shape.Icon || "")}">`;
  }

  function attachCardFallback(shape) {
    const img = els.card?.querySelector("img.shape-img");
    if (!img) return;
    img.addEventListener("error", () => {
      if (img.dataset.fallbackApplied === "1") return;
      img.dataset.fallbackApplied = "1";
      img.replaceWith(createInlineShapeElement(shape));
    }, { once: true });
  }

  function createInlineShapeElement(shape) {
    const node = document.createElement("div");
    node.className = "shape-svg inline-fallback";
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", shapeLabel(shape));
    node.innerHTML = renderInlineShapeSvg(shape);
    return node;
  }

  function shapeLabel(shape) {
    const colorInfo = COLORS[String(shape.Color)] || { hex: "#45D28B", name: "颜色" };
    return `${colorInfo.name || ""}${SHAPE_NAMES[String(shape.Shape)] || ""}，${TEXTURE_NAMES[String(shape.Texture)] || ""}`;
  }

  function renderInlineShapeSvg(shape) {
    const colorInfo = COLORS[String(shape.Color)] || { hex: "#45D28B" };
    const fill = String(colorInfo.hex || "#45D28B").replace(/[^#A-Fa-f0-9]/g, "") || "#45D28B";
    const id = `fallback_${Number(shape.ID || 0)}_${Number(shape.Texture || 0)}`;
    const texture = Number(shape.Texture || 1);
    const pattern = texture === 2
      ? `<pattern id="${id}" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="${fill}"/><rect width="8" height="8" fill="rgba(255,255,255,.16)"/><rect x="8" y="8" width="8" height="8" fill="rgba(0,0,0,.10)"/></pattern>`
      : texture === 3
        ? `<pattern id="${id}" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="12" height="12" fill="${fill}"/><rect width="4" height="12" fill="rgba(255,255,255,.20)"/></pattern>`
        : "";
    const fillRef = texture > 1 ? `url(#${id})` : fill;
    const shapes = {
      1: `<polygon points="64,12 113,48 95,108 29,108 15,48"/>`,
      2: `<rect x="20" y="20" width="88" height="88" rx="22"/><rect x="51" y="51" width="26" height="26" rx="4" fill="rgba(255,255,255,.78)"/>`,
      3: `<polygon points="64,10 78,47 118,48 86,72 98,111 64,88 30,111 42,72 10,48 50,47"/>`,
      4: `<path d="M50 14h28v36h36v28H78v36H50V78H14V50h36z"/>`,
      5: `<polygon points="64,13 116,108 12,108"/>`
    };
    return `<svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <defs>${pattern}<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="5" flood-opacity=".20"/></filter></defs>
      <g filter="url(#shadow)" fill="${fillRef}" stroke="rgba(255,255,255,.55)" stroke-width="4" stroke-linejoin="round">${shapes[Number(shape.Shape || 1)] || shapes[1]}</g>
      <circle cx="92" cy="92" r="2.2" fill="rgba(255,255,255,.42)"/>
    </svg>`;
  }

  function resolveIconSrc(shape, ext) {
    const icon = String(shape.Icon || "").trim();
    if (icon) {
      const safeIcon = icon.replace(/[^A-Za-z0-9_-]/g, "");
      return `${ASSET_BASE}/icons/${safeIcon}.${ext || "svg"}`;
    }
    const id = String(shape.ID).padStart(3, "0");
    return `${ASSET_BASE}/shapes/shape_${id}.${ext || "svg"}`;
  }

  function updateHUD() {
    const cfg = state.levelCfg || getLevelConfig(state.currentLevel);
    const target = getTargetCount(cfg);
    setText(els.difficultyLabel, `${formatDifficultyLabel()} · 难度 ${Number(cfg.Level || state.currentLevel)}`);
    setText(els.levelTimer, formatTime(Math.ceil(state.levelRemaining)));
    setText(els.sessionTimer, formatTime(Math.ceil(state.sessionRemaining)));
    setText(els.targetCounter, `${state.correctCount}/${target}`);
    setText(els.streakCounter, `${state.consecutiveWrong}/2`);
    setText(els.historyText, `本关答题 ${state.answerCount}，错误 ${state.wrongCount}；一致率 ${Number(cfg.Rate || 50)}%；图形范围 ${formatShapeRange(cfg)}。`);
  }

  function formatShapeRange(cfgOrType) {
    const range = getShapeRange(cfgOrType);
    return `${range[0]}-${range[1]}`;
  }

  function renderProgressDots() {
    if (!els.progressDots) return;
    const recent = state.history.slice(-5);
    const dots = Array.from({ length: 5 }, (_, idx) => {
      const h = recent[idx];
      const cls = h ? (h.pass ? "pass" : "fail") : "";
      return `<span class="${cls}"></span>`;
    }).join("");
    els.progressDots.innerHTML = dots;
  }

  function showAnswerRow() {
    els.answerRow?.classList.remove("hidden");
  }

  function hideAnswerRow() {
    els.answerRow?.classList.add("hidden");
  }

  function showFloat(text, type) {
    if (!els.floatLayer) return;
    const node = document.createElement("div");
    node.className = `float-msg ${type || ""}`;
    node.textContent = text;
    els.floatLayer.appendChild(node);
    window.setTimeout(() => node.remove(), 520);
  }

  function stopAllTimers() {
    stopGlobalTimer();
    clearPendingTimeouts();
    state.trainingActive = false;
    state.levelActive = false;
    state.canAnswer = false;
  }

  function stopGlobalTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function scheduleQuestionDelay(fn, delayMs) {
    clearQuestionDelay();
    const runToken = state.runId;
    const delay = Math.max(0, Number(delayMs) || 0);
    state.questionDelayFn = () => {
      if (runToken !== state.runId) return;
      fn();
    };
    state.questionDelayRemainingMs = delay;
    state.questionDelayDueAt = performance.now() + delay;
    state.questionDelayId = window.setTimeout(() => {
      const cb = state.questionDelayFn;
      clearQuestionDelay();
      if (typeof cb === "function") cb();
    }, delay);
  }

  function clearQuestionDelay() {
    window.clearTimeout(state.questionDelayId);
    state.questionDelayId = null;
    state.questionDelayFn = null;
    state.questionDelayDueAt = 0;
    state.questionDelayRemainingMs = 0;
  }

  function pauseQuestionDelay() {
    if (!state.questionDelayId) return false;
    state.questionDelayRemainingMs = Math.max(0, state.questionDelayDueAt - performance.now());
    window.clearTimeout(state.questionDelayId);
    state.questionDelayId = null;
    state.questionDelayDueAt = 0;
    return true;
  }

  function resumeQuestionDelay() {
    if (!state.questionDelayFn || state.questionDelayId) return false;
    const cb = state.questionDelayFn;
    const delay = Math.max(0, state.questionDelayRemainingMs || 0);
    state.questionDelayDueAt = performance.now() + delay;
    state.questionDelayId = window.setTimeout(() => {
      const fn = state.questionDelayFn || cb;
      clearQuestionDelay();
      if (typeof fn === "function") fn();
    }, delay);
    return true;
  }

  function clearPendingTimeouts() {
    clearQuestionDelay();
    window.clearTimeout(state.autoContinueId);
    window.clearTimeout(state.levelEndTimeoutId);
    state.autoContinueId = null;
    state.levelEndTimeoutId = null;
  }

  function preloadCriticalAssets() {
    const imageUrls = new Set([
      `${ASSET_BASE}/ui/title_logo.svg`,
      `${ASSET_BASE}/ui/bg_game.svg`,
      `${ASSET_BASE}/ui/bg_menu.svg`,
      `${ASSET_BASE}/ui/help_rule_card.svg`,
      `${ASSET_BASE}/ui/hand_pointer.svg`,
      `${ASSET_BASE}/mascot/xkk_wave.svg`,
      `${ASSET_BASE}/mascot/xkk_idle.svg`,
      `${ASSET_BASE}/mascot/xkk_happy.svg`,
      ...SHAPES.map((shape) => resolveIconSrc(shape, "svg"))
    ]);
    imageUrls.forEach((url) => {
      try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        state.imageCache.push(img);
      } catch { /* image preload is best-effort */ }
    });

    ["click", "correct", "wrong", "level_start", "success", "fail"].forEach((name) => {
      try {
        const audio = new Audio(`${ASSET_BASE}/audio/${name}.wav`);
        audio.preload = "auto";
        audio.volume = name === "wrong" || name === "fail" ? 0.24 : 0.22;
        state.audioCache[name] = audio;
      } catch { /* audio preload is best-effort */ }
    });
  }

  function playSfx(name, fallbackFreq, duration) {
    if (!state.soundEnabled) return;
    try {
      const cached = state.audioCache[name];
      const a = cached ? cached.cloneNode(true) : new Audio(`${ASSET_BASE}/audio/${name}.wav`);
      a.volume = name === "wrong" || name === "fail" ? 0.24 : 0.22;
      a.play().catch(() => beep(fallbackFreq || 520, duration || 0.08));
    } catch {
      beep(fallbackFreq || 520, duration || 0.08);
    }
  }

  function ensureAudio() {
    if (state.audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      state.audioCtx = new AC();
    } catch {
      state.audioCtx = null;
    }
  }

  function beep(freq, duration) {
    if (!state.soundEnabled) return;
    ensureAudio();
    const ctx = state.audioCtx;
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration + 0.02);
    } catch {
      // Audio is optional; ignore browser audio restrictions.
    }
  }

  function readBootText(paramNames, fallback) {
    let value = fallback;
    try {
      const params = new URLSearchParams(window.location.search || "");
      for (const name of paramNames) {
        if (params.has(name)) {
          value = params.get(name);
          break;
        }
      }
    } catch {
      value = fallback;
    }
    return value;
  }

  function readBootNumber(paramNames, fallback, min, max) {
    let value = fallback;
    try {
      const params = new URLSearchParams(window.location.search || "");
      for (const name of paramNames) {
        if (params.has(name)) {
          value = Number(params.get(name));
          break;
        }
      }
    } catch {
      value = fallback;
    }
    return clampNumber(Number(value), min, max);
  }

  function formatTime(totalSeconds) {
    const sec = Math.max(0, Number(totalSeconds) || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function clampNumber(n, min, max) {
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function escapeHtml(value) {
    return escapeAttr(value);
  }

  window.KX_DEBUG = {
    getState: () => JSON.parse(JSON.stringify({ ...state, audioCtx: null, bgm: null })),
    getTargetCount,
    calcScore,
    getShapeRange,
    getShapePoolIds: (cfgOrType) => getShapePool(cfgOrType).map((shape) => shape.ID),
    getDifficultyPresets: () => DIFFICULTY_PRESETS.map((item) => ({ ...item })),
    getSelectedDifficultyPreset: () => ({ ...getSelectedDifficultyPreset() }),
    selectDifficulty,
    getGuideAnswerLocked: () => state.guideAnswerLocked,
    resolveIconSrc,
    renderInlineShapeSvg,
    preloadCriticalAssets,
    adjustDifficultyPreview: (startLevel, outcomes) => {
      const oldFailStreak = state.failStreak;
      const oldBase = state.failSequenceBaseLevel;
      let level = Number(startLevel);
      const steps = [];
      state.failStreak = 0;
      state.failSequenceBaseLevel = null;
      for (const pass of outcomes) {
        const next = adjustDifficulty(Boolean(pass), level);
        steps.push({ pass: Boolean(pass), from: level, to: next, failStreak: state.failStreak });
        level = next;
      }
      state.failStreak = oldFailStreak;
      state.failSequenceBaseLevel = oldBase;
      return steps;
    }
  };
})();

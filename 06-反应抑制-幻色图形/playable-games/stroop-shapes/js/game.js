(() => {
  'use strict';

  const CFG = window.GAME_CONFIG;
  if (!CFG) throw new Error('GAME_CONFIG 未加载');

  const byId = (id) => document.getElementById(id);
  const qsa = (selector) => [...document.querySelectorAll(selector)];
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const positiveNumber = (value, fallback) => {
    const n = toNumber(value, fallback);
    return n > 0 ? n : fallback;
  };
  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const fmtTime = (sec) => {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };
  const fmtSub = (sec) => Math.max(0, sec).toFixed(1);
  const fmtPct = (value) => `${Math.round(clamp(value, 0, 100))}%`;
  const accuracyText = (correct, attempts) => attempts > 0 ? `${Math.round((correct / attempts) * 1000) / 10}%` : '—';

  const els = {
    screens: qsa('.screen'),
    splashContinue: byId('splashContinue'),
    durationSelect: byId('durationSelect'),
    guideBack: byId('guideBack'),
    guideSkip: byId('guideSkip'),
    guideStepText: byId('guideStepText'),
    guideProgressBar: byId('guideProgressBar'),
    guideTitle: byId('guideTitle'),
    guideBody: byId('guideBody'),
    guideBullets: byId('guideBullets'),
    guideDecision: byId('guideDecision'),
    guidePrompt: byId('guidePrompt'),
    guideShape: byId('guideShape'),
    guideWord: byId('guideWord'),
    guideHint: byId('guideHint'),
    guideNo: byId('guideNo'),
    guideYes: byId('guideYes'),
    guidePrev: byId('guidePrev'),
    guideNext: byId('guideNext'),
    replayGuide: byId('replayGuide'),
    enterTraining: byId('enterTraining'),
    pauseBtn: byId('pauseBtn'),
    resumeBtn: byId('resumeBtn'),
    helpBtn: byId('helpBtn'),
    quitBtn: byId('quitBtn'),
    soundToggle: byId('soundToggle'),
    musicToggle: byId('musicToggle'),
    pauseNote: byId('pauseNote'),
    hudDifficulty: byId('hudDifficulty'),
    hudLevel: byId('hudLevel'),
    hudTrainingTime: byId('hudTrainingTime'),
    hudSubTime: byId('hudSubTime'),
    hudTarget: byId('hudTarget'),
    hudScore: byId('hudScore'),
    trainingProgress: byId('trainingProgress'),
    trainingPercent: byId('trainingPercent'),
    subProgress: byId('subProgress'),
    subPercent: byId('subPercent'),
    wrongStatus: byId('wrongStatus'),
    targetStatus: byId('targetStatus'),
    passRibbon: byId('passRibbon'),
    gameScreen: byId('gameScreen'),
    stage: byId('stimulusStage'),
    shapeImg: byId('shapeImg'),
    wordText: byId('wordText'),
    feedback: byId('feedback'),
    answerNo: byId('answerNo'),
    answerYes: byId('answerYes'),
    summaryModal: byId('summaryModal'),
    summaryTitle: byId('summaryTitle'),
    summaryResult: byId('summaryResult'),
    trendBars: byId('trendBars'),
    continueBtn: byId('continueBtn'),
    pauseModal: byId('pauseModal'),
    finalModal: byId('finalModal'),
    finalStats: byId('finalStats'),
    exportResultBtn: byId('exportResultBtn'),
    restartBtn: byId('restartBtn')
  };

  const state = {
    difficultyKey: 'easy',
    difficultyLabel: '容易',
    startLevel: 1,
    currentLevel: 1,
    bestLevel: 1,
    maxLevel: CFG.maxLevel || 100,
    totalScore: 0,
    actual: 0,
    target: 1,
    subAttempts: 0,
    subCorrect: 0,
    subWrong: 0,
    totalAttempts: 0,
    totalCorrect: 0,
    totalWrong: 0,
    consecutiveWrong: 0,
    failureStreak: 0,
    failureBaseLevel: null,
    passFlag: false,
    trainingDurationSec: CFG.defaultTrainingDurationSec || 300,
    trainingRemainingSec: CFG.defaultTrainingDurationSec || 300,
    subRemainingSec: 0,
    subDurationSec: 0,
    currentQuestion: null,
    inputLocked: false,
    paused: false,
    inSubLevel: false,
    lastTick: 0,
    tickHandle: null,
    history: [],
    soundEnabled: true,
    musicEnabled: false,
    lastFinalResult: null,
    guideStep: 0,
    guideReturnMode: 'start',
    transitionToken: 0,
    pendingTransition: null
  };

  const audios = {
    correct: new Audio('assets/audio/correct.wav'),
    wrong: new Audio('assets/audio/wrong.wav'),
    flip: new Audio('assets/audio/flip.wav'),
    click: new Audio('assets/audio/click.wav'),
    ambient: new Audio('assets/audio/ambient.wav')
  };
  audios.ambient.loop = true;
  audios.ambient.volume = 0.30;
  Object.entries(audios).forEach(([name, audio]) => {
    if (name !== 'ambient') audio.preload = 'auto';
  });

  function play(name) {
    if (!state.soundEnabled && name !== 'ambient') return;
    const audio = audios[name];
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (_) {}
  }

  function setMusic(on) {
    state.musicEnabled = on;
    els.musicToggle.textContent = on ? '开启' : '关闭';
    els.musicToggle.setAttribute('aria-pressed', String(on));
    if (on) audios.ambient.play().catch(() => {});
    else audios.ambient.pause();
  }

  function colorByName(name, fallbackIndex = 0) {
    return CFG.colors.find((color) => color.name === name) || CFG.colors[fallbackIndex] || CFG.colors[0];
  }

  function assetPath(shapeId, colorKey) {
    return `assets/shapes/${shapeId}_${colorKey}.svg`;
  }

  const guideSteps = [
    {
      title: '第一步：目标不是看形状，而是比较颜色含义',
      body: '每一题有两张卡片。左边是带颜色的图形，右边是一个颜色词。你只需要判断“左边图形的颜色”和“右边文字的含义”是否一致。',
      bullets: ['左边图形是黄色六边形。', '右边文字写的是“黄色”。', '两边含义一致，所以选择“√ 一致”。'],
      prompt: '左边图形颜色 = 黄色；右边文字含义 = 黄色。',
      shape: { id: 'hexagon', color: '黄色' },
      word: '黄色',
      textColor: '红色',
      expected: true,
      decision: '正确选择：√ 一致',
      hint: '请点击右侧绿色打勾按钮。'
    },
    {
      title: '第二步：右边文字的“显示颜色”是干扰项',
      body: '右边文字可能用另一种颜色显示，但判断时只读文字内容。比如“黄色”两个字即使用蓝色显示，它的含义仍然是黄色。',
      bullets: ['不要把右边字的墨水颜色当成答案。', '只读文字写了什么颜色。', '左边黄色，文字含义黄色，仍然选“√ 一致”。'],
      prompt: '文字颜色会干扰你，但文字含义才参与判断。',
      shape: { id: 'circle', color: '黄色' },
      word: '黄色',
      textColor: '蓝色',
      expected: true,
      decision: '正确选择：√ 一致',
      hint: '这一题仍然一致，请点击打勾。'
    },
    {
      title: '第三步：颜色含义不相同，就选 X',
      body: '左边图形颜色和右边文字含义不一致时，选择红色 X。',
      bullets: ['左边图形是蓝色。', '右边文字写的是“红色”。', '蓝色和红色不一致，所以选择“X 不一致”。'],
      prompt: '左边图形颜色 = 蓝色；右边文字含义 = 红色。',
      shape: { id: 'circle', color: '蓝色' },
      word: '红色',
      textColor: '黄色',
      expected: false,
      decision: '正确选择：X 不一致',
      hint: '请点击左侧红色 X 按钮。'
    },
    {
      title: '第四步：常见陷阱：字的颜色正确，不代表答案正确',
      body: '这一题右边“红色”两个字本身显示为蓝色，但文字含义是红色。左边图形是蓝色，所以蓝色和红色不一致。',
      bullets: ['看左边：图形颜色是蓝色。', '读右边：文字含义是红色。', '不要被右边字的显示颜色“蓝色”带偏。'],
      prompt: '左边图形颜色 = 蓝色；右边文字含义 = 红色。',
      shape: { id: 'triangle', color: '蓝色' },
      word: '红色',
      textColor: '蓝色',
      expected: false,
      decision: '正确选择：X 不一致',
      hint: '这是最容易误判的一类题，请点击红色 X。'
    },
    {
      title: '第五步：再练一次，确认你忽略了干扰色',
      body: '这一题文字显示成紫色，但它写的是“绿色”。判断时仍然只比较左边图形颜色和文字含义。',
      bullets: ['左边图形是绿色。', '右边文字含义是绿色。', '文字显示成紫色不影响答案，所以选择“√ 一致”。'],
      prompt: '左边图形颜色 = 绿色；右边文字含义 = 绿色。',
      shape: { id: 'triangle', color: '绿色' },
      word: '绿色',
      textColor: '紫色',
      expected: true,
      decision: '正确选择：√ 一致',
      hint: '请点击右侧绿色打勾按钮。'
    },
    {
      title: '第六步：看懂小关目标、连错提醒和进度条',
      body: '主界面上方的“目标”显示为“实际完成数 / 小关目标”。状态条会显示训练剩余、小关剩余、连续错误次数，以及距离达标还差几次。',
      bullets: ['完成数达到目标，小关结算时判定为训练成功。', '训练剩余进度条表示整次训练还剩多久。', '小关剩余进度条表示当前小关还剩多久。'],
      prompt: '本步是界面说明，不需要答题。',
      shape: { id: 'hexagon', color: '粉色' },
      word: '粉色',
      textColor: '黑色',
      expected: null,
      decision: '界面重点：目标、训练剩余、小关剩余、连错次数。',
      hint: '点击“下一步”继续查看小关结束条件。'
    },
    {
      title: '第七步：小关怎样结束，以及怎样升降级',
      body: '小关会在倒计时归零或连续选错达到阈值时结束。当前配置按文档使用连续选错 2 次。小关成功等级 +1；失败按连续失败次数进行难度保护和降级。',
      bullets: ['小关内，只要没触发结束条件，每次选择后都会刷新下一题。', '失败 1 次：原难度继续；失败 2 次：按失败段起点 -1。', '失败 3 次：按失败段起点 -3，并重置失败计数，最低不会低于 1 级。'],
      prompt: '本步是规则说明，不需要答题。',
      shape: { id: 'circle', color: '灰色' },
      word: '黑色',
      textColor: '灰色',
      expected: null,
      decision: '规则：倒计时到 0 或连续错 2 次，小关结束。',
      hint: '点击“下一步”查看积分、通关和快捷键。'
    },
    {
      title: '第八步：难度、积分、通关和操作方式',
      body: '容易、普通、困难分别从第 1、15、30 关开始。达到最高等级后会保留通关标识，并继续训练到总计时结束。',
      bullets: ['成功得分：通关积分 +（实际数 - 目标数）× 奖励分 + 10。', '失败得分：只获得 10 分基础分。', '快捷键：← 或 X = 不一致；→ 或 Enter = 一致；Esc = 暂停。'],
      prompt: '教程结束后进入正式训练。',
      shape: { id: 'triangle', color: '棕色' },
      word: '蓝色',
      textColor: '绿色',
      expected: null,
      decision: '准备好后点击“完成教程”。',
      hint: '点击“完成教程”后即可开始或返回训练。'
    }
  ];

  function showScreen(name) {
    els.screens.forEach((screen) => {
      screen.classList.toggle('screen-active', screen.dataset.screen === name);
    });
  }

  function isGameScreenActive() {
    return els.gameScreen && els.gameScreen.classList.contains('screen-active');
  }

  function levelConfig(level) {
    const idx = clamp(level, 1, state.maxLevel) - 1;
    return CFG.levels[idx] || CFG.levels[CFG.levels.length - 1];
  }

  function availableColors(cfg) {
    return CFG.colors.slice(0, clamp(positiveNumber(cfg.Value, 2), 2, CFG.colors.length));
  }

  function targetFor(cfg) {
    return positiveNumber(cfg.MissionPass, positiveNumber(cfg.MissionNum, 1));
  }

  function wrongLimitFor(cfg) {
    return positiveNumber(cfg.Fault, CFG.subLevelEndRules?.consecutiveWrongLimit || 2);
  }

  function timeFor(cfg) {
    return positiveNumber(cfg.Time, 15);
  }

  function rewardScoreFor(cfg) {
    return toNumber(cfg.Scores, toNumber(cfg.RewardNum, toNumber(cfg.Reward, 0)));
  }

  function setInputLocked(locked) {
    state.inputLocked = locked;
    els.answerYes.disabled = locked;
    els.answerNo.disabled = locked;
  }

  function startWithDifficulty(key) {
    const diff = CFG.difficultyStarts[key] || CFG.difficultyStarts.easy;
    state.difficultyKey = key;
    state.difficultyLabel = diff.label;
    state.startLevel = diff.startLevel;
    state.currentLevel = diff.startLevel;
    state.bestLevel = diff.startLevel;
    state.trainingDurationSec = positiveNumber(els.durationSelect.value, CFG.defaultTrainingDurationSec || 300);
    enterGuide(0, 'start');
  }

  function enterGuide(step = 0, mode = state.guideReturnMode || 'start') {
    state.guideReturnMode = mode;
    state.guideStep = clamp(step, 0, guideSteps.length - 1);
    showScreen('guide');
    updateGuideStep();
  }

  function updateGuideStep() {
    const step = guideSteps[state.guideStep];
    const shapeColor = colorByName(step.shape.color, 1);
    const textColor = colorByName(step.textColor, 0);
    const progress = Math.round(((state.guideStep + 1) / guideSteps.length) * 100);

    els.guideStepText.textContent = `${state.guideStep + 1} / ${guideSteps.length}`;
    els.guideProgressBar.style.width = `${progress}%`;
    els.guideTitle.textContent = step.title;
    els.guideBody.textContent = step.body;
    els.guideBullets.innerHTML = step.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    els.guideDecision.textContent = step.decision;
    els.guidePrompt.textContent = step.prompt;
    els.guideShape.src = assetPath(step.shape.id, shapeColor.key);
    els.guideShape.alt = `${shapeColor.name}${step.shape.id}`;
    els.guideWord.textContent = step.word;
    els.guideWord.style.color = textColor.hex;
    els.guideHint.textContent = step.hint;
    els.guideNo.classList.remove('pulse');
    els.guideYes.classList.remove('pulse');
    els.guideNo.disabled = step.expected === null;
    els.guideYes.disabled = step.expected === null;

    if (step.expected === true) els.guideYes.classList.add('pulse');
    if (step.expected === false) els.guideNo.classList.add('pulse');

    els.guidePrev.disabled = state.guideStep === 0;
    els.guideNext.textContent = state.guideStep === guideSteps.length - 1 ? '完成教程' : '下一步';
    els.guideBack.textContent = state.guideReturnMode === 'resume' ? '返回训练' : '返回难度';
    els.enterTraining.textContent = state.guideReturnMode === 'resume' ? '返回训练' : '进入训练';
  }

  function completeGuide() {
    showScreen('guide-complete');
    els.enterTraining.textContent = state.guideReturnMode === 'resume' ? '返回训练' : '进入训练';
  }

  function advanceGuide() {
    if (state.guideStep >= guideSteps.length - 1) {
      completeGuide();
      return;
    }
    enterGuide(state.guideStep + 1, state.guideReturnMode);
  }

  function handleGuideAnswer(answer) {
    play('click');
    const step = guideSteps[state.guideStep];
    if (step.expected === null) {
      els.guideHint.textContent = '本步是规则说明，不需要选择答案；请点击“下一步”。';
      return;
    }
    if (answer !== step.expected) {
      els.guideHint.textContent = step.expected ? '这一组是一致，请点击绿色打勾。' : '这一组不一致，请点击红色 X。';
      return;
    }
    els.guideHint.textContent = '判断正确。';
    advanceGuide();
  }

  function resetTrainingState() {
    state.currentLevel = state.startLevel;
    state.bestLevel = state.startLevel;
    state.totalScore = 0;
    state.actual = 0;
    state.target = 1;
    state.subAttempts = 0;
    state.subCorrect = 0;
    state.subWrong = 0;
    state.totalAttempts = 0;
    state.totalCorrect = 0;
    state.totalWrong = 0;
    state.consecutiveWrong = 0;
    state.failureStreak = 0;
    state.failureBaseLevel = null;
    state.passFlag = false;
    state.trainingRemainingSec = state.trainingDurationSec;
    state.subRemainingSec = 0;
    state.subDurationSec = 0;
    state.currentQuestion = null;
    state.history = [];
    state.lastFinalResult = null;
    state.paused = false;
    state.inSubLevel = false;
    state.pendingTransition = null;
    state.transitionToken += 1;
    document.body.classList.remove('pause-open');
  }

  function startTraining() {
    state.guideReturnMode = 'start';
    resetTrainingState();
    showScreen('game');
    closeModal(els.finalModal);
    closeModal(els.summaryModal);
    closeModal(els.pauseModal);
    startSubLevel();
    startTicker();
  }

  function startTicker() {
    clearInterval(state.tickHandle);
    state.lastTick = performance.now();
    state.tickHandle = setInterval(tick, 100);
  }

  function stopTicker() {
    clearInterval(state.tickHandle);
    state.tickHandle = null;
  }

  function tick() {
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - state.lastTick) / 1000));
    state.lastTick = now;
    if (state.paused || !state.inSubLevel) return;

    state.trainingRemainingSec -= dt;
    state.subRemainingSec -= dt;
    updateHud();

    if (state.trainingRemainingSec <= 0) {
      finishTraining('timeOut');
      return;
    }
    if (state.subRemainingSec <= 0) finishSubLevel('倒计时结束');
  }

  function startSubLevel() {
    if (state.trainingRemainingSec <= 0) return finishTraining('timeOut');
    const cfg = levelConfig(state.currentLevel);
    state.transitionToken += 1;
    state.pendingTransition = null;
    state.actual = 0;
    state.target = targetFor(cfg);
    state.subAttempts = 0;
    state.subCorrect = 0;
    state.subWrong = 0;
    state.consecutiveWrong = 0;
    state.subDurationSec = timeFor(cfg);
    state.subRemainingSec = state.subDurationSec;
    state.bestLevel = Math.max(state.bestLevel, state.currentLevel);
    state.inSubLevel = true;
    state.paused = false;
    els.stage.classList.remove('leaving', 'entering');
    els.passRibbon.classList.toggle('hidden', !state.passFlag);
    updateHud();
    generateQuestion(true);
  }

  function generateQuestion(first = false) {
    const cfg = levelConfig(state.currentLevel);
    const colors = availableColors(cfg);
    const shouldMatch = Math.random() * 100 < positiveNumber(cfg.Rate, 50);
    const leftColor = rand(colors);
    let wordMeaning = leftColor;

    if (!shouldMatch) {
      const choices = colors.filter((color) => color.id !== leftColor.id);
      wordMeaning = rand(choices.length ? choices : colors);
    }

    const displayColor = rand(colors);
    const shape = rand(CFG.shapes);
    state.currentQuestion = {
      match: leftColor.id === wordMeaning.id,
      leftColor,
      wordMeaning,
      displayColor,
      shape
    };

    els.shapeImg.src = assetPath(shape.id, leftColor.key);
    els.shapeImg.alt = `${leftColor.name}${shape.name}`;
    els.wordText.textContent = wordMeaning.name;
    els.wordText.style.color = displayColor.hex;
    els.stage.classList.remove('leaving');
    els.stage.classList.add('entering');
    setInputLocked(true);
    play('flip');
    const token = state.transitionToken;
    window.setTimeout(() => {
      if (token !== state.transitionToken || !state.inSubLevel) return;
      els.stage.classList.remove('entering');
      if (!state.paused) setInputLocked(false);
    }, first ? 220 : 200);
  }

  function answer(isMatch) {
    if (state.inputLocked || state.paused || !state.inSubLevel || !state.currentQuestion) return;
    const correct = Boolean(isMatch) === Boolean(state.currentQuestion.match);
    const cfgAtAnswer = levelConfig(state.currentLevel);
    const token = ++state.transitionToken;

    state.subAttempts += 1;
    state.totalAttempts += 1;
    if (correct) {
      state.actual += 1;
      state.subCorrect += 1;
      state.totalCorrect += 1;
      state.consecutiveWrong = 0;
    } else {
      state.subWrong += 1;
      state.totalWrong += 1;
      state.consecutiveWrong += 1;
    }

    updateHud();
    animateFeedback(correct);
    play(correct ? 'correct' : 'wrong');
    const wrongLimit = wrongLimitFor(cfgAtAnswer);
    const hitWrongLimit = state.consecutiveWrong >= wrongLimit;

    window.setTimeout(() => {
      if (token !== state.transitionToken || !state.inSubLevel) return;
      els.stage.classList.add('leaving');
    }, 190);

    window.setTimeout(() => {
      if (token !== state.transitionToken || !state.inSubLevel) return;
      completeAfterAnswerTransition({ hitWrongLimit, wrongLimit, levelAtAnswer: state.currentLevel });
    }, 410);
  }

  function completeAfterAnswerTransition(context) {
    if (!state.inSubLevel) return;
    if (state.paused) {
      state.pendingTransition = context;
      return;
    }
    state.pendingTransition = null;
    els.stage.classList.remove('leaving');
    if (state.trainingRemainingSec <= 0) return finishTraining('timeOut');
    if (context.hitWrongLimit) return finishSubLevel(`连续选错 ${context.wrongLimit} 次`);
    if (state.subRemainingSec <= 0) return finishSubLevel('倒计时结束');
    generateQuestion(false);
  }

  function animateFeedback(correct) {
    setInputLocked(true);
    els.feedback.textContent = correct ? '正确' : '错误';
    els.feedback.className = `feedback show ${correct ? 'good' : 'bad'}`;
    window.setTimeout(() => {
      els.feedback.className = 'feedback';
    }, 420);
  }

  function calcScore(success, cfg) {
    if (!success) return 10;
    return Math.round(toNumber(cfg.Score, 0) + (state.actual - state.target) * rewardScoreFor(cfg) + 10);
  }

  function applyProgressResult(success, beforeLevel) {
    if (success) {
      state.failureStreak = 0;
      state.failureBaseLevel = null;
      state.currentLevel = beforeLevel + 1;
      return '训练成功，难度 +1';
    }

    state.failureStreak += 1;
    if (state.failureStreak === 1 || state.failureBaseLevel === null) {
      state.failureBaseLevel = beforeLevel;
    }

    if (state.failureStreak === 1) {
      state.currentLevel = Math.max(1, state.failureBaseLevel);
      return '训练失败 1 次，原难度继续';
    }

    if (state.failureStreak === 2) {
      state.currentLevel = Math.max(1, state.failureBaseLevel - 1);
      return '连续失败 2 次，难度按失败段起点 -1';
    }

    state.currentLevel = Math.max(1, state.failureBaseLevel - 3);
    state.failureStreak = 0;
    state.failureBaseLevel = null;
    return '连续失败 3 次，难度按失败段起点 -3，并重置失败计数';
  }

  function finishSubLevel(reason) {
    if (!state.inSubLevel) return;
    state.inSubLevel = false;
    state.transitionToken += 1;
    state.pendingTransition = null;
    setInputLocked(true);
    els.stage.classList.remove('leaving', 'entering');

    const cfg = levelConfig(state.currentLevel);
    const beforeLevel = state.currentLevel;
    const success = state.actual >= state.target;
    const gainedScore = calcScore(success, cfg);
    state.totalScore += gainedScore;
    let progressText = applyProgressResult(success, beforeLevel);

    if (state.currentLevel > state.maxLevel) {
      state.passFlag = true;
      state.currentLevel = state.maxLevel;
      progressText = '已达最高等级，通关标识已置为 true；训练继续至计时结束';
    }
    state.bestLevel = Math.max(state.bestLevel, state.currentLevel, beforeLevel);

    const item = {
      at: new Date().toISOString(),
      beforeLevel,
      afterLevel: state.currentLevel,
      reason,
      success,
      actual: state.actual,
      target: state.target,
      attempts: state.subAttempts,
      correct: state.subCorrect,
      wrongAnswers: state.subWrong,
      accuracy: accuracyText(state.subCorrect, state.subAttempts),
      wrongLimit: wrongLimitFor(cfg),
      failureStreak: state.failureStreak,
      score: gainedScore,
      totalScore: state.totalScore,
      passFlag: state.passFlag,
      remainingTrainingSec: Math.max(0, state.trainingRemainingSec),
      progressText
    };
    state.history.push(item);
    updateHud();

    if (state.trainingRemainingSec <= 0) return finishTraining('timeOut');
    showSummary(item);
  }

  function showSummary(item) {
    els.summaryTitle.textContent = item.success ? '小关完成：训练成功' : '小关结束：训练失败';
    els.summaryResult.innerHTML = [
      ['结束原因', item.reason],
      ['完成 / 目标', `${item.actual} / ${item.target}`],
      ['正确 / 作答', `${item.correct} / ${item.attempts}`],
      ['小关准确率', item.accuracy],
      ['本关积分', item.score],
      ['总积分', item.totalScore],
      ['等级变化', `${item.beforeLevel} → ${item.afterLevel}`],
      ['难度调整', item.progressText]
    ].map(([key, value]) => `<div class="summary-item"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

    const last = state.history.slice(-10);
    const maxScore = Math.max(10, ...last.map((x) => x.score));
    els.trendBars.innerHTML = last.map((x) => {
      const height = Math.max(8, Math.round((x.score / maxScore) * 76));
      const cls = x.success ? 'success' : 'fail';
      const label = `${x.success ? '成功' : '失败'}：${x.score} 分，等级 ${x.beforeLevel}→${x.afterLevel}`;
      return `<div class="${cls}" title="${escapeHtml(label)}" style="height:${height}px"></div>`;
    }).join('');
    openModal(els.summaryModal);
  }

  function finishTraining(reason) {
    if (state.lastFinalResult) return;
    state.inSubLevel = false;
    state.transitionToken += 1;
    state.pendingTransition = null;
    setInputLocked(true);
    stopTicker();
    state.trainingRemainingSec = Math.max(0, state.trainingRemainingSec);
    updateHud();

    const successCount = state.history.filter((item) => item.success).length;
    const failureCount = state.history.length - successCount;
    const result = {
      title: CFG.title,
      configVersion: CFG.version,
      difficulty: state.difficultyLabel,
      difficultyKey: state.difficultyKey,
      startLevel: state.startLevel,
      finalLevel: state.currentLevel,
      bestLevel: state.bestLevel,
      totalScore: state.totalScore,
      totalAttempts: state.totalAttempts,
      totalCorrect: state.totalCorrect,
      totalWrong: state.totalWrong,
      accuracy: accuracyText(state.totalCorrect, state.totalAttempts),
      successSubLevels: successCount,
      failureSubLevels: failureCount,
      passFlag: Boolean(state.passFlag),
      durationSec: state.trainingDurationSec,
      reason,
      subLevels: state.history.length,
      completedAt: new Date().toISOString(),
      history: state.history
    };
    state.lastFinalResult = result;
    els.finalStats.innerHTML = [
      ['难度', result.difficulty],
      ['起始等级', result.startLevel],
      ['结束等级', result.finalLevel],
      ['最高到达等级', result.bestLevel],
      ['总积分', result.totalScore],
      ['总作答', result.totalAttempts],
      ['总体准确率', result.accuracy],
      ['成功 / 失败小关', `${result.successSubLevels} / ${result.failureSubLevels}`],
      ['完成小关数', result.subLevels],
      ['通关标识', String(result.passFlag)]
    ].map(([key, value]) => `<div class="summary-item"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
    closeModal(els.summaryModal);
    closeModal(els.pauseModal);
    openModal(els.finalModal);
  }

  function updateHud() {
    const cfg = levelConfig(state.currentLevel);
    const wrongLimit = wrongLimitFor(cfg);
    const trainingPct = state.trainingDurationSec > 0 ? (state.trainingRemainingSec / state.trainingDurationSec) * 100 : 0;
    const subBase = state.subDurationSec || timeFor(cfg);
    const subPct = subBase > 0 ? (state.subRemainingSec / subBase) * 100 : 0;
    const remainToTarget = Math.max(0, state.target - state.actual);

    els.hudDifficulty.textContent = state.difficultyLabel;
    els.hudLevel.textContent = state.currentLevel;
    els.hudTrainingTime.textContent = fmtTime(state.trainingRemainingSec);
    els.hudSubTime.textContent = fmtSub(state.subRemainingSec);
    els.hudTarget.textContent = `${state.actual}/${state.target}`;
    els.hudScore.textContent = state.totalScore;
    els.trainingProgress.style.width = fmtPct(trainingPct);
    els.trainingPercent.textContent = fmtPct(trainingPct);
    els.subProgress.style.width = fmtPct(subPct);
    els.subPercent.textContent = fmtPct(subPct);
    els.wrongStatus.textContent = `连错 ${state.consecutiveWrong}/${wrongLimit}`;
    els.wrongStatus.classList.toggle('danger', state.consecutiveWrong > 0 && state.consecutiveWrong >= wrongLimit - 1);
    els.targetStatus.textContent = remainToTarget === 0 ? '小关目标已达成' : `还差 ${remainToTarget} 次达标`;
    els.targetStatus.classList.toggle('achieved', remainToTarget === 0);
    els.passRibbon.classList.toggle('hidden', !state.passFlag);
  }

  function openModal(modal) {
    modal.classList.remove('hidden');
    if (modal === els.pauseModal) document.body.classList.add('pause-open');
  }

  function closeModal(modal) {
    modal.classList.add('hidden');
    if (modal === els.pauseModal) document.body.classList.remove('pause-open');
  }

  function pauseGame(note = '训练已暂停，计时停止。') {
    if (!state.inSubLevel) return;
    state.paused = true;
    setInputLocked(true);
    els.pauseNote.textContent = note;
    openModal(els.pauseModal);
  }

  function resumeGame() {
    state.paused = false;
    state.lastTick = performance.now();
    closeModal(els.pauseModal);
    if (state.pendingTransition) {
      const pending = state.pendingTransition;
      state.pendingTransition = null;
      completeAfterAnswerTransition(pending);
      return;
    }
    if (state.inSubLevel) setInputLocked(false);
  }

  function openGuideFromPause() {
    if (!state.inSubLevel) return;
    state.paused = true;
    setInputLocked(true);
    closeModal(els.pauseModal);
    enterGuide(0, 'resume');
  }

  function resumeFromGuide() {
    showScreen('game');
    closeModal(els.summaryModal);
    closeModal(els.pauseModal);
    state.guideReturnMode = 'start';
    state.paused = false;
    state.lastTick = performance.now();
    if (!state.tickHandle) startTicker();
    if (state.pendingTransition) {
      const pending = state.pendingTransition;
      state.pendingTransition = null;
      completeAfterAnswerTransition(pending);
    } else if (state.inSubLevel) {
      setInputLocked(false);
    }
    updateHud();
  }

  function exportResult() {
    const data = state.lastFinalResult || {
      title: CFG.title,
      configVersion: CFG.version,
      difficulty: state.difficultyLabel,
      totalScore: state.totalScore,
      totalAttempts: state.totalAttempts,
      totalCorrect: state.totalCorrect,
      totalWrong: state.totalWrong,
      accuracy: accuracyText(state.totalCorrect, state.totalAttempts),
      passFlag: state.passFlag,
      history: state.history
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `幻色图形_训练结果_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  els.splashContinue.addEventListener('click', () => { play('click'); showScreen('difficulty'); });
  qsa('.difficulty-card').forEach((btn) => btn.addEventListener('click', () => startWithDifficulty(btn.dataset.difficulty)));
  els.guideBack.addEventListener('click', () => {
    if (state.guideReturnMode === 'resume') resumeFromGuide();
    else showScreen('difficulty');
  });
  els.guideSkip.addEventListener('click', completeGuide);
  els.guidePrev.addEventListener('click', () => enterGuide(state.guideStep - 1, state.guideReturnMode));
  els.guideNext.addEventListener('click', advanceGuide);
  els.guideYes.addEventListener('click', () => handleGuideAnswer(true));
  els.guideNo.addEventListener('click', () => handleGuideAnswer(false));
  els.replayGuide.addEventListener('click', () => enterGuide(0, state.guideReturnMode));
  els.enterTraining.addEventListener('click', () => {
    if (state.guideReturnMode === 'resume') resumeFromGuide();
    else startTraining();
  });
  els.answerYes.addEventListener('click', () => answer(true));
  els.answerNo.addEventListener('click', () => answer(false));
  els.continueBtn.addEventListener('click', () => {
    closeModal(els.summaryModal);
    state.lastTick = performance.now();
    startSubLevel();
  });
  els.pauseBtn.addEventListener('click', () => pauseGame());
  els.resumeBtn.addEventListener('click', resumeGame);
  els.helpBtn.addEventListener('click', openGuideFromPause);
  els.quitBtn.addEventListener('click', () => {
    stopTicker();
    setMusic(false);
    closeModal(els.pauseModal);
    showScreen('difficulty');
  });
  els.soundToggle.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    els.soundToggle.textContent = state.soundEnabled ? '开启' : '关闭';
    els.soundToggle.setAttribute('aria-pressed', String(state.soundEnabled));
  });
  els.musicToggle.addEventListener('click', () => setMusic(!state.musicEnabled));
  els.restartBtn.addEventListener('click', () => { closeModal(els.finalModal); showScreen('difficulty'); });
  els.exportResultBtn.addEventListener('click', exportResult);

  window.addEventListener('keydown', (e) => {
    const guideActive = document.querySelector('[data-screen="guide"].screen-active');
    if (guideActive) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') handleGuideAnswer(true);
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'x') handleGuideAnswer(false);
      return;
    }
    if (!isGameScreenActive()) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') answer(true);
    if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'x') answer(false);
    if (e.key === 'Escape') state.paused ? resumeGame() : pauseGame();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isGameScreenActive() && state.inSubLevel && !state.paused) {
      pauseGame('页面切换，已自动暂停；返回后点击继续游戏。');
    }
  });

  updateHud();
})();

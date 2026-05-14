(() => {
  'use strict';
  const CONFIG = window.GAME_CONFIG;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a,b) => a[0]-b[0]).map(v => v[1]);
  const fmtTime = (sec) => {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
  };
  const ASSET = {
    mascot: 'assets/characters/xiaokangkang.svg',
    normal: 'assets/characters/mole_normal.svg',
    helmet: 'assets/characters/mole_helmet.svg',
    helmetCracked: 'assets/characters/mole_helmet_cracked.svg',
    bomb: 'assets/characters/bomb.svg',
    explosion: 'assets/effects/explosion.svg',
    white: 'assets/characters/cat_white.svg',
    other: 'assets/characters/cat_tabby.svg',
    hole: 'assets/holes/hole.svg',
    confetti: 'assets/ui/confetti.svg'
  };

  class AudioKit {
    constructor(){ this.ctx = null; this.soundEnabled = true; this.musicEnabled = false; this.musicTimer = 0; }
    ensure(){ if(!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if(this.ctx.state === 'suspended') this.ctx.resume(); }
    tone(freq = 440, dur = .08, type = 'sine', gain = .08){
      if(!this.soundEnabled) return;
      try{ this.ensure(); const o = this.ctx.createOscillator(); const g = this.ctx.createGain(); o.type = type; o.frequency.value = freq; g.gain.value = gain; o.connect(g); g.connect(this.ctx.destination); const t = this.ctx.currentTime; g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.001, t + dur); o.start(t); o.stop(t + dur); }catch(e){}
    }
    hit(){ this.tone(620,.07,'triangle',.085); setTimeout(()=>this.tone(820,.05,'triangle',.06),45); }
    wrong(){ this.tone(180,.12,'sawtooth',.07); }
    pass(){ this.tone(660,.08,'triangle',.08); setTimeout(()=>this.tone(880,.09,'triangle',.08),85); setTimeout(()=>this.tone(1040,.12,'triangle',.07),170); }
    click(){ this.tone(420,.04,'triangle',.05); }
    toggleSound(){ this.soundEnabled = !this.soundEnabled; return this.soundEnabled; }
    toggleMusic(){
      this.musicEnabled = !this.musicEnabled;
      if(this.musicEnabled){ this.ensure(); let step = 0; const notes = [262,330,392,523,392,330]; this.musicTimer = setInterval(()=>{ if(this.musicEnabled) this.tone(notes[step++ % notes.length], .05, 'sine', .025); }, 420); }
      else if(this.musicTimer){ clearInterval(this.musicTimer); this.musicTimer = 0; }
      return this.musicEnabled;
    }
  }

  class EyeHandGame {
    constructor(config){
      this.config = config;
      this.levels = config.levels;
      this.maxLevel = config.maxLevel;
      this.storageKey = `eye-hand-polished-level-${config.mode}`;
      this.failKey = `eye-hand-polished-fail-${config.mode}`;
      this.presetKey = `eye-hand-difficulty-preset-${config.mode}`;
      this.difficultyPresets = config.difficultyPresets || [
        { id:'easy', name:'容易', startLevel:1 },
        { id:'normal', name:'普通', startLevel:15 },
        { id:'hard', name:'困难', startLevel:30 }
      ];
      this.selectedPresetId = localStorage.getItem(this.presetKey) || 'easy';
      if(!this.difficultyPresets.some(p => p.id === this.selectedPresetId)) this.selectedPresetId = 'easy';
      const initialPreset = this.difficultyPresets.find(p => p.id === this.selectedPresetId) || this.difficultyPresets[0];
      this.currentLevelNo = clamp(initialPreset.startLevel, 1, this.maxLevel);
      this.failStreak = 0;
      this.audio = new AudioKit();
      this.state = 'splash';
      this.paused = false;
      this.raf = 0;
      this.activeAnimals = new Map();
      this.records = [];
      this.trainingPassed = false;
      this.roundResultTimer = 0;
      this.passFlashTimer = 0;
      this.tutorialTimer = 0;
      this.tutorialTicker = 0;
      this.tutorialAutoEndAt = 0;
      this.fitRaf = 0;
      this.resizeClearTimer = 0;
      this.trainingStartLevel = this.currentLevelNo;
      this.trainingPreset = this.getSelectedPreset();
      this.tutorialKey = `eye-hand-polished-tutorial-${config.mode}`;
      this.preloadAssets();
      this.bind();
      this.paintStatic();
      this.installViewportFitter();
      setTimeout(() => this.showWelcome(), 2050);
    }

    preloadAssets(){
      Object.values(ASSET).forEach(src => { const img = new Image(); img.src = src; });
    }

    paintStatic(){
      $$('.mascot').forEach(el => { el.src = ASSET.mascot; });
      $('#welcomeVersion').textContent = this.config.version;
      $('#welcomeNote').textContent = this.config.difficultyNote;
      $('#ruleSummary').innerHTML = '<strong>规则</strong>：达标 +1；失败第 1 次保持，第 2 次 -1，第 3 次 -3；连续选错两次或 time=0 结束小关；训练总时长未归零时自动继续。';
      $('#durationSelect').value = String(this.config.defaultDurationSeconds);
      this.updateDifficultyButtons();
      this.updatePreview();
      this.updateTutorialButton();
      document.documentElement.style.setProperty('--theme-color', this.config.themeColor || '#74c6bd');
    }

    bind(){
      $('#btnStart').addEventListener('click', () => { this.audio.click(); this.startTraining(); });
      $$('.difficulty-option').forEach(btn => btn.addEventListener('click', () => { this.audio.click(); this.setDifficultyPreset(btn.dataset.preset); }));
      $('#btnGuide').addEventListener('click', () => { this.audio.click(); this.startTutorial(); });
      $('#btnGuideBack').addEventListener('click', () => { this.audio.click(); this.showWelcome(); });
      $('#btnGuidePrev').addEventListener('click', () => { this.audio.click(); this.prevTutorialStep(); });
      $('#btnGuideNext').addEventListener('click', () => { this.audio.click(); this.nextTutorialStep(); });
      $('#btnGuideSkip').addEventListener('click', () => { this.audio.click(); this.skipTutorial(); });
      $('#btnGuideStart').addEventListener('click', () => { this.audio.click(); this.startTraining(); });
      $('#btnReset').addEventListener('click', () => { this.audio.click(); this.resetDifficulty(); });
      $('#btnPause').addEventListener('click', () => { this.audio.click(); this.pauseGame(); });
      document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && this.state === 'playing') this.pauseGame(); });
      document.addEventListener('visibilitychange', () => { if(document.hidden && this.state === 'playing' && !this.paused && !this.roundEnding) this.pauseGame('检测到窗口切换，训练已自动暂停。'); });
    }



    installViewportFitter(){
      this.fitRaf = 0;
      this.resizeClearTimer = 0;
      const run = () => {
        document.body.classList.add('is-resizing');
        clearTimeout(this.resizeClearTimer);
        this.resizeClearTimer = setTimeout(() => document.body.classList.remove('is-resizing'), 120);
        if(this.fitRaf) cancelAnimationFrame(this.fitRaf);
        this.fitRaf = requestAnimationFrame(() => this.fitViewport());
      };
      window.addEventListener('resize', run, { passive:true });
      window.addEventListener('orientationchange', run, { passive:true });
      window.addEventListener('load', run, { once:true });
      run();
    }

    fitViewport(){
      const vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 320);
      const vh = Math.max(360, window.innerHeight || document.documentElement.clientHeight || 360);
      const pad = Math.max(6, Math.min(vw * 0.014, vh * 0.018, 22));
      const stageMaxW = vw >= 1500 ? 1440 : vw >= 1180 ? 1320 : 1180;
      const stageW = Math.max(300, Math.min(stageMaxW, vw - pad * 2));
      const stageH = Math.max(320, vh - pad * 2);
      const root = document.documentElement;
      root.style.setProperty('--screen-pad', `${pad.toFixed(1)}px`);
      root.style.setProperty('--stage-width', `${stageW.toFixed(1)}px`);
      root.style.setProperty('--stage-height', `${stageH.toFixed(1)}px`);
      root.style.setProperty('--real-vh', `${vh}px`);
      document.body.classList.toggle('compact-height', vh < 700);
      this.fitGameBoard();
      this.fitTutorialBoard();
    }

    fitGameBoard(){
      const board = $('#gameBoard');
      const stage = $('#gameStage');
      if(!board || !stage || !board.children.length) return;
      const cols = parseInt(board.style.getPropertyValue('--cols') || '3', 10) || 3;
      const rows = parseInt(board.style.getPropertyValue('--rows') || '3', 10) || 3;
      const viewportH = Math.max(360, window.innerHeight || 360);
      const viewportW = Math.max(320, window.innerWidth || 320);
      const pad = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--screen-pad')) || 12;
      const stageW = Math.min(stage.clientWidth || viewportW - pad * 2, viewportW - pad * 2);
      const topbarH = $('.topbar')?.offsetHeight || 0;
      const sessionH = $('.session-strip')?.offsetHeight || 0;
      const progressH = $('.hud-progress-panel')?.offsetHeight || 0;
      const reserve = viewportH < 680 ? 8 : 18;
      const availableH = Math.max(190, viewportH - pad * 2 - topbarH - sessionH - progressH - reserve);
      const ratios = { '3x3':1.45, '4x3':1.72, '4x4':1.58, '5x4':1.96 };
      const ratio = ratios[`${cols}x${rows}`] || Math.max(1.25, Math.min(2.15, (cols / rows) * 1.42));
      const maxBoardH = viewportH >= 840 ? 620 : viewportH >= 720 ? 570 : viewportH >= 620 ? 500 : 420;
      let boardH = Math.min(maxBoardH, availableH, stageW / ratio);
      boardH = Math.max(Math.min(availableH, 260), boardH);
      boardH = Math.max(180, Math.min(boardH, availableH));
      let boardW = Math.min(stageW, boardH * ratio);
      const minReadableW = Math.min(stageW, 300);
      boardW = Math.max(minReadableW, boardW);
      board.style.width = `${Math.round(boardW)}px`;
      board.style.height = `${Math.round(boardH)}px`;
      document.documentElement.style.setProperty('--board-width', `${Math.round(boardW)}px`);
      document.documentElement.style.setProperty('--board-height', `${Math.round(boardH)}px`);
      document.documentElement.style.setProperty('--board-wrap-height', `${Math.round(availableH)}px`);
      stage.classList.toggle('game-compact', viewportH < 700 || viewportW < 900);
    }

    fitTutorialBoard(){
      const board = $('#tutorialBoard');
      const guide = $('.advanced-guide');
      if(!board || !guide || !board.children.length) return;
      const viewportH = Math.max(360, window.innerHeight || 360);
      const viewportW = Math.max(320, window.innerWidth || 320);
      const pad = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--screen-pad')) || 12;
      const guideW = Math.min(guide.clientWidth || viewportW - pad * 2, viewportW - pad * 2);
      const topH = $('.guide-top')?.offsetHeight || 0;
      const actionsH = $('.guide-actions')?.offsetHeight || 0;
      const tipH = $('#tutorialTip')?.offsetHeight || 0;
      const scoreH = $('.guide-scorebar')?.offsetHeight || 0;
      const reserve = viewportH < 700 ? 28 : 42;
      const mainH = Math.max(210, viewportH - pad * 2 - topH - actionsH - reserve);
      const cols = parseInt(board.style.getPropertyValue('--cols') || '3', 10) || 3;
      const rows = parseInt(board.style.getPropertyValue('--rows') || '3', 10) || 3;
      const twoColumn = viewportW > 920;
      const playgroundW = twoColumn ? Math.max(320, guideW - 380) : guideW;
      const availableBoardH = Math.max(150, mainH - tipH - scoreH - 34);
      const ratio = Math.max(1.25, Math.min(1.62, (cols / rows) * 1.42));
      let boardH = Math.min(viewportH >= 820 ? 450 : 380, availableBoardH, playgroundW / ratio);
      boardH = Math.max(150, Math.min(boardH, availableBoardH));
      const boardW = Math.min(playgroundW - 24, boardH * ratio);
      document.documentElement.style.setProperty('--tutorial-board-width', `${Math.round(boardW)}px`);
      document.documentElement.style.setProperty('--tutorial-board-height', `${Math.round(boardH)}px`);
      guide.classList.toggle('tutorial-compact', viewportH < 700 || viewportW < 920);
    }

    getSelectedPreset(){
      return this.difficultyPresets.find(p => p.id === this.selectedPresetId) || this.difficultyPresets[0];
    }

    setDifficultyPreset(id, silent = false){
      const preset = this.difficultyPresets.find(p => p.id === id) || this.difficultyPresets[0];
      this.selectedPresetId = preset.id;
      this.currentLevelNo = clamp(preset.startLevel, 1, this.maxLevel);
      this.failStreak = 0;
      localStorage.setItem(this.presetKey, preset.id);
      localStorage.setItem(this.storageKey, String(this.currentLevelNo));
      localStorage.setItem(this.failKey, '0');
      this.updateDifficultyButtons();
      this.updatePreview();
      if(!silent) this.showToast(`已选择${preset.name}：从第 ${preset.startLevel} 关开始`);
    }

    updateDifficultyButtons(){
      $$('.difficulty-option').forEach(btn => {
        const active = btn.dataset.preset === this.selectedPresetId;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', String(active));
      });
    }

    resetDifficulty(){
      const preset = this.getSelectedPreset();
      this.currentLevelNo = clamp(preset.startLevel, 1, this.maxLevel); this.failStreak = 0;
      localStorage.setItem(this.storageKey, String(this.currentLevelNo)); localStorage.setItem(this.failKey, '0');
      this.updatePreview(); this.showToast(`已重置为${preset.name}起始：第 ${preset.startLevel} 关`);
    }

    updatePreview(){
      const preset = this.getSelectedPreset();
      const lv = this.levels[preset.startLevel - 1] || this.levels[0];
      $('#currentLevelPreview').textContent = `${preset.name} · 从第 ${preset.startLevel} 关开始 · 目标 ${lv.passTarget}`;
    }

    updateTutorialButton(){
      const done = localStorage.getItem(this.tutorialKey) === '1';
      const btn = $('#btnGuide');
      if(btn) btn.textContent = done ? '回看自动教程' : '自动引导新手教程（推荐）';
    }

    showScreen(id){ $$('.screen').forEach(s => s.classList.remove('active')); $('#' + id).classList.add('active'); requestAnimationFrame(() => this.fitViewport()); }
    clearPassFlashTimer(){ if(this.passFlashTimer){ clearTimeout(this.passFlashTimer); this.passFlashTimer = 0; } }
    showWelcome(){ this.state = 'welcome'; cancelAnimationFrame(this.raf); this.clearTutorialTimer(); this.clearRoundResultTimer(); this.clearPassFlashTimer(); this.hideModal(); this.showScreen('screen-welcome'); this.updateDifficultyButtons(); this.updatePreview(); this.updateTutorialButton(); }

    startTutorial(){
      this.state = 'tutorial';
      this.hideModal();
      this.showScreen('screen-tutorial');
      this.clearTutorialTimer();
      this.tutorialStep = 0;
      this.tutorialHelmetHits = 0;
      this.tutorialHits = 0;
      this.tutorialWrong = 0;
      this.tutorialStepDone = false;
      this.tutorialPracticeAnimals = new Map();
      this.buildBoard($('#tutorialBoard'), 3, 3, true);
      this.renderTutorialStep();
    }
    clearTutorialTimer(){
      if(this.tutorialTimer) clearTimeout(this.tutorialTimer);
      if(this.tutorialTicker) clearInterval(this.tutorialTicker);
      this.tutorialTimer = 0;
      this.tutorialTicker = 0;
      this.tutorialAutoEndAt = 0;
    }

    setAutoGuideStatus(text){
      const el = $('#tutorialAutoStatus');
      if(el) el.textContent = text;
    }

    setAutoNextButton(text, state='waiting', disabled=false){
      const btn = $('#btnGuideNext');
      if(!btn) return;
      btn.textContent = text;
      btn.disabled = !!disabled;
      btn.classList.remove('waiting','ready');
      btn.classList.add(state);
    }

    setGuidePlaygroundState(state){
      const pg = $('.guide-playground');
      if(!pg) return;
      pg.classList.remove('auto-waiting','auto-advance','auto-action');
      if(state) pg.classList.add(state);
    }

    autoAdvanceDelayForStep(step){
      if(step.autoMs) return step.autoMs;
      const base = step.id === 'ending' || step.id === 'score' ? 5600 : 4300;
      const extra = Math.min(1600, Math.max(0, ((step.text || '').length - 70) * 12));
      return base + extra;
    }

    scheduleTutorialAutoAdvance(step){
      this.clearTutorialTimer();
      const steps = this.getTutorialSteps();
      const last = this.tutorialStep >= steps.length - 1;
      if(step.requireComplete){
        this.setAutoGuideStatus('等待你完成本步操作');
        this.setAutoNextButton('完成操作后自动继续', 'waiting', true);
        this.setGuidePlaygroundState('auto-action');
        return;
      }
      const ms = this.autoAdvanceDelayForStep(step);
      this.startTutorialAutoCountdown(ms, last ? '即将完成教程' : '自动讲解中', () => {
        if(last) this.finishTutorial();
        else this.nextTutorialStep();
      });
    }

    scheduleTutorialDoneAdvance(delay = 1100){
      const steps = this.getTutorialSteps();
      const last = this.tutorialStep >= steps.length - 1;
      this.startTutorialAutoCountdown(delay, last ? '本步已完成' : '本步已完成', () => {
        if(last) this.finishTutorial();
        else this.nextTutorialStep();
      }, true);
    }

    startTutorialAutoCountdown(ms, label, action, completed=false){
      this.clearTutorialTimer();
      const endAt = performance.now() + ms;
      this.tutorialAutoEndAt = endAt;
      this.setGuidePlaygroundState(completed ? 'auto-advance' : 'auto-waiting');
      const render = () => {
        const leftMs = Math.max(0, endAt - performance.now());
        const left = Math.max(1, Math.ceil(leftMs / 1000));
        const text = completed ? `${left} 秒后自动继续` : `${left} 秒后自动下一步`;
        this.setAutoGuideStatus(label);
        this.setAutoNextButton(text, completed ? 'ready' : 'waiting', false);
      };
      render();
      this.tutorialTicker = setInterval(render, 160);
      this.tutorialTimer = setTimeout(() => {
        this.clearTutorialTimer();
        if(this.state !== 'tutorial') return;
        action();
      }, ms);
    }

    getTutorialSteps(){
      return [
        { id:'overview', heading:'先认清：哪些能点，哪些不能点', requireComplete:false,
          text:'训练目标不是“看到就点”，而是只点正确目标。普通地鼠可以点；头盔地鼠要打两次；炸弹、白猫、花猫和空洞都不能点。',
          tip:'先观察 5 类对象。不要急，真正训练时也要先分辨。', goal:'观察',
          checklist:['普通地鼠：点 1 次计入 N','头盔地鼠：第 2 次才计入 N','炸弹/猫/空洞：点了算选错'],
          showcase:[['normal',1,'普通地鼠：点'],['helmet',3,'头盔：打两次'],['bomb',5,'炸弹：别点'],['white',6,'白猫：别点'],['other',8,'花猫：别点']] },
        { id:'hud', heading:'看懂界面：目标 N/M 是核心', requireComplete:false,
          text:'HUD 中“目标 N/M”表示当前小关已正确命中的实际数 N，以及本关通关目标 M。N 达到 M 后，本轮已经达标，但训练不会提前结束，会继续到下发训练时长归零。',
          tip:'重点看：剩余时间、预计积分、目标 N/M、连续错误 0/2。', goal:'读懂 HUD',
          checklist:['N 是实际正确数','M 是本关通关目标','达标后继续训练直到总时长结束'],
          showcase:[['normal',4,'N 增加'],['helmet',1,'破甲后再点'],['bomb',7,'不要点']] },
        { id:'normal', heading:'练习 1：普通地鼠点一次', requireComplete:true,
          text:'普通地鼠是最基础目标。点击中心地鼠一次，命中后 N 会增加 1，并且会清空连续错误计数。',
          tip:'点击中心的普通地鼠。', goal:'命中 1 次', checklist:['点普通地鼠','看到“命中 +1”','连续错误清零'], setup:'normal' },
        { id:'helmet', heading:'练习 2：头盔地鼠要点两次', requireComplete:true,
          text:'头盔地鼠第一次点击只会敲掉头盔，不计入实际数 N；第二次点击才算真正命中。第一次破甲也属于正确操作，会打断连续错误。',
          tip:'先敲掉头盔，再点一次完成命中。', goal:'两次点击', checklist:['第 1 次：头盔破裂','第 2 次：计入 N','破甲会打断连续错误'], setup:'helmet' },
        { id:'danger', heading:'练习 3：避开炸弹和猫，只点地鼠', requireComplete:true,
          text:'炸弹、白猫和花猫都是干扰项，不能点。请从 4 个对象里只点普通地鼠；点到干扰项会显示错误反馈。',
          tip:'只点绿色高亮附近的普通地鼠，避开红色警示目标。', goal:'只点地鼠', checklist:['炸弹不能点','白猫/花猫不能点','干扰项会增加连续错误'], setup:'danger' },
        { id:'empty', heading:'练习 4：空洞也不能点', requireComplete:true,
          text:'没有目标的洞不能随便点。正式训练中，点空洞也会记为选错；连续选错两次会立即结束当前小关。',
          tip:'点击中心空洞，观察“空洞算选错”的反馈。教程中不会真的结束。', goal:'观察空洞反馈', checklist:['空洞不是目标','空洞点击计入错误','连续错误达到 2 次会结束小关'], setup:'empty' },
        { id:'ending', heading:'小关结束与难度升降', requireComplete:false,
          text:'小关只由两类条件结束：连续选错两次，或 time=0。小关结束时若 N 达到 M，难度 +1；失败第 1 次保持，第 2 次 -1，第 3 次 -3 并清空失败次数。',
          tip:'失败不是直接大幅降级，而是按连续失败次数分段调整。', goal:'规则理解', checklist:['达标：难度 +1','失败 1 次：原难度','失败 2 次：难度 -1','失败 3 次：难度 -3'],
          showcase:[['normal',1,'达标 +1'],['bomb',4,'连续错 2 次结束'],['other',7,'失败触发降级规则']] },
        { id:'score', heading:'积分怎么结算', requireComplete:false,
          text:'小关通过时，积分 = floor(通关积分 + (实际数 - 目标数) × 奖励分 + 10)。未通过时只有固定 10 分基础分。HUD 显示的是已结算积分 + 当前小关预计积分。',
          tip:'多命中超过目标的地鼠，会按奖励分增加结算积分。', goal:'公式理解', checklist:['通过才有通关积分','超过目标会获得奖励分','未通过固定 10 分'],
          showcase:[['normal',0,'实际数 N'],['normal',4,'目标数 M'],['helmet',8,'奖励分']] },
        { id:'practice', heading:'综合练习：完成 3 次实际命中', requireComplete:true,
          text:'最后做一次小练习：普通地鼠点一次；头盔地鼠点两次才算一次；炸弹和猫都不要点。完成 3 次实际命中后即可进入训练。',
          tip:'完成 3/3 命中，尽量不要点错。', goal:'3 次命中', checklist:['普通地鼠：1 次','头盔地鼠：2 次','避开炸弹和猫'], setup:'practice' }
      ];
    }

    renderTutorialStep(){
      const steps = this.getTutorialSteps();
      if(this.tutorialStep >= steps.length){ this.finishTutorial(); return; }
      const step = steps[this.tutorialStep];
      this.clearTutorialTimer();
      this.tutorialStepDone = !step.requireComplete;
      this.tutorialHelmetHits = 0;
      this.tutorialHits = 0;
      this.tutorialWrong = 0;
      this.tutorialPracticeAnimals = new Map();
      $('#guideStepLabel').textContent = `第 ${this.tutorialStep + 1} 步 / 共 ${steps.length} 步`;
      $('#guideHeading').textContent = step.heading;
      $('#guideText').textContent = step.text;
      $('#tutorialTip').textContent = step.tip || '';
      $('#tutorialGoal').textContent = step.goal || '--';
      $('#tutorialHits').textContent = '0';
      $('#tutorialWrongs').textContent = '0/2';
      $('#tutorialProgress').textContent = `${this.tutorialStep + 1} / ${steps.length}`;
      const fill = $('#tutorialProgressFill'); if(fill) fill.style.width = `${((this.tutorialStep + 1) / steps.length) * 100}%`;
      this.renderTutorialChecklist(step.checklist || []);
      this.resetTutorialBoard();
      $('#btnGuidePrev').disabled = this.tutorialStep === 0;
      $('#btnGuideNext').textContent = '自动引导中';
      $('#btnGuideNext').disabled = false;
      $('#btnGuideNext').classList.remove('waiting','ready');
      $('.guide-playground')?.classList.remove('is-complete','auto-waiting','auto-advance','auto-action');
      if(step.showcase) this.renderTutorialShowcase(step.showcase);
      if(step.setup) this.setupTutorialInteraction(step.setup);
      this.scheduleTutorialAutoAdvance(step);
    }

    renderTutorialChecklist(items){
      const box = $('#guideChecklist'); box.innerHTML = '';
      items.forEach(text => { const item = document.createElement('div'); item.className = 'check-item'; item.textContent = text; box.appendChild(item); });
    }

    resetTutorialBoard(){
      const board = $('#tutorialBoard');
      $$('.hole-cell', board).forEach(cell => {
        cell.onclick = null;
        cell.classList.remove('tutorial-focus','tutorial-safe','tutorial-danger','tutorial-done');
        cell.querySelectorAll('.animal,.tutorial-label,.tutorial-pointer,.tutorial-badge,.floating-score').forEach(el => el.remove());
      });
    }

    tutorialCell(index){ return $(`#tutorialBoard .hole-cell[data-index="${index}"]`); }

    renderTutorialShowcase(items){
      items.forEach(([type,index,label]) => {
        const cell = this.tutorialCell(index); if(!cell) return;
        const el = this.createAnimalElement(type); cell.appendChild(el);
        const tag = document.createElement('div'); tag.className = 'tutorial-label'; tag.textContent = label; cell.appendChild(tag);
        cell.classList.add(type === 'normal' || type === 'helmet' ? 'tutorial-safe' : 'tutorial-danger');
      });
    }

    addTutorialPointer(cell){ const p = document.createElement('div'); p.className = 'tutorial-pointer'; cell.appendChild(p); }
    addTutorialBadge(cell, ok=true){ const b = document.createElement('div'); b.className = `tutorial-badge ${ok ? '' : 'warn'}`; b.textContent = ok ? '✓' : '!'; cell.appendChild(b); }
    updateTutorialStats(){ $('#tutorialHits').textContent = String(this.tutorialHits || 0); $('#tutorialWrongs').textContent = `${this.tutorialWrong || 0}/2`; }

    markTutorialDone(message){
      this.tutorialStepDone = true;
      $('#btnGuideNext').disabled = false;
      if(message) $('#tutorialTip').textContent = message;
      $('.guide-playground')?.classList.add('is-complete');
      this.audio.pass();
      this.scheduleTutorialDoneAdvance();
    }

    tutorialWrongClick(index, label='不是目标'){
      this.tutorialWrong = Math.min(2, (this.tutorialWrong || 0) + 1);
      this.audio.wrong();
      this.floatText(index, `选错：${label}`, true);
      this.updateTutorialStats();
      if(this.tutorialWrong >= 2) $('#tutorialTip').textContent = '正式训练中，连续选错 2 次会结束当前小关。教程里请继续练习。';
      else $('#tutorialTip').textContent = `${label} 不能点。请重新观察目标。`;
    }

    setupTutorialInteraction(kind){
      if(kind === 'normal'){
        const cell = this.tutorialCell(4); cell.classList.add('tutorial-focus','tutorial-safe'); this.addTutorialPointer(cell);
        const el = this.createAnimalElement('normal'); cell.appendChild(el);
        cell.onclick = () => { cell.onclick = null; this.tutorialHits = 1; this.updateTutorialStats(); this.audio.hit(); this.floatText(4, '命中 +1'); el.classList.add('hit'); this.addTutorialBadge(cell, true); this.markTutorialDone('正确。普通地鼠命中后，实际数 N 增加 1。'); };
        return;
      }
      if(kind === 'helmet'){
        const cell = this.tutorialCell(4); cell.classList.add('tutorial-focus','tutorial-safe'); this.addTutorialPointer(cell);
        const el = this.createAnimalElement('helmet'); cell.appendChild(el);
        cell.onclick = () => {
          this.tutorialHelmetHits += 1; this.audio.hit();
          if(this.tutorialHelmetHits === 1){ this.setAnimalImage(el, 'helmetCracked'); el.classList.add('helmet-broken'); $('#tutorialTip').textContent = '头盔已破。再点一次，才计入实际数 N。'; this.floatText(4, '破甲'); return; }
          cell.onclick = null; this.tutorialHits = 1; this.updateTutorialStats(); this.floatText(4, '命中 +1'); el.classList.add('hit'); this.addTutorialBadge(cell, true); this.markTutorialDone('完成。头盔地鼠第二次点击才算一次实际命中。');
        };
        return;
      }
      if(kind === 'danger'){
        [['bomb',2,'炸弹'],['white',6,'白猫'],['other',8,'花猫']].forEach(([type,index,label]) => {
          const cell = this.tutorialCell(index); cell.classList.add('tutorial-danger'); const el = this.createAnimalElement(type); cell.appendChild(el); const tag = document.createElement('div'); tag.className='tutorial-label'; tag.textContent=label+'：别点'; cell.appendChild(tag); cell.onclick = () => this.tutorialWrongClick(index,label);
        });
        const safe = this.tutorialCell(4); safe.classList.add('tutorial-focus','tutorial-safe'); this.addTutorialPointer(safe); const el = this.createAnimalElement('normal'); safe.appendChild(el); const tag = document.createElement('div'); tag.className='tutorial-label'; tag.textContent='只点这个'; safe.appendChild(tag);
        safe.onclick = () => { safe.onclick = null; this.tutorialHits = 1; this.updateTutorialStats(); this.audio.hit(); this.floatText(4,'正确目标'); el.classList.add('hit'); this.addTutorialBadge(safe,true); this.markTutorialDone('正确。干扰项不要点，只处理目标地鼠。'); };
        return;
      }
      if(kind === 'empty'){
        const cell = this.tutorialCell(4); cell.classList.add('tutorial-focus'); this.addTutorialPointer(cell);
        const tag = document.createElement('div'); tag.className='tutorial-label'; tag.textContent='空洞：点了算错'; cell.appendChild(tag);
        cell.onclick = () => { cell.onclick = null; this.tutorialWrongClick(4,'空洞'); this.addTutorialBadge(cell,false); this.markTutorialDone('已观察到空洞错误反馈。正式训练中不要点空洞。'); };
        return;
      }
      if(kind === 'practice') this.setupTutorialPractice();
    }

    spawnTutorialPracticeAnimal(type, index, label){
      const cell = this.tutorialCell(index); if(!cell) return;
      const el = this.createAnimalElement(type); cell.appendChild(el);
      const tag = document.createElement('div'); tag.className='tutorial-label'; tag.textContent = label; cell.appendChild(tag);
      if(type === 'normal' || type === 'helmet') cell.classList.add('tutorial-safe'); else cell.classList.add('tutorial-danger');
      this.tutorialPracticeAnimals.set(index, { type, armor:type === 'helmet' ? 1 : 0, el, done:false });
      cell.onclick = () => this.handleTutorialPracticeClick(index);
    }

    setupTutorialPractice(){
      this.tutorialHits = 0; this.tutorialWrong = 0; this.updateTutorialStats(); $('#tutorialGoal').textContent = '3/3';
      this.spawnTutorialPracticeAnimal('normal', 1, '点一次');
      this.spawnTutorialPracticeAnimal('bomb', 2, '别点');
      this.spawnTutorialPracticeAnimal('helmet', 4, '点两次');
      this.spawnTutorialPracticeAnimal('white', 6, '别点');
      this.spawnTutorialPracticeAnimal('normal', 7, '点一次');
      this.spawnTutorialPracticeAnimal('other', 8, '别点');
      [1,4,7].forEach(i => this.tutorialCell(i)?.classList.add('tutorial-focus'));
      $('#tutorialTip').textContent = '目标是 3 次实际命中：两个普通地鼠各 1 次，头盔地鼠第 2 次才算 1 次。';
    }

    handleTutorialPracticeClick(index){
      const item = this.tutorialPracticeAnimals.get(index);
      if(!item || item.done){ this.tutorialWrongClick(index, '空洞'); return; }
      if(item.type === 'bomb'){ this.tutorialWrongClick(index, '炸弹'); return; }
      if(item.type === 'white' || item.type === 'other'){ this.tutorialWrongClick(index, '猫咪'); return; }
      if(item.type === 'helmet' && item.armor > 0){ item.armor = 0; this.setAnimalImage(item.el, 'helmetCracked'); item.el.classList.add('helmet-broken'); this.audio.hit(); this.floatText(index, '破甲'); $('#tutorialTip').textContent = '很好。头盔已破，再点一次才计入实际命中。'; return; }
      item.done = true; this.tutorialHits += 1; this.audio.hit(); this.floatText(index, '命中 +1'); item.el.classList.add('hit'); this.addTutorialBadge(this.tutorialCell(index), true); this.tutorialCell(index).onclick = null; this.updateTutorialStats();
      $('#tutorialGoal').textContent = `${this.tutorialHits}/3`;
      if(this.tutorialHits >= 3) this.markTutorialDone('综合练习完成。现在可以进入正式训练。');
      else $('#tutorialTip').textContent = `已完成 ${this.tutorialHits}/3，继续点击剩余地鼠。`;
    }

    nextTutorialStep(){
      const steps = this.getTutorialSteps();
      if(this.tutorialStep >= steps.length - 1){ this.finishTutorial(); return; }
      this.tutorialStep += 1;
      this.renderTutorialStep();
    }

    prevTutorialStep(){
      if(this.tutorialStep <= 0) return;
      this.tutorialStep -= 1;
      this.renderTutorialStep();
    }

    skipTutorial(){
      this.clearTutorialTimer();
      this.showModal({ title:'已跳过教程', message:'本次跳过不会记录为“教程已完成”。仍建议首次训练前完整走完自动引导流程。', resultItems:[], buttons:[
        { text:'继续教程', className:'secondary', action:()=>{ this.hideModal(); this.startTutorial(); } },
        { text:'返回首页', className:'secondary', action:()=>{ this.hideModal(); this.showWelcome(); } },
        { text:'直接训练', action:()=>{ this.hideModal(); this.startTraining(); } }
      ]});
    }

    finishTutorial(){
      this.clearTutorialTimer();
      localStorage.setItem(this.tutorialKey, '1');
      this.updateTutorialButton();
      this.showModal({ title:'教程完成', message:'自动引导教程已完成：规则说明、目标识别、头盔地鼠、干扰项、空洞错误和综合练习均已覆盖。可以进入正式训练。', resultItems:[], extraHtml:`<img class="confetti-head" src="${ASSET.confetti}" alt="">`, buttons:[
        { text:'重新教程', className:'secondary', action:()=>{ this.hideModal(); this.startTutorial(); } },
        { text:'进入训练', action:()=>{ this.hideModal(); this.startTraining(); } }
      ]});
    }

    startTraining(){
      this.clearTutorialTimer();
      this.clearRoundResultTimer();
      this.state = 'playing'; this.paused = false; this.hideModal(); this.showScreen('screen-game');
      const params = new URLSearchParams(location.search);
      const presetParam = params.get('difficulty') || params.get('preset');
      if(presetParam && this.difficultyPresets.some(p => p.id === presetParam)) this.setDifficultyPreset(presetParam, true);
      const levelParam = parseInt(params.get('level') || '', 10);
      const preset = this.getSelectedPreset();
      this.trainingPreset = preset;
      this.trainingStartLevel = clamp(levelParam || preset.startLevel, 1, this.maxLevel);
      this.currentLevelNo = this.trainingStartLevel;
      this.failStreak = 0;
      localStorage.setItem(this.storageKey, String(this.currentLevelNo));
      localStorage.setItem(this.failKey, '0');
      this.updatePreview();
      const selected = parseInt(params.get('duration') || $('#durationSelect').value || this.config.defaultDurationSeconds, 10);
      this.sessionTotalMs = clamp(selected, 30, 3600) * 1000;
      this.sessionRemainingMs = this.sessionTotalMs;
      this.totalScore = 0; this.records = []; this.trainingPassed = false;
      this.startRound(true);
    }

    get currentLevel(){ return this.levels[this.currentLevelNo - 1] || this.levels[0]; }

    startRound(withCountdown = false){
      this.clearRoundResultTimer();
      if(this.sessionRemainingMs <= 0){ this.showSessionResult(this.records[this.records.length - 1] || null); return; }
      this.state = 'playing'; this.paused = false;
      this.level = this.currentLevel;
      this.correctCount = 0; this.liveScore = 0; this.faults = 0; this.consecutiveWrong = 0; this.passLatched = false; this.roundEnding = false;
      this.roundRemainingMs = Math.min(this.level.roundSeconds * 1000, this.sessionRemainingMs);
      this.countdownMs = withCountdown ? 3000 : 0; this.nextSpawnMs = 0;
      this.activeAnimals.clear();
      this.buildBoard($('#gameBoard'), this.level.cols, this.level.rows, false);
      if(this.countdownMs > 0){ $('#countdownOverlay').textContent = '3'; $('#countdownOverlay').classList.remove('hidden'); }
      else { $('#countdownOverlay').classList.add('hidden'); }
      this.clearPassFlashTimer();
      $('#passFlash').classList.add('hidden');
      this.lastFrame = performance.now(); cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(t => this.loop(t));
      this.updateHud();
    }

    buildBoard(board, cols, rows, tutorial){
      board.innerHTML = ''; board.style.setProperty('--cols', cols); board.style.setProperty('--rows', rows);
      board.className = `board cols-${cols} ${tutorial ? 'guide-board' : ''}`;
      this.holeCount = cols * rows;
      for(let i=0;i<this.holeCount;i++){
        const cell = document.createElement('button'); cell.type='button'; cell.className='hole-cell'; cell.dataset.index=String(i); cell.setAttribute('aria-label', `地洞 ${i+1}`);
        cell.innerHTML = `<img class="hole" src="${ASSET.hole}" alt="">`;
        if(!tutorial) cell.addEventListener('click', () => this.handleHoleClick(i));
        board.appendChild(cell);
      }
      requestAnimationFrame(() => this.fitViewport());
    }

    loop(now){
      const delta = Math.min(90, now - this.lastFrame); this.lastFrame = now;
      if(this.state === 'playing' && !this.paused && !this.roundEnding){
        if(this.countdownMs > 0){
          this.countdownMs = Math.max(0, this.countdownMs - delta);
          $('#countdownOverlay').textContent = this.countdownMs > 0 ? String(Math.max(1, Math.ceil(this.countdownMs / 1000))) : '开始';
          if(this.countdownMs === 0) setTimeout(() => $('#countdownOverlay').classList.add('hidden'), 260);
        } else {
          this.sessionRemainingMs = Math.max(0, this.sessionRemainingMs - delta);
          this.roundRemainingMs = Math.max(0, this.roundRemainingMs - delta);
          this.nextSpawnMs -= delta;
          this.updateAnimals(delta);
          if(this.nextSpawnMs <= 0){ this.spawnBatch(); this.nextSpawnMs = this.nextSpawnDelay(); }
          if(this.sessionRemainingMs <= 0) this.endRound('session0');
          else if(this.roundRemainingMs <= 0) this.endRound('time0');
        }
        this.updateHud();
      }
      this.raf = requestAnimationFrame(t => this.loop(t));
    }

    nextSpawnDelay(){ const spread = this.level.lineSpace * .22; return Math.max(260, this.level.lineSpace + (Math.random() * spread * 2 - spread)); }

    updateAnimals(delta){
      for(const [index, animal] of Array.from(this.activeAnimals.entries())){
        animal.remainingMs -= delta;
        if(animal.remainingMs <= 260) animal.el.classList.add('escape');
        if(animal.remainingMs <= 0) this.removeAnimal(index, 'escape');
      }
    }

    spawnBatch(){
      const free = []; for(let i=0;i<this.holeCount;i++) if(!this.activeAnimals.has(i)) free.push(i);
      if(!free.length) return;
      const count = Math.min(randInt(this.level.countMin, this.level.countMax), free.length);
      shuffle(free).slice(0, count).forEach(index => this.spawnAnimal(index));
    }

    pickAnimalType(){
      const r = Math.random() * 100; const p = this.level.probability;
      if(r <= p.normal) return 'normal';
      if(r <= p.helmet) return 'helmet';
      if(r <= p.bomb) return 'bomb';
      if(r <= p.white) return 'white';
      return 'other';
    }

    createAnimalElement(type){
      const el = document.createElement('div'); el.className = `animal animal-${type}`;
      const key = type === 'helmet' ? 'helmet' : type;
      el.innerHTML = `<img src="${ASSET[key]}" alt="">`;
      return el;
    }

    setAnimalImage(el, key){ const img = $('img', el); if(img) img.src = ASSET[key]; }

    spawnAnimal(index){
      const type = this.pickAnimalType(); const cell = $(`#gameBoard .hole-cell[data-index="${index}"]`); if(!cell) return;
      const el = this.createAnimalElement(type); cell.appendChild(el);
      this.activeAnimals.set(index, { index, type, armor:type === 'helmet' ? 1 : 0, remainingMs:this.level.reactionMs + 420, el });
    }

    handleHoleClick(index){
      if(this.state !== 'playing' || this.paused || this.countdownMs > 0 || this.roundEnding) return;
      const animal = this.activeAnimals.get(index);
      if(!animal){ this.registerWrong(index, 'empty'); return; }
      if(animal.type === 'bomb'){
        this.removeAnimal(index, 'explode'); this.registerWrong(index, 'bomb'); return;
      }
      if(animal.type === 'white' || animal.type === 'other'){
        this.removeAnimal(index, 'wrong'); this.registerWrong(index, animal.type); return;
      }
      if(animal.type === 'helmet' && animal.armor > 0){
        animal.armor = 0; animal.type = 'normal'; this.consecutiveWrong = 0; this.setAnimalImage(animal.el, 'helmetCracked'); animal.el.classList.add('helmet-broken');
        this.audio.hit(); this.floatText(index, '头盔破裂'); this.updateHud(); setTimeout(()=>{ if(this.activeAnimals.has(index)) this.setAnimalImage(animal.el, 'normal'); }, 240); return;
      }
      this.hitTarget(index);
    }

    hitTarget(index){
      const animal = this.activeAnimals.get(index); if(!animal) return;
      this.correctCount += 1; this.consecutiveWrong = 0;
      this.audio.hit(); this.floatText(index, '命中 +1'); this.removeAnimal(index, 'hit');
      if(!this.passLatched && this.correctCount >= this.level.passTarget){ this.passLatched = true; this.trainingPassed = true; this.audio.pass(); this.showPassFlash(); }
      this.updateHud();
    }

    registerWrong(index, reason){
      this.faults += 1; this.consecutiveWrong += 1; this.audio.wrong();
      const label = reason === 'empty' ? '空洞' : reason === 'bomb' ? '炸弹' : '猫咪';
      this.floatText(index, `选错：${label}`, true); this.showToast(`连续选错 ${this.consecutiveWrong}/2`);
      if(this.consecutiveWrong >= 2) this.endRound('wrong2');
      this.updateHud();
    }

    spawnExplosion(cell){
      if(!cell) return;
      const boom = document.createElement('img'); boom.className = 'explosion'; boom.src = ASSET.explosion; boom.alt = '爆炸'; cell.appendChild(boom);
      setTimeout(() => { if(boom.parentNode) boom.remove(); }, 560);
    }

    removeAnimal(index, mode){
      const animal = this.activeAnimals.get(index); if(!animal) return;
      const cell = animal.el.parentElement;
      this.activeAnimals.delete(index); animal.el.classList.remove('escape');
      if(mode === 'explode') this.spawnExplosion(cell);
      animal.el.classList.add(mode === 'wrong' ? 'wrong-hit' : mode === 'explode' ? 'explode' : mode === 'hit' ? 'hit' : 'escape');
      setTimeout(() => { if(animal.el.parentNode) animal.el.remove(); }, mode === 'explode' ? 520 : 300);
    }

    floatText(index, text, wrong=false){
      const cell = $(`#gameBoard .hole-cell[data-index="${index}"]`) || $(`#tutorialBoard .hole-cell[data-index="${index}"]`); if(!cell) return;
      const el = document.createElement('div'); el.className = `floating-score ${wrong ? 'wrong' : ''}`; el.textContent = text; cell.appendChild(el); setTimeout(()=>el.remove(), 850);
    }

    showToast(text){ const el = $('#toast'); el.textContent = text; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); }
    showPassFlash(text = '已达成目标，继续训练', duration = 1250){ const el = $('#passFlash'); this.clearPassFlashTimer(); el.textContent = text; el.classList.remove('hidden'); this.passFlashTimer = setTimeout(()=>{ el.classList.add('hidden'); this.passFlashTimer = 0; }, duration); }

    updateHud(){
      $('#hudLevel').textContent = `${this.trainingPreset?.name || this.getSelectedPreset().name} · 难度 ${this.currentLevelNo}`;
      $('#hudRoundTime').textContent = fmtTime(this.roundRemainingMs / 1000);
      $('#hudSessionTime').textContent = fmtTime(this.sessionRemainingMs / 1000);
      const projectedRoundPoints = (this.state === 'playing' && !this.roundEnding) ? this.estimateCurrentRoundPoints() : 0;
      $('#hudScore').textContent = String(this.totalScore + projectedRoundPoints);
      $('#hudTarget').textContent = `${this.correctCount}/${this.level.passTarget}`;
      $('#hudFault').textContent = `${this.consecutiveWrong}/2`;
      const pct = this.level?.passTarget ? clamp(Math.round((this.correctCount / this.level.passTarget) * 100), 0, 100) : 0;
      const fill = $('#hudTargetFill'); if(fill) fill.style.width = `${pct}%`;
      const pctLabel = $('#hudTargetPercent'); if(pctLabel) pctLabel.textContent = `${pct}%`;
      const faultStatus = $('#hudFaultStatus'); if(faultStatus) faultStatus.textContent = this.consecutiveWrong <= 0 ? '安全' : this.consecutiveWrong === 1 ? '警告' : '结束';
      const p1 = $('#faultPip1'); const p2 = $('#faultPip2');
      if(p1){ p1.classList.toggle('active', this.consecutiveWrong >= 1); p1.classList.toggle('danger', this.consecutiveWrong >= 2); }
      if(p2){ p2.classList.toggle('active', this.consecutiveWrong >= 2); p2.classList.toggle('danger', this.consecutiveWrong >= 2); }
    }

    calculateRoundPoints(success){ if(!success) return 10; return Math.floor(this.level.passScore + (this.correctCount - this.level.passTarget) * this.level.rewardScore + 10); }
    estimateCurrentRoundPoints(){ return this.calculateRoundPoints(this.passLatched || this.correctCount >= this.level.passTarget); }

    adjustDifficulty(success){
      const before = this.currentLevelNo; let trend = '保持';
      if(success){ this.failStreak = 0; this.currentLevelNo = clamp(this.currentLevelNo + 1, 1, this.maxLevel); trend = this.currentLevelNo > before ? '上升 1 级' : '已达最高难度'; }
      else { this.failStreak += 1; if(this.failStreak === 1){ trend = '保持'; } else if(this.failStreak === 2){ this.currentLevelNo = clamp(this.currentLevelNo - 1, 1, this.maxLevel); trend = '下降 1 级'; } else { this.currentLevelNo = clamp(this.currentLevelNo - 3, 1, this.maxLevel); this.failStreak = 0; trend = '下降 3 级，失败次数清空'; } }
      localStorage.setItem(this.storageKey, String(this.currentLevelNo)); localStorage.setItem(this.failKey, String(this.failStreak));
      return { before, after:this.currentLevelNo, trend, failStreak:this.failStreak };
    }

    endRound(reason){
      if(this.roundEnding) return;
      this.roundEnding = true;
      this.activeAnimals.forEach((_, index) => this.removeAnimal(index, 'escape'));
      const success = this.passLatched || this.correctCount >= this.level.passTarget;
      const points = this.calculateRoundPoints(success);
      const adjust = this.adjustDifficulty(success);
      this.totalScore += points;
      const record = {
        index: this.records.length + 1,
        version: this.config.version,
        difficultyPreset: this.trainingPreset?.name || this.getSelectedPreset().name,
        presetStartLevel: this.trainingStartLevel || this.currentLevelNo,
        level: this.level.level,
        result: success ? 'pass' : 'fail',
        reason,
        actual: this.correctCount,
        target: this.level.passTarget,
        faults: this.faults,
        consecutiveWrong: this.consecutiveWrong,
        finalPoints: points,
        formula: success ? `floor(${this.level.passScore}+(${this.correctCount}-${this.level.passTarget})*${this.level.rewardScore}+10)` : '10',
        trend: adjust.trend,
        nextLevel: adjust.after,
        remainingTrainingSeconds: Math.max(0, Math.ceil(this.sessionRemainingMs / 1000))
      };
      this.records.push(record); if(success) this.trainingPassed = true;
      if(this.sessionRemainingMs <= 0 || reason === 'session0') this.showSessionResult(record);
      else this.autoContinueRound(record);
    }

    autoContinueRound(record){
      this.state = 'roundTransition';
      this.hideModal();
      const status = record.result === 'pass' ? '小关达标' : '小关未达标';
      const waitMs = Math.min(this.config.autoContinueRoundMs || 650, Math.max(0, this.sessionRemainingMs));
      const startedAt = performance.now();
      this.showPassFlash(`${status} ${record.actual}/${record.target}，${record.trend}，自动续训`, Math.max(650, waitMs));
      this.clearRoundResultTimer();
      this.roundResultTimer = setTimeout(() => {
        this.roundResultTimer = 0;
        if(this.state !== 'roundTransition') return;
        const elapsed = Math.max(0, performance.now() - startedAt);
        this.sessionRemainingMs = Math.max(0, this.sessionRemainingMs - elapsed);
        if(this.sessionRemainingMs <= 0) this.showSessionResult(record);
        else this.startRound(false);
      }, waitMs);
    }

    clearRoundResultTimer(){
      if(this.roundResultTimer){ clearTimeout(this.roundResultTimer); this.roundResultTimer = 0; }
    }

    buildResultDashboard(payload){
      const records = payload.records || [];
      const rounds = records.length || 1;
      const passCount = records.filter(r => r.result === 'pass').length;
      const passRate = Math.round((passCount / rounds) * 100);
      const bestActual = records.reduce((max, r) => Math.max(max, r.actual || 0), 0);
      const last = records[records.length - 1];
      const maxLevelSeen = Math.max(1, ...records.map(r => Math.max(r.level || 1, r.nextLevel || 1)), this.maxLevel || 1);
      const recent = records.slice(-12);
      const bars = recent.map(r => {
        const h = clamp(Math.round(((r.level || 1) / maxLevelSeen) * 100), 12, 100);
        const cls = r.result === 'pass' ? 'pass' : 'fail';
        return `<span class="trend-bar ${cls}" style="height:${h}%" data-label="${r.index}" title="第${r.index}轮｜难度${r.level}｜${r.actual}/${r.target}｜${r.result === 'pass' ? '通关' : '失败'}"></span>`;
      }).join('');
      return `<div class="result-dashboard"><div class="result-summary-grid"><div class="summary-tile"><span>通过率</span><strong>${passRate}%</strong></div><div class="summary-tile"><span>通过小关</span><strong>${passCount}/${records.length}</strong></div><div class="summary-tile"><span>最高实际命中</span><strong>${bestActual}</strong></div><div class="summary-tile"><span>最后状态</span><strong>${last ? (last.result === 'pass' ? '通关' : '失败') : '--'}</strong></div></div><div class="trend-panel"><div class="trend-title"><span>最近 12 轮难度趋势</span><span>绿色=通关，橙红=失败</span></div><div class="trend-bars">${bars || '<span class="trend-empty">暂无记录</span>'}</div><div class="trend-note">柱高表示对应小关难度等级；底部数字为小关序号。</div></div></div>`;
    }

    showSessionResult(lastRecord){
      this.clearRoundResultTimer();
      this.state = 'sessionResult'; cancelAnimationFrame(this.raf);
      const payload = this.buildPayload(); window.gameResult = payload; window.dispatchEvent(new CustomEvent('training-finished', { detail:payload }));
      const dashboard = this.buildResultDashboard(payload);
      const rows = this.records.slice(-6).map(r => `<tr><td>${r.index}</td><td>${r.level}</td><td>${r.actual}/${r.target}</td><td>${r.result === 'pass' ? '通关' : '失败'}</td><td>${r.trend}</td><td>${r.finalPoints}</td></tr>`).join('');
      this.showModal({
        title: payload.passFlag ? '通关啦' : '训练结束',
        message: `训练时间已结束。通关标识 passFlag=${payload.passFlag}。`,
        resultItems: [['难度档', `${payload.difficultyPreset} · 起始${payload.startLevel}`], ['总积分', payload.totalScore], ['完成小关', payload.rounds], ['最终难度', payload.finalLevel], ['通关标识', String(payload.passFlag)]],
        extraHtml: `${dashboard}<table class="stat-table"><thead><tr><th>#</th><th>难度</th><th>N/M</th><th>结果</th><th>趋势</th><th>积分</th></tr></thead><tbody>${rows}</tbody></table><pre class="payload">${JSON.stringify(payload, null, 2)}</pre>`,
        buttons: [
          { text:'下载结果', className:'secondary', action:()=>this.downloadPayload(payload) },
          { text:'返回首页', className:'secondary', action:()=>this.showWelcome() },
          { text:'回看教程', className:'secondary', action:()=>{ this.hideModal(); this.startTutorial(); } },
          { text:'再来一次', action:()=>{ this.hideModal(); this.startTraining(); } }
        ]
      });
    }

    buildPayload(){ const preset = this.trainingPreset || this.getSelectedPreset(); return { game:this.config.title, version:this.config.version, mode:this.config.mode, difficultyPreset:preset.name, difficultyPresetId:preset.id, startLevel:this.trainingStartLevel || preset.startLevel, passFlag:!!this.trainingPassed, manualEnd:false, strictAutoContinueToSessionEnd:true, scoreRule:'pass ? floor(passScore + (actual - passTarget) * rewardScore + 10) : 10', totalScore:this.totalScore, rounds:this.records.length, finalLevel:this.currentLevelNo, failStreak:this.failStreak, remainingTrainingSeconds:Math.max(0, Math.ceil(this.sessionRemainingMs / 1000)), records:this.records }; }

    downloadPayload(payload){
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' }); const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `眼疾手快_${this.config.mode}_${payload.difficultyPreset || '训练'}_result.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 500);
    }

    pauseGame(message = '训练已暂停。'){
      if(this.state !== 'playing' || this.paused) return;
      this.paused = true; $('#gameStage').classList.add('blurred');
      this.showModal({ title:'暂停', message, resultItems:[], buttons:[
        { text:'继续游戏', action:()=>this.resumeGame() },
        { text:`音效：${this.audio.soundEnabled ? '开' : '关'}`, className:'secondary', action:(_,btn)=>{ const on = this.audio.toggleSound(); btn.textContent = `音效：${on ? '开' : '关'}`; } },
        { text:`音乐：${this.audio.musicEnabled ? '开' : '关'}`, className:'secondary', action:(_,btn)=>{ const on = this.audio.toggleMusic(); btn.textContent = `音乐：${on ? '开' : '关'}`; } },
        { text:'帮助', className:'secondary', action:()=>this.showHelpModal() }
      ]});
    }
    resumeGame(){ this.paused = false; this.hideModal(); $('#gameStage').classList.remove('blurred'); this.lastFrame = performance.now(); }

    showHelpModal(){
      this.showModal({ title:'帮助', message:'', extraHtml:'<div class="help-list"><div class="help-section-title">难度档位</div><p>0. 首页可选三档：容易从第 1 关开始，普通从第 15 关开始，困难从第 30 关开始。每次正式训练开始时按所选档位重置起始关卡，训练中仍按通过/失败规则升降。</p><div class="help-section-title">目标识别</div><p>1. 普通地鼠点击一次计入实际数 N；头盔地鼠第一次破甲、第二次才计入 N。</p><p>2. 炸弹、白猫、花猫和空洞都不能点；炸弹会触发独立爆炸反馈。</p><div class="help-section-title">小关规则</div><p>3. 连续选错两次或 time=0，当前小关结束。任意一次正确操作会打断连续错误。</p><p>4. 目标 N/M 中，N 是实际正确数，M 是本关目标。达到 M 后本小关达标，但训练继续到下发训练时长归零。</p><div class="help-section-title">结算规则</div><p>5. 达标：难度 +1。失败第 1 次原难度，第 2 次 -1，第 3 次 -3 并清空连续失败次数。</p><p>6. 通过积分 = floor(通关积分 + (实际数 - 目标数) × 奖励分 + 10)；未通过固定 10 分。HUD 显示已结算积分 + 当前小关预计积分。</p><p>7. 首页“自动引导新手教程”会自动讲解和推进；玩家只需按提示完成必要点击，正式训练前可随时回看。</p></div>', buttons:[{ text:'返回暂停', action:()=>{ this.paused = false; this.pauseGame(); } }] });
    }

    showModal({ title, message, resultItems=[], extraHtml='', buttons=[] }){
      const backdrop = $('#modalBackdrop'); $('#modalTitle').textContent = title; $('#modalMessage').textContent = message || '';
      const grid = $('#modalResultGrid'); grid.innerHTML = '';
      if(resultItems.length){ grid.classList.remove('hidden'); resultItems.forEach(([k,v])=>{ const item = document.createElement('div'); item.className='result-item'; item.innerHTML = `<div>${k}</div><strong>${v}</strong>`; grid.appendChild(item); }); } else grid.classList.add('hidden');
      $('#modalExtra').innerHTML = extraHtml || '';
      const box = $('#modalButtons'); box.innerHTML = ''; buttons.forEach(def => { const btn = document.createElement('button'); btn.className = `btn ${def.className || ''}`; btn.textContent = def.text; btn.addEventListener('click', e => def.action(e, btn)); box.appendChild(btn); });
      backdrop.classList.remove('hidden'); $('#modal').focus();
    }
    hideModal(){ $('#modalBackdrop').classList.add('hidden'); $('#gameStage')?.classList.remove('blurred'); }
  }

  document.addEventListener('DOMContentLoaded', () => { window.eyeHandGame = new EyeHandGame(CONFIG); });
})();
(() => {
  'use strict';

  const RAW_CONFIG = globalThis.SILENT_POND_CONFIG;
  if (!RAW_CONFIG || !Array.isArray(RAW_CONFIG.levels)) {
    throw new Error('缺少 SILENT_POND_CONFIG.levels，请确认 data.js 已正确加载。');
  }

  const CANVAS_W = 980;
  const CANVAS_H = 640;
  const POND = { x: 70, y: 74, w: 840, h: 410 };
  const FEEDER = { x: CANVAS_W / 2, y: 592 };
  const LEVELS = RAW_CONFIG.levels;
  const TOTAL_LEVELS = RAW_CONFIG.totalLevels || LEVELS.length;
  const DIFFICULTIES = Object.freeze({
    easy: { key: 'easy', label: '容易', startLevel: 1, tone: '完整基础训练', desc: '从第 1 关开始，节奏最平缓，适合完整体验与初次训练。' },
    normal: { key: 'normal', label: '普通', startLevel: 15, tone: '中段标准训练', desc: '从第 15 关开始，鱼量、速度与遮挡逐步提升。' },
    hard: { key: 'hard', label: '困难', startLevel: 30, tone: '后段高强度训练', desc: '从第 30 关开始，节奏更紧，适合直接挑战高难关卡。' }
  });
  const DEFAULT_DIFFICULTY_KEY = 'easy';
  const TURN_MIN = RAW_CONFIG.turnTime?.min ?? 1.4;
  const TURN_MAX = RAW_CONFIG.turnTime?.max ?? 3.6;
  const BASE_FISH_RADIUS = 27;
  const BASE_FISH_DRAW = { w: 92, h: 55 };
  const PROJECTILE_SPEED = 1120;
  const FISH_SIZE_CONFIG = RAW_CONFIG.fishSize || {};
  const FAULT_POLICY = RAW_CONFIG.faultPolicy || 'allowed_mistakes';
  const FISH_SCALE_MIN = 0.55;
  const FISH_SCALE_MAX = 1.6;
  const clonePlain = (value) => JSON.parse(JSON.stringify(value));
  const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const ASSET_PATHS = {
    stageBackdrop: 'assets/visual/stage_backdrop_980x640.png',
    pondWater: 'assets/visual/pond_water_840x410.png',
    pondFrame: 'assets/visual/pond_frame_stones_980x640.png',
    redKoiSheet: 'assets/fish/red_koi_swim_sheet_8x160x96.png',
    blackGreenKoiSheet: 'assets/fish/black_green_koi_swim_sheet_8x160x96.png',
    greenKoiSheet: 'assets/fish/green_koi_swim_sheet_8x160x96.png',
    lotusLeaf: 'assets/decor/decor_lotus_leaf.png',
    lotusBloom: 'assets/decor/decor_lotus_bloom.png',
    reeds: 'assets/decor/decor_reeds.png',
    algae: 'assets/decor/decor_algae_cluster.png',
    shadowGrass: 'assets/decor/decor_shadow_grass.png',
    stoneMoss: 'assets/decor/decor_stone_moss.png',
    feeder: 'assets/ui/feeder_dispenser.png',
    foodPellet: 'assets/fx/food_pellet.png',
    rippleSuccess: 'assets/fx/ripple_success_sheet_8x256.png',
    rippleFail: 'assets/fx/ripple_fail_sheet_8x256.png',
    splashSuccess: 'assets/fx/splash_success_sheet_8x256.png',
    splashFail: 'assets/fx/splash_fail_sheet_8x256.png'
  };

  const $ = (id) => document.getElementById(id);
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const dist = (a, b, c, d) => Math.hypot(a - c, b - d);
  const round1 = (n) => Math.round(n * 10) / 10;

  class TonePlayer {
    constructor() {
      this.ctx = null;
      this.volume = 0.55;
      this.muted = false;
      this.samples = {};
      this.ambient = null;
      this.initSamples();
    }

    initSamples() {
      const files = {
        start: 'assets/audio/sfx_start_water_swell.wav',
        shoot: 'assets/audio/sfx_food_shoot.wav',
        success: 'assets/audio/sfx_feed_success_splash.wav',
        fail: 'assets/audio/sfx_feed_fail_splash.wav',
        pass: 'assets/audio/sfx_level_pass_chime.wav',
        end: 'assets/audio/sfx_game_end_gong.wav',
        ui: 'assets/audio/sfx_ui_click.wav'
      };
      if (typeof Audio !== 'function') return;
      for (const [key, src] of Object.entries(files)) {
        const a = new Audio(src);
        a.preload = 'auto';
        this.samples[key] = a;
      }
      this.ambient = new Audio('assets/audio/ambient_pond_loop_12s.wav');
      this.ambient.preload = 'auto';
      this.ambient.loop = true;
      this.ambient.volume = this.volume * 0.28;
    }

    ensure() {
      try {
        if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      } catch (err) {
        // 本地文件或浏览器权限可能限制 WebAudio；不影响主流程。
      }
      this.startAmbient();
    }

    setVolume(v) {
      this.volume = clamp(Number(v), 0, 1);
      if (this.ambient) this.ambient.volume = this.muted ? 0 : this.volume * 0.28;
    }

    setMuted(flag) {
      this.muted = Boolean(flag);
      if (!this.ambient) return;
      if (this.muted) {
        try { this.ambient.pause(); } catch (err) {}
      } else {
        this.startAmbient();
      }
    }

    startAmbient() {
      if (this.muted || !this.ambient) return;
      try {
        this.ambient.volume = this.volume * 0.28;
        const played = this.ambient.play();
        if (played && typeof played.catch === 'function') played.catch(() => {});
      } catch (err) {
        // 浏览器未获得用户手势前可能拒绝播放；下一次点击时会再次尝试。
      }
    }

    play(kind) {
      if (this.muted) return;
      const sample = this.samples?.[kind];
      if (sample) {
        try {
          const s = sample.cloneNode(true);
          s.volume = clamp(this.volume, 0, 1);
          const played = s.play();
          if (played && typeof played.catch === 'function') played.catch(() => {});
          return;
        } catch (err) {
          // 若浏览器阻止本地音频，继续使用合成音作为兜底。
        }
      }
      try {
        this.ensure();
        if (!this.ctx) return;
        const patterns = {
          start: [[280, 0.04], [420, 0.06], [560, 0.08]],
          shoot: [[520, 0.05]],
          success: [[640, 0.06], [860, 0.08]],
          fail: [[220, 0.10], [150, 0.11]],
          pass: [[520, 0.08], [720, 0.08], [920, 0.12]],
          end: [[260, 0.12], [190, 0.16]],
          ui: [[720, 0.035]]
        };
        const sequence = patterns[kind] || patterns.shoot;
        let t = this.ctx.currentTime;
        for (const [freq, dur] of sequence) {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, this.volume * 0.18), t + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain).connect(this.ctx.destination);
          osc.start(t);
          osc.stop(t + dur + 0.02);
          t += dur + 0.03;
        }
      } catch (err) {
        // 浏览器可能禁用音频，游戏逻辑不依赖音频。
      }
    }
  }

  class SilentPondGame {
    constructor() {
      this.canvas = $('pondCanvas');
      this.ctx = this.canvas.getContext('2d');
      this.modal = $('modal');
      this.modalCard = $('modalCard');
      this.prompt = $('tutorialPrompt');
      this.toastBox = $('toast');
      this.tone = new TonePlayer();
      this.images = {};
      this.loadImages();

      this.levelText = $('levelText');
      this.timeText = $('timeText');
      this.foodText = $('foodText');
      this.faultText = $('faultText');
      this.scoreText = $('scoreText');
      this.totalScoreText = $('totalScoreText');
      this.cooldownFill = $('cooldownFill');
      this.cooldownText = $('cooldownText');

      this.mode = 'boot';
      this.levelIndex = 0;
      this.currentLevel = null;
      this.totalScore = 0;
      this.levelScore = 0;
      this.trend = [];
      this.difficultyKey = DEFAULT_DIFFICULTY_KEY;
      this.sessionStartIndex = 0;
      this.fish = [];
      this.obstacles = [];
      this.decorations = [];
      this.projectiles = [];
      this.waves = [];
      this.timer = 0;
      this.foodLeft = 0;
      this.foodMax = 0;
      this.errors = 0;
      this.cooldown = 0;
      this.startFx = 0;
      this.ambientWaveTimer = rand(1.2, 2.8);
      this.pendingEnd = null;
      this.frozenRemaining = null;
      this.tutorialStep = 0;
      this.toastTimer = 0;
      this.lastNow = performance.now();
      this.pausedSnapshot = null;

      this.bindEvents();
      this.updateHUD();
    }

    loadImages() {
      for (const [key, src] of Object.entries(ASSET_PATHS)) {
        const img = new Image();
        img.src = src;
        this.images[key] = img;
      }
    }

    imageReady(key) {
      const img = this.images?.[key];
      return img && img.complete && img.naturalWidth > 0;
    }

    bindEvents() {
      this.canvas.addEventListener('click', (evt) => {
        const p = this.getCanvasPoint(evt);
        this.handleCanvasClick(p.x, p.y);
      });

      $('pauseBtn').addEventListener('click', () => {
        if (this.mode === 'playing') {
          this.tone.ensure();
          this.tone.play('ui');
          this.pause();
        }
      });

      window.addEventListener('keydown', (evt) => {
        if (evt.key === 'Escape' && this.mode === 'playing') this.pause();
      });
    }

    boot() {
      this.showWelcome();
      requestAnimationFrame((now) => this.loop(now));
    }

    loop(now) {
      const dt = Math.min(0.05, (now - this.lastNow) / 1000 || 0);
      this.lastNow = now;
      this.update(dt);
      this.render();
      requestAnimationFrame((t) => this.loop(t));
    }

    update(dt) {
      if (this.toastTimer > 0) {
        this.toastTimer -= dt;
        if (this.toastTimer <= 0) this.toastBox.classList.add('hidden');
      }

      if (this.mode === 'paused') {
        this.updateHUD();
        return;
      }

      let timerExpired = false;
      if (this.mode === 'playing') {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.timer = 0;
          timerExpired = true;
        }
      }

      if (this.cooldown > 0 && (this.mode === 'playing' || this.mode === 'tutorial')) {
        this.cooldown = Math.max(0, this.cooldown - dt);
      }

      if (this.startFx > 0) this.startFx = Math.max(0, this.startFx - dt);

      this.updateFish(dt);
      this.updateProjectiles(dt);
      this.updateWaves(dt);
      this.updateAmbientRipples(dt);
      this.setStartFxBlur(this.startFx > 0 && (this.mode === 'playing' || this.mode === 'tutorial'));

      // 倒计时归零先暂存，等本帧已到达的投食弹完成处理后再失败。
      // 这样可避免“最后一口食物本帧命中，但先被 timer<=0 判失败”的帧级竞态。
      if (timerExpired && this.mode === 'playing') {
        this.failLevel('倒计时结束');
      }

      if (this.pendingEnd) {
        this.pendingEnd.delay -= dt;
        if (this.pendingEnd.delay <= 0) {
          const action = this.pendingEnd.action;
          this.pendingEnd = null;
          action();
        }
      }

      this.updateHUD();
    }

    updateFish(dt) {
      for (const f of this.fish) {
        if (f.jump > 0) f.jump = Math.max(0, f.jump - dt);
        if (f.fail > 0) f.fail = Math.max(0, f.fail - dt);
        f.tail += dt * 8;

        if (this.mode !== 'playing') continue;

        f.turnElapsed += dt;
        if (f.turnElapsed >= f.turnAfter) {
          this.randomizeDirection(f);
          f.turnElapsed = 0;
          f.turnAfter = rand(TURN_MIN, TURN_MAX);
        }

        f.x += f.vx * dt;
        f.y += f.vy * dt;
        this.resolveBoundary(f);
        this.resolveObstacleCollision(f);
        f.angle = Math.atan2(f.vy, f.vx);
      }
    }

    updateProjectiles(dt) {
      for (const p of this.projectiles) {
        const target = this.getProjectileTarget(p);
        p.tx = target.x;
        p.ty = target.y;
        p.elapsed += dt;
      }
      const arrived = this.projectiles.filter((p) => p.elapsed >= p.duration);
      this.projectiles = this.projectiles.filter((p) => p.elapsed < p.duration);
      for (const p of arrived) this.finishProjectile(p);
    }

    updateWaves(dt) {
      for (const w of this.waves) w.life -= dt;
      this.waves = this.waves.filter((w) => w.life > 0);
    }

    updateAmbientRipples(dt) {
      if (this.mode !== 'playing' && this.mode !== 'tutorial') return;
      this.ambientWaveTimer -= dt;
      if (this.ambientWaveTimer > 0) return;
      this.ambientWaveTimer = rand(2.0, 4.4);
      this.waves.push({
        x: rand(POND.x + 80, POND.x + POND.w - 80),
        y: rand(POND.y + 70, POND.y + POND.h - 70),
        r: rand(5, 12),
        life: 1.1,
        maxLife: 1.1,
        strong: false,
        kind: 'ambient',
        alpha: 0.32
      });
    }

    showWelcome() {
      this.mode = 'welcome';
      this.pausedSnapshot = null;
      this.totalScore = 0;
      this.levelScore = 0;
      this.trend = [];
      this.sessionStartIndex = this.getDifficultyStartIndex(this.difficultyKey);
      this.clearStage();
      this.setBlur(false);
      this.prompt.classList.add('hidden');
      const difficultyCards = Object.values(DIFFICULTIES).map((d) => {
        const index = this.getDifficultyStartIndex(d);
        const lvl = LEVELS[index];
        const red = Number(lvl?.RedNum ?? 0);
        const speed = Number(lvl?.Speed ?? 0);
        const time = Number(lvl?.Time ?? 0);
        const selected = d.key === this.difficultyKey ? ' selected' : '';
        return `<button class="difficultyCard${selected}" type="button" data-difficulty="${d.key}" aria-label="选择${d.label}难度，从第${d.startLevel}关开始">
          <span class="difficultyTop"><strong>${d.label}</strong><em>${d.tone}</em></span>
          <span class="difficultyStart">第 ${d.startLevel} 关开始</span>
          <span class="difficultyDesc">${d.desc}</span>
          <span class="difficultyMeta"><b>${red}</b> 红鱼 · <b>${speed}</b> 速度 · <b>${time}s</b> 倒计时</span>
        </button>`;
      }).join('');
      this.showModal({
        title: '静默池塘',
        variant: 'welcomeModal',
        html: `<img class="modalLogo" src="assets/ui/logo_silent_pond.svg" alt="静默池塘标志"><p>选择训练难度后直接进入对应起始关卡。你需要点击所有未被投食过的红鲤鱼；重复红鲤鱼或干扰鲤鱼会计错。</p><div class="fishLegend"><span><img src="assets/fish/red_koi.png" alt="红鲤鱼"><img class="legendBadge" src="assets/fish/red_koi_icon.png" alt="">目标红鲤鱼</span><span><img src="assets/fish/black_green_koi.png" alt="黑绿色干扰鲤鱼"><img class="legendBadge" src="assets/fish/green_koi_icon.png" alt="">干扰鲤鱼</span><span><img src="assets/fish/green_koi.png" alt="绿色干扰鲤鱼">干扰鲤鱼变体</span></div><section class="difficultySelect" aria-label="难度选择"><h3>选择难度</h3><div class="difficultyGrid">${difficultyCards}</div></section><p class="minor">容易从第 1 关开始，普通从第 15 关开始，困难从第 30 关开始。需要练习规则时，可先进入新手引导。</p>`,
        buttons: [
          { label: '新手引导', kind: 'secondary', action: () => this.startTutorial(false) }
        ],
        afterRender: () => {
          for (const btn of this.modalCard.querySelectorAll('.difficultyCard')) {
            btn.addEventListener('click', (evt) => {
              evt.stopPropagation();
              this.tone.ensure();
              this.tone.startAmbient();
              this.tone.play('ui');
              this.startTraining(btn.dataset.difficulty || DEFAULT_DIFFICULTY_KEY);
            });
          }
        }
      });
    }

    getDifficulty(key = this.difficultyKey) {
      return DIFFICULTIES[key] || DIFFICULTIES[DEFAULT_DIFFICULTY_KEY];
    }

    getDifficultyStartIndex(difficulty) {
      const d = typeof difficulty === 'string' ? this.getDifficulty(difficulty) : (difficulty || this.getDifficulty());
      const levelNo = Number(d.startLevel) || 1;
      const exact = LEVELS.findIndex((lvl) => Number(lvl.Level) === levelNo);
      if (exact >= 0) return exact;
      return clamp(levelNo - 1, 0, Math.max(0, LEVELS.length - 1));
    }

    selectDifficulty(key = this.difficultyKey) {
      const d = this.getDifficulty(key);
      this.difficultyKey = d.key;
      this.sessionStartIndex = this.getDifficultyStartIndex(d);
      return d;
    }

    clearStage() {
      this.fish = [];
      this.obstacles = [];
      this.decorations = [];
      this.projectiles = [];
      this.waves = [];
      this.currentLevel = null;
      this.timer = 0;
      this.foodLeft = 0;
      this.foodMax = 0;
      this.errors = 0;
      this.cooldown = 0;
      this.levelScore = 0;
      this.startFx = 0;
      this.ambientWaveTimer = rand(1.2, 2.8);
      this.pendingEnd = null;
      this.frozenRemaining = null;
      this.setStartFxBlur(false);
      this.updateHUD();
    }

    startTutorial(fromPause, preserveSnapshot = false) {
      if (fromPause && !preserveSnapshot && !this.pausedSnapshot) {
        this.pausedSnapshot = this.makeSnapshot();
      } else if (!fromPause && !preserveSnapshot) {
        this.pausedSnapshot = null;
      }
      this.hideModal();
      this.setBlur(false);
      this.mode = 'tutorial';
      this.clearStage();
      this.currentLevel = { Level: 0, SpaceTime: 0.8, Time: 0, Fault: 0, Score: 0, Scores: 0, Limit: 0 };
      this.foodMax = 2;
      this.foodLeft = 2;
      this.levelScore = 0;
      this.startFx = 0.9;
      this.obstacles = [];
      this.decorations = this.makeDecorations(3, false);
      this.fish = [
        this.makeFish('red', POND.x + POND.w * 0.35, POND.y + POND.h * 0.52, 0, 1),
        this.makeFish('red', POND.x + POND.w * 0.64, POND.y + POND.h * 0.38, Math.PI, 2)
      ];
      for (const f of this.fish) {
        f.vx = 0;
        f.vy = 0;
        f.angle = f.id === 1 ? 0.12 : Math.PI - 0.18;
      }
      this.tutorialStep = 0;
      this.setPrompt('请为所有的红鲤鱼投食');
      this.tone.play('start');
      window.setTimeout(() => {
        if (this.mode === 'tutorial' && this.tutorialStep === 0) {
          this.tutorialStep = 1;
          this.setPrompt('点击红鲤鱼即可投食');
        }
      }, 3000);
    }

    setPrompt(text) {
      this.prompt.textContent = text;
      this.prompt.classList.remove('hidden');
    }

    handleCanvasClick(x, y) {
      this.tone.ensure();
      this.tone.startAmbient();
      if (this.mode === 'tutorial') {
        this.handleTutorialClick(x, y);
        return;
      }
      if (this.mode !== 'playing') return;
      if (this.cooldown > 0) {
        this.toast(`投食机冷却中：${this.cooldown.toFixed(1)}s`);
        return;
      }
      const target = this.pickFish(x, y);
      if (!target) return;
      this.shootFood(target, false);
    }

    handleTutorialClick(x, y) {
      if (this.tutorialStep < 1 || this.cooldown > 0) return;
      const target = this.pickFish(x, y);
      if (!target) return;
      if (this.tutorialStep === 1 && target.id === 1 && !target.fed) {
        this.shootFood(target, true);
      } else if (this.tutorialStep === 2 && target.id === 2 && !target.fed) {
        this.shootFood(target, true);
      } else {
        this.toast('请按提示点击当前高亮的红鲤鱼');
      }
    }

    startTraining(key = this.difficultyKey) {
      const difficulty = this.selectDifficulty(key);
      this.hideModal();
      this.pausedSnapshot = null;
      this.totalScore = 0;
      this.levelScore = 0;
      this.trend = [];
      this.levelIndex = this.sessionStartIndex;
      this.startLevel(this.sessionStartIndex);
      this.toast(`${difficulty.label}难度：从第 ${difficulty.startLevel} 关开始`);
    }

    startLevel(index) {
      this.hideModal();
      this.setBlur(false);
      const lvl = LEVELS[index];
      if (!lvl) {
        this.showWelcome();
        return;
      }
      this.mode = 'playing';
      this.levelIndex = index;
      this.currentLevel = lvl;
      this.timer = Number(lvl.Time) || 30;
      this.foodMax = Number(lvl.RedNum) || 0;
      this.foodLeft = this.foodMax;
      this.errors = 0;
      this.cooldown = 0;
      this.levelScore = 0;
      this.projectiles = [];
      this.waves = [];
      this.pendingEnd = null;
      this.frozenRemaining = null;
      this.startFx = 1.05;
      this.ambientWaveTimer = rand(1.2, 2.8);
      this.prompt.classList.add('hidden');
      this.buildPond(Number(lvl.Shade) || 0);
      this.spawnFish(lvl);
      this.tone.play('start');
      this.updateHUD();
    }

    buildPond(shadeLevel) {
      const blockingCount = clamp(Math.floor(shadeLevel), 0, 8);
      this.obstacles = [];
      for (let i = 0; i < blockingCount; i++) {
        let placed = null;
        for (let attempt = 0; attempt < 80 && !placed; attempt++) {
          const rx = rand(38, 58);
          const ry = rand(24, 44);
          const obj = {
            id: `ob-${i}`,
            x: rand(POND.x + 110, POND.x + POND.w - 110),
            y: rand(POND.y + 86, POND.y + POND.h - 84),
            rx,
            ry,
            rot: rand(-0.45, 0.45),
            type: i % 6,
            blocking: true
          };
          const awayFromFeeder = dist(obj.x, obj.y, FEEDER.x, FEEDER.y) > 160;
          const noOverlap = this.obstacles.every(o => dist(obj.x, obj.y, o.x, o.y) > obj.rx + o.rx + 34);
          if (awayFromFeeder && noOverlap) placed = obj;
        }
        if (placed) this.obstacles.push(placed);
      }
      this.decorations = [...this.obstacles, ...this.makeDecorations(4 + shadeLevel * 2, false)];
    }

    makeDecorations(count, blocking) {
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push({
          id: `deco-${i}-${Math.random().toString(16).slice(2)}`,
          x: rand(POND.x + 50, POND.x + POND.w - 50),
          y: rand(POND.y + 40, POND.y + POND.h - 40),
          rx: rand(18, 46),
          ry: rand(12, 34),
          rot: rand(-0.8, 0.8),
          type: Math.floor(rand(0, 6)),
          blocking: Boolean(blocking),
          alpha: rand(0.34, 0.58)
        });
      }
      return items;
    }

    fishScaleForType(type, level = this.currentLevel) {
      const cfg = FISH_SIZE_CONFIG || {};
      const keys = type === 'red'
        ? ['RedSize', 'RedPercent', 'RedFishSize', 'RedFishPercent', 'redPercent']
        : ['BlackSize', 'BlackPercent', 'BlackFishSize', 'BlackFishPercent', 'blackPercent'];
      let raw = null;
      for (const key of keys) {
        if (level && level[key] !== undefined && level[key] !== null && level[key] !== '') {
          raw = level[key];
          break;
        }
        if (cfg && cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== '') {
          raw = cfg[key];
          break;
        }
      }
      if (raw === null) raw = 100;
      const numeric = Number(raw);
      return clamp((Number.isFinite(numeric) ? numeric : 100) / 100, FISH_SCALE_MIN, FISH_SCALE_MAX);
    }

    fishRadiusForType(type, level = this.currentLevel) {
      return BASE_FISH_RADIUS * this.fishScaleForType(type, level);
    }

    spawnFish(level) {
      this.fish = [];
      const speed = Number(level.Speed) || 80;
      const red = Number(level.RedNum) || 0;
      const black = Number(level.BlackNum) || 0;
      let id = 1;
      for (let i = 0; i < red; i++) this.fish.push(this.spawnOneFish('red', speed, id++));
      for (let i = 0; i < black; i++) this.fish.push(this.spawnOneFish('black', speed, id++));
    }

    spawnOneFish(type, speed, id) {
      const radius = this.getFishRadius(type);
      let x = POND.x + POND.w / 2;
      let y = POND.y + POND.h / 2;
      for (let attempt = 0; attempt < 160; attempt++) {
        const candidateX = rand(POND.x + radius + 28, POND.x + POND.w - radius - 28);
        const candidateY = rand(POND.y + radius + 24, POND.y + POND.h - radius - 24);
        const goodSpacing = this.fish.every(f => dist(candidateX, candidateY, f.x, f.y) > radius + f.radius + 8);
        const notInsideBlock = this.obstacles.every(o => !this.pointInExpandedEllipse(candidateX, candidateY, o, radius + 8));
        if (goodSpacing && notInsideBlock) {
          x = candidateX;
          y = candidateY;
          break;
        }
      }
      const f = this.makeFish(type, x, y, rand(0, Math.PI * 2), id);
      f.speed = speed;
      f.vx = Math.cos(f.angle) * speed;
      f.vy = Math.sin(f.angle) * speed;
      f.turnAfter = rand(TURN_MIN, TURN_MAX);
      return f;
    }

    getFishScale(type) {
      return this.fishScaleForType(type, this.currentLevel);
    }

    getFishRadius(type) {
      return BASE_FISH_RADIUS * this.getFishScale(type);
    }

    makeFish(type, x, y, angle, id) {
      const scale = this.getFishScale(type);
      return {
        id,
        type,
        x,
        y,
        angle,
        vx: 0,
        vy: 0,
        speed: 0,
        scale,
        radius: BASE_FISH_RADIUS * scale,
        fed: false,
        pending: false,
        jump: 0,
        fail: 0,
        tail: rand(0, 10),
        turnElapsed: 0,
        turnAfter: rand(TURN_MIN, TURN_MAX)
      };
    }

    randomizeDirection(f) {
      const a = rand(0, Math.PI * 2);
      f.vx = Math.cos(a) * f.speed;
      f.vy = Math.sin(a) * f.speed;
      f.angle = a;
    }

    resolveBoundary(f) {
      const r = f.radius;
      if (f.x < POND.x + r) { f.x = POND.x + r; f.vx = Math.abs(f.vx); }
      if (f.x > POND.x + POND.w - r) { f.x = POND.x + POND.w - r; f.vx = -Math.abs(f.vx); }
      if (f.y < POND.y + r) { f.y = POND.y + r; f.vy = Math.abs(f.vy); }
      if (f.y > POND.y + POND.h - r) { f.y = POND.y + POND.h - r; f.vy = -Math.abs(f.vy); }
    }

    resolveObstacleCollision(f) {
      for (const o of this.obstacles) {
        const expanded = Math.max(12, f.radius * 0.8);
        if (!this.pointInExpandedEllipse(f.x, f.y, o, expanded)) continue;
        const dx = f.x - o.x;
        const dy = f.y - o.y;
        let nx = dx / Math.pow(o.rx + expanded, 2);
        let ny = dy / Math.pow(o.ry + expanded, 2);
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        const dot = f.vx * nx + f.vy * ny;
        f.vx = f.vx - 2 * dot * nx;
        f.vy = f.vy - 2 * dot * ny;
        const vlen = Math.hypot(f.vx, f.vy) || 1;
        f.vx = f.vx / vlen * f.speed;
        f.vy = f.vy / vlen * f.speed;
        f.x += nx * 8;
        f.y += ny * 8;
        f.angle = Math.atan2(f.vy, f.vx);
      }
    }

    pointInExpandedEllipse(x, y, o, expand) {
      const rot = -(o.rot || 0);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const dx = x - o.x;
      const dy = y - o.y;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      return (rx * rx) / Math.pow(o.rx + expand, 2) + (ry * ry) / Math.pow(o.ry + expand, 2) <= 1;
    }

    pickFish(x, y) {
      for (let i = this.fish.length - 1; i >= 0; i--) {
        const f = this.fish[i];
        if (dist(x, y, f.x, f.y) <= f.radius * 1.08) return f;
      }
      return null;
    }

    getProjectileTarget(p) {
      const f = this.fish.find(item => item.id === p.fishId);
      if (f) return { x: f.x, y: f.y };
      return { x: p.tx, y: p.ty };
    }

    shootFood(target, tutorial) {
      const valid = target.type === 'red' && !target.fed && !target.pending;
      const cd = tutorial ? 0.45 : Number(this.currentLevel?.SpaceTime || 1);
      this.cooldown = cd;
      if (valid) {
        target.pending = true;
        this.foodLeft = Math.max(0, this.foodLeft - 1);
      }
      const d = dist(FEEDER.x, FEEDER.y, target.x, target.y);
      this.projectiles.push({
        x: FEEDER.x,
        y: FEEDER.y,
        sx: FEEDER.x,
        sy: FEEDER.y,
        tx: target.x,
        ty: target.y,
        fishId: target.id,
        success: valid,
        tutorial,
        elapsed: 0,
        duration: Math.max(0.12, d / PROJECTILE_SPEED)
      });
      this.tone.play('shoot');
      this.updateHUD();
    }

    finishProjectile(p) {
      const f = this.fish.find(item => item.id === p.fishId);
      if (!f) return;
      if (p.success) {
        f.pending = false;
        f.fed = true;
        f.jump = 0.62;
        this.waves.push({ x: f.x, y: f.y, r: 8, life: 0.72, maxLife: 0.72, strong: true, kind: 'success' });
        this.tone.play('success');
        if (this.mode === 'tutorial') {
          this.advanceTutorialAfterSuccess(f.id);
        } else if (this.mode === 'playing' && this.fish.filter(item => item.type === 'red').every(item => item.fed)) {
          const remainingAtClear = Math.max(0, round1(this.timer));
          this.frozenRemaining = remainingAtClear;
          this.mode = 'resolving';
          this.cooldown = 0;
          this.pendingEnd = { delay: 0.36, action: () => this.completeLevel(remainingAtClear) };
        }
      } else {
        f.fail = 0.72;
        this.waves.push({ x: f.x, y: f.y, r: 10, life: 0.66, maxLife: 0.66, strong: false, kind: 'fail' });
        this.tone.play('fail');
        if (this.mode === 'playing') {
          this.errors += 1;
          if (this.isFaultLimitExceeded()) {
            this.mode = 'resolving';
            this.cooldown = 0;
            this.pendingEnd = { delay: 0.25, action: () => this.failLevel('错误次数超过容错上限') };
          }
        }
      }
    }

    getFaultLimit() {
      return Math.max(0, Number(this.currentLevel?.Fault ?? 0));
    }

    isFaultLimitExceeded() {
      const fault = this.getFaultLimit();
      if (FAULT_POLICY === 'failure_threshold') return this.errors >= Math.max(1, fault);
      return this.errors > fault;
    }

    advanceTutorialAfterSuccess(id) {
      if (this.tutorialStep === 1 && id === 1) {
        this.tutorialStep = 2;
        this.setPrompt('每条红鲤鱼只需要投食一次');
      } else if (this.tutorialStep === 2 && id === 2) {
        this.tutorialStep = 3;
        this.prompt.classList.add('hidden');
        this.pendingEnd = { delay: 0.45, action: () => this.showGuideComplete() };
      }
    }

    showGuideComplete() {
      this.mode = 'guideDone';
      const fromPausedGame = Boolean(this.pausedSnapshot);
      const buttons = fromPausedGame ? [
        { label: '返回原关卡', kind: 'primary', action: () => this.restoreSnapshot() },
        { label: '重新演示', kind: 'secondary', action: () => this.replayTutorialPreservingSnapshot() },
        { label: '放弃原局并重新训练', kind: 'danger', action: () => this.startTraining(this.difficultyKey) }
      ] : [
        { label: '容易训练', kind: 'primary', action: () => this.startTraining('easy') },
        { label: '普通训练', kind: 'primary', action: () => this.startTraining('normal') },
        { label: '困难训练', kind: 'primary', action: () => this.startTraining('hard') },
        { label: '重新演示', kind: 'secondary', action: () => this.startTutorial(false) }
      ];
      const extra = fromPausedGame ? '<p class="minor">你是从暂停帮助进入引导的。选择“返回原关卡”会恢复进入引导前的计时、鱼、食物、错误次数和总分。</p>' : '';
      this.showModal({
        title: '引导完成',
        html: `<p>你已经完成新手引导。正式训练中，投食机有冷却时间；重复投食红鲤鱼或投给干扰鲤鱼都会计入错误；错误次数超过本关可错次数时失败。</p><p class="minor">可选择：容易从第 1 关开始，普通从第 15 关开始，困难从第 30 关开始。</p>${extra}`,
        buttons
      });
    }

    completeLevel(remainingOverride = null) {
      if (this.mode !== 'playing' && this.mode !== 'resolving') return;
      const level = this.currentLevel;
      const levelTime = Number(level.Time) || 1;
      const remaining = remainingOverride === null ? Math.max(0, round1(this.timer)) : Math.max(0, round1(remainingOverride));
      this.timer = remaining;
      const base = Number(level.Score) || 0;
      const extra = Number(level.Scores) || 0;
      const score = Math.round(base + extra * remaining / levelTime);
      const rewardMet = remaining >= Number(level.Limit || 0);
      const rewardTextRaw = rewardMet ? `奖励类型 ${level.Reward} × ${level.RewardNum}` : '未达成剩余时间奖励条件';
      const rewardText = escapeHtml(rewardTextRaw);
      this.levelScore = score;
      this.totalScore += score;
      this.trend.push(score);
      this.frozenRemaining = null;
      this.mode = 'levelComplete';
      const isFinalLevel = this.levelIndex + 1 >= TOTAL_LEVELS;
      this.tone.play(isFinalLevel ? 'end' : 'pass');

      const resultTitle = isFinalLevel ? `通关界面｜${TOTAL_LEVELS}/${TOTAL_LEVELS}` : `完成界面｜第 ${level.Level} 关`;
      const rewardBadge = rewardMet ? '奖励达成' : '奖励未达成';
      const trendCount = this.trend.slice(-10).length;
      const html = `
        <section class="resultPanel" aria-label="关卡结算结果">
          <header class="resultRibbon">
            <span class="resultLotus" aria-hidden="true"></span>
            <span class="resultTitle">
              <span class="resultEyebrow">${isFinalLevel ? '全部训练完成' : '关卡完成'}</span>
              <h2>${escapeHtml(resultTitle)}</h2>
            </span>
            <span class="resultBadge ${rewardMet ? 'ok' : 'miss'}">${escapeHtml(rewardBadge)}</span>
          </header>

          <div class="resultStats" aria-label="结算数据">
            <article class="resultStat primaryStat">
              <span class="statIcon"><img src="assets/ui/icon_score.svg" alt=""></span>
              <span class="statCopy"><span class="statKicker">Score</span><span class="statLabel">本关得分</span><strong class="statValue">${score}</strong></span>
            </article>
            <article class="resultStat">
              <span class="statIcon"><img src="assets/ui/icon_timer.svg" alt=""></span>
              <span class="statCopy"><span class="statLabel">剩余倒计时</span><strong class="statValue">${remaining.toFixed(1)}s</strong></span>
            </article>
            <article class="resultStat">
              <span class="statIcon"><img src="assets/ui/icon_trophy.svg" alt=""></span>
              <span class="statCopy"><span class="statLabel">累计总分</span><strong class="statValue">${this.totalScore}</strong></span>
            </article>
            <article class="resultStat ${rewardMet ? 'rewardOk' : 'rewardMiss'}">
              <span class="statIcon"><img src="assets/ui/icon_gift.svg" alt=""></span>
              <span class="statCopy"><span class="statLabel">本关奖励</span><strong class="statValue small">${rewardText}</strong></span>
            </article>
          </div>

          <div class="resultFormula" aria-label="积分公式">
            <div class="formulaHeader">本关积分公式</div>
            <div class="formulaEquation"><span>基础分 <b>${base}</b></span><span class="formulaPlus">+</span><span>时间奖励 <b>${extra}</b> × ${remaining.toFixed(1)} / ${levelTime.toFixed(1)}</span><span class="formulaEqual">=</span><strong>${score}</strong></div>
          </div>
          <section class="trendBox resultTrend" aria-label="得分趋势">
            <div class="trendTitle"><span>得分趋势</span><em>最近 ${trendCount} 关</em></div>
            ${this.buildTrendSvg()}
          </section>
        </section>`;

      if (isFinalLevel) {
        this.showModal({
          title: '',
          html,
          variant: 'resultModal',
          buttons: [
            { label: '继续', kind: 'primary', action: () => this.finishGame() },
            { label: '重新训练', kind: 'secondary', action: () => this.startTraining(this.difficultyKey) }
          ]
        });
      } else {
        this.showModal({
          title: '',
          html,
          variant: 'resultModal',
          buttons: [
            { label: '继续', kind: 'primary', action: () => this.startLevel(this.levelIndex + 1) }
          ]
        });
      }
    }

    finishGame() {
      const difficulty = this.getDifficulty();
      const payload = {
        title: RAW_CONFIG.gameTitle || '静默池塘',
        difficulty: difficulty.label,
        startLevel: difficulty.startLevel,
        totalScore: this.totalScore,
        trend: [...this.trend],
        levels: TOTAL_LEVELS,
        completedLevels: Math.max(0, TOTAL_LEVELS - this.sessionStartIndex),
        completedAt: new Date().toISOString()
      };
      const callback = globalThis.SilentPondOnGameComplete || globalThis.onSilentPondComplete;
      if (typeof callback === 'function') {
        callback(payload);
        return;
      }
      try {
        if (typeof CustomEvent === 'function') {
          globalThis.dispatchEvent?.(new CustomEvent('silentpond:complete', { detail: payload }));
        }
      } catch (err) {
        // 外部容器未实现事件 API 时忽略，单机版返回欢迎界面。
      }
      if (RAW_CONFIG.nextGameUrl) {
        globalThis.location.href = RAW_CONFIG.nextGameUrl;
      } else {
        this.showWelcome();
      }
    }

    failLevel(reason) {
      if (this.mode !== 'playing' && this.mode !== 'resolving') return;
      this.pendingEnd = null;
      this.frozenRemaining = null;
      this.mode = 'levelFail';
      this.tone.play('fail');
      this.showModal({
        title: '关卡失败',
        html: `<p>${escapeHtml(reason)}。</p><p>当前关卡需要为所有红鲤鱼各投食一次；重复红鲤鱼或干扰鲤鱼会计错，错误次数超过可错上限后失败。</p>`,
        buttons: [
          { label: '重试本关', kind: 'primary', action: () => this.startLevel(this.levelIndex) },
          { label: '更换难度', kind: 'secondary', action: () => this.showWelcome() },
          { label: '重新演示', kind: 'secondary', action: () => this.startTutorial(false) }
        ]
      });
    }

    pause() {
      this.mode = 'paused';
      this.setBlur(true);
      this.showModal({
        title: '暂停界面',
        html: `
          <p>游戏已暂停。主游戏界面已做模糊处理。</p>
          <div class="volumeRow"><label for="volumeSlider"><span class="inlineIcon soundOnIcon" aria-hidden="true"></span>声音大小</label><input id="volumeSlider" type="range" min="0" max="1" step="0.01" value="${this.tone.volume}"></div>
          <div class="volumeRow"><label><span class="inlineIcon soundOffIcon" aria-hidden="true"></span><input id="muteCheck" type="checkbox" ${this.tone.muted ? 'checked' : ''}> 静音</label></div>
          <p class="minor">帮助界面可查看规则；需要时可重新开启引导演示，演示完成后可返回原关卡。</p>`,
        buttons: [
          { label: '继续游戏', kind: 'primary', action: () => this.resume() },
          { label: '帮助', kind: 'secondary', action: () => this.showHelpFromPause() }
        ],
        afterRender: () => {
          const slider = $('volumeSlider');
          const mute = $('muteCheck');
          slider.addEventListener('input', () => this.tone.setVolume(slider.value));
          mute.addEventListener('change', () => this.tone.setMuted(mute.checked));
        }
      });
    }

    resume() {
      this.mode = 'playing';
      this.setBlur(false);
      this.hideModal();
      this.lastNow = performance.now();
    }

    showHelpFromPause() {
      this.showModal({
        title: '帮助',
        html: `<p>正式训练中，池塘内会刷出红鲤鱼与干扰鲤鱼。只点击没有投食过的红鲤鱼；每条红鲤鱼只需要投食一次。</p><p>投食机每次点击后进入冷却。冷却期间不能继续投食。重复投食红鲤鱼或投给干扰鲤鱼会计入错误；错误次数超过本关可错次数则失败。</p>`,
        buttons: [
          { label: '返回暂停', kind: 'secondary', action: () => this.pause() },
          { label: '继续游戏', kind: 'primary', action: () => this.resume() },
          { label: '重新演示', kind: 'secondary', action: () => this.startTutorial(true) }
        ]
      });
    }

    clonePlain(value) {
      return JSON.parse(JSON.stringify(value));
    }

    makeSnapshot() {
      return {
        levelIndex: this.levelIndex,
        difficultyKey: this.difficultyKey,
        sessionStartIndex: this.sessionStartIndex,
        currentLevel: this.clonePlain(this.currentLevel),
        totalScore: this.totalScore,
        levelScore: this.levelScore,
        trend: this.clonePlain(this.trend),
        fish: this.clonePlain(this.fish),
        obstacles: this.clonePlain(this.obstacles),
        decorations: this.clonePlain(this.decorations),
        projectiles: this.clonePlain(this.projectiles),
        waves: this.clonePlain(this.waves),
        timer: this.timer,
        foodLeft: this.foodLeft,
        foodMax: this.foodMax,
        errors: this.errors,
        cooldown: this.cooldown,
        startFx: this.startFx,
        pendingEnd: null
      };
    }

    replayTutorialPreservingSnapshot() {
      const snap = this.pausedSnapshot ? this.clonePlain(this.pausedSnapshot) : null;
      this.startTutorial(false);
      this.pausedSnapshot = snap;
    }

    restoreSnapshot() {
      const snap = this.pausedSnapshot;
      if (!snap) {
        this.startTraining();
        return;
      }
      this.hideModal();
      this.setBlur(false);
      this.levelIndex = snap.levelIndex;
      this.difficultyKey = snap.difficultyKey || this.difficultyKey || DEFAULT_DIFFICULTY_KEY;
      this.sessionStartIndex = Number.isFinite(snap.sessionStartIndex) ? snap.sessionStartIndex : this.getDifficultyStartIndex(this.difficultyKey);
      this.currentLevel = LEVELS[snap.levelIndex] || snap.currentLevel;
      this.totalScore = snap.totalScore;
      this.levelScore = snap.levelScore;
      this.trend = this.clonePlain(snap.trend);
      this.fish = this.clonePlain(snap.fish);
      this.obstacles = this.clonePlain(snap.obstacles);
      this.decorations = this.clonePlain(snap.decorations);
      this.projectiles = this.clonePlain(snap.projectiles);
      this.waves = this.clonePlain(snap.waves);
      this.timer = snap.timer;
      this.foodLeft = snap.foodLeft;
      this.foodMax = snap.foodMax;
      this.errors = snap.errors;
      this.cooldown = snap.cooldown;
      this.startFx = snap.startFx;
      this.pendingEnd = null;
      this.prompt.classList.add('hidden');
      this.mode = 'playing';
      this.pausedSnapshot = null;
      this.lastNow = performance.now();
      this.updateHUD();
    }

    setBlur(flag) {
      $('pondCanvas').classList.toggle('blurred', flag);
      $('topbar').classList.toggle('blurred', flag);
      $('feederbar').classList.toggle('blurred', flag);
      if (flag) this.setStartFxBlur(false);
    }

    setStartFxBlur(flag) {
      $('pondCanvas').classList.toggle('startFxBlur', Boolean(flag));
    }

    updateHUD() {
      const level = this.currentLevel;
      if (level && this.mode !== 'welcome' && this.mode !== 'boot') {
        const lvl = level.Level ? `${level.Level}/${TOTAL_LEVELS}` : '引导';
        this.levelText.textContent = lvl;
        this.timeText.textContent = level.Time ? `${Math.max(0, this.timer).toFixed(1)}s` : '--';
        this.foodText.textContent = `${this.foodLeft}/${this.foodMax}`;
        this.faultText.textContent = level.Fault !== undefined ? `${this.errors}/${this.getFaultLimit()}` : '--';
      } else {
        this.levelText.textContent = `--/${TOTAL_LEVELS}`;
        this.timeText.textContent = '--.-s';
        this.foodText.textContent = '0/0';
        this.faultText.textContent = '0/0';
      }
      this.scoreText.textContent = String(this.levelScore || 0);
      this.totalScoreText.textContent = String(this.totalScore || 0);
      const maxCd = Number(this.currentLevel?.SpaceTime || 1);
      const pct = this.cooldown > 0 ? clamp(this.cooldown / maxCd, 0, 1) : 0;
      this.cooldownFill.style.width = `${pct * 100}%`;
      this.cooldownText.textContent = this.cooldown > 0 ? `${this.cooldown.toFixed(1)}s` : '就绪';
    }

    buildTrendSvg() {
      const data = this.trend.slice(-10);
      if (!data.length) return '<p class="minor">暂无训练趋势。</p>';
      const w = 660;
      const h = 184;
      const pad = { left: 48, right: 24, top: 28, bottom: 38 };
      const chartW = w - pad.left - pad.right;
      const chartH = h - pad.top - pad.bottom;
      const maxValue = Math.max(10, ...data);
      const yMax = Math.ceil(maxValue * 1.16 / 10) * 10;
      const rawTicks = [0, yMax / 3, yMax * 2 / 3, yMax].map(v => Math.round(v / 5) * 5);
      const yTicks = [...new Set(rawTicks)].sort((a, b) => a - b);
      const xFor = (i) => data.length === 1 ? pad.left + chartW / 2 : pad.left + i * (chartW / (data.length - 1));
      const yFor = (v) => pad.top + chartH - (v / yMax) * chartH;
      const coords = data.map((v, i) => ({ v, x: xFor(i), y: yFor(v) }));
      const startLevelNo = Math.max(1, this.sessionStartIndex + this.trend.length - data.length + 1);
      const linePath = coords.length === 1
        ? `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`
        : coords.map((p, i) => {
            if (i === 0) return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
            const prev = coords[i - 1];
            const dx = p.x - prev.x;
            return `C ${(prev.x + dx * 0.45).toFixed(1)} ${prev.y.toFixed(1)} ${(p.x - dx * 0.45).toFixed(1)} ${p.y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
          }).join(' ');
      const areaPath = coords.length > 1
        ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(pad.top + chartH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(pad.top + chartH).toFixed(1)} Z`
        : '';
      const grid = yTicks.map(t => {
        const y = yFor(t);
        return `<line class="trendGrid" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${w - pad.right}" y2="${y.toFixed(1)}"></line><text class="trendLabel" x="${pad.left - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end">${t}</text>`;
      }).join('');
      const dots = coords.map((p, i) => {
        const showValue = data.length <= 6 || i === 0 || i === coords.length - 1;
        const label = showValue ? `<text class="trendPointLabel" x="${p.x.toFixed(1)}" y="${Math.max(14, p.y - 12).toFixed(1)}" text-anchor="middle">${p.v}</text>` : '';
        return `${label}<circle class="trendDotHalo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10"></circle><circle class="trendDot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5"></circle>`;
      }).join('');
      const xLabels = coords.map((p, i) => {
        if (data.length > 7 && i % 2 === 1 && i !== data.length - 1) return '';
        const levelNo = startLevelNo + i;
        const label = data.length <= 5 ? `第${levelNo}关` : String(levelNo);
        return `<text class="trendValue" x="${p.x.toFixed(1)}" y="${h - 10}" text-anchor="middle">${label}</text>`;
      }).join('');
      const area = areaPath ? `<path class="trendArea" d="${areaPath}"></path>` : '';
      return `<svg class="trendSvg" viewBox="0 0 ${w} ${h}" width="100%" height="176" role="img" aria-label="训练得分趋势"><defs><linearGradient id="trendFill" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + chartH}" gradientUnits="userSpaceOnUse"><stop stop-color="#25b8ad" stop-opacity="0.24"></stop><stop offset="1" stop-color="#25b8ad" stop-opacity="0"></stop></linearGradient></defs>${grid}<line class="trendAxis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartH}"></line><line class="trendAxis" x1="${pad.left}" y1="${pad.top + chartH}" x2="${w - pad.right}" y2="${pad.top + chartH}"></line>${area}<path class="trendLine" d="${linePath}"></path>${dots}${xLabels}</svg>`;
    }

    getCanvasPoint(evt) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (evt.clientX - rect.left) * this.canvas.width / rect.width,
        y: (evt.clientY - rect.top) * this.canvas.height / rect.height
      };
    }

    toast(text) {
      this.toastBox.textContent = text;
      this.toastBox.classList.remove('hidden');
      this.toastTimer = 1.3;
    }

    inferButtonIcon(label) {
      if (/帮助/.test(label)) return 'help';
      if (/重新|重试/.test(label)) return 'restart';
      if (/返回|放弃|欢迎/.test(label)) return 'home';
      if (/继续|进入|训练|容易|普通|困难/.test(label)) return 'play';
      return '';
    }


    showModal({ title, html, buttons = [], anyClick = null, afterRender = null, variant = '' }) {
      this.modalCard.className = `modalCard${variant ? ' ' + variant : ''}`;
      this.modalCard.innerHTML = '';
      if (title) {
        const h = document.createElement('h2');
        h.textContent = title;
        this.modalCard.appendChild(h);
      }
      const body = document.createElement('div');
      body.innerHTML = html || '';
      this.modalCard.appendChild(body);
      if (buttons.length) {
        const actions = document.createElement('div');
        actions.className = variant === 'resultModal' ? 'modalActions resultActions' : 'modalActions';
        for (const b of buttons) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = b.label;
          btn.className = b.kind === 'primary' ? 'primaryBtn' : (b.kind === 'danger' ? 'dangerBtn' : 'secondaryBtn');
          const inferredIcon = b.icon || this.inferButtonIcon(b.label);
          if (inferredIcon) {
            btn.dataset.icon = inferredIcon;
            btn.classList.add('withBtnIcon');
          }
          btn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.tone.ensure();
            this.tone.startAmbient();
            this.tone.play('ui');
            b.action();
          });
          actions.appendChild(btn);
        }
        let actionHost = this.modalCard;
        if (variant === 'resultModal' && typeof body.querySelector === 'function') {
          actionHost = body.querySelector('.resultPanel') || this.modalCard;
        }
        actionHost.appendChild(actions);
      }
      this.modal.classList.add('visible');
      this.modal.onclick = null;
      if (anyClick) {
        const clickThrough = () => {
          this.tone.ensure();
          this.tone.startAmbient();
          this.tone.play('ui');
          anyClick();
        };
        this.modal.onclick = () => clickThrough();
        this.modalCard.onclick = (evt) => {
          evt.stopPropagation();
          clickThrough();
        };
      } else {
        this.modalCard.onclick = (evt) => evt.stopPropagation();
      }
      if (afterRender) afterRender();
    }

    hideModal() {
      this.modal.classList.remove('visible');
      this.modal.onclick = null;
      this.modalCard.onclick = null;
    }

    render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      this.drawBackdrop(ctx);
      this.drawPond(ctx);
      this.drawWaves(ctx, (w) => (w.kind || 'ambient') === 'ambient');
      this.drawDecorations(ctx, 'under');
      this.drawFishLayer(ctx);
      this.drawProjectiles(ctx);
      this.drawWaves(ctx, (w) => (w.kind || (w.strong ? 'success' : 'fail')) !== 'ambient');
      this.drawDecorations(ctx, 'over');
      this.drawPondFrame(ctx);
      this.drawFeeder(ctx);
      this.drawStartFx(ctx);
      this.drawTutorialGuide(ctx);
    }

    drawBackdrop(ctx) {
      if (this.imageReady('stageBackdrop')) {
        ctx.drawImage(this.images.stageBackdrop, 0, 0, CANVAS_W, CANVAS_H);
        ctx.fillStyle = 'rgba(12, 55, 57, 0.18)';
        ctx.fillRect(0, POND.y + POND.h + 18, CANVAS_W, CANVAS_H - POND.y - POND.h);
        return;
      }
      const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
      g.addColorStop(0, '#c2ead8');
      g.addColorStop(0.58, '#77b4ad');
      g.addColorStop(1, '#245461');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = 'rgba(12, 55, 57, 0.28)';
      ctx.fillRect(0, POND.y + POND.h + 18, CANVAS_W, CANVAS_H - POND.y - POND.h);
    }

    drawPond(ctx) {
      ctx.save();
      this.roundedRect(ctx, POND.x, POND.y, POND.w, POND.h, 42);
      ctx.clip();
      if (this.imageReady('pondWater')) {
        ctx.drawImage(this.images.pondWater, POND.x, POND.y, POND.w, POND.h);
      } else {
        const water = ctx.createRadialGradient(POND.x + POND.w * 0.45, POND.y + POND.h * 0.4, 20, POND.x + POND.w * 0.5, POND.y + POND.h * 0.52, POND.w * 0.7);
        water.addColorStop(0, '#72c3c4');
        water.addColorStop(0.55, '#459aa5');
        water.addColorStop(1, '#276b79');
        ctx.fillStyle = water;
        ctx.fillRect(POND.x, POND.y, POND.w, POND.h);
      }

      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = '#d9fff3';
      ctx.lineWidth = 1;
      for (let i = 0; i < 20; i++) {
        const y = POND.y + 20 + i * 21;
        ctx.beginPath();
        for (let x = POND.x - 20; x <= POND.x + POND.w + 20; x += 18) {
          const yy = y + Math.sin((x + performance.now() * 0.018) * 0.03 + i) * 3;
          if (x === POND.x - 20) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.restore();
    }

    drawWaves(ctx, predicate = null) {
      ctx.save();
      this.roundedRect(ctx, POND.x, POND.y, POND.w, POND.h, 42);
      ctx.clip();
      for (const w of this.waves) {
        if (!predicate || predicate(w)) this.drawWave(ctx, w);
      }
      ctx.restore();
    }

    drawPondFrame(ctx) {
      if (this.imageReady('pondFrame')) {
        ctx.save();
        ctx.drawImage(this.images.pondFrame, 0, 0, CANVAS_W, CANVAS_H);
        ctx.restore();
      } else {
        this.drawRocks(ctx);
      }
    }

    drawRocks(ctx) {
      const stones = [];
      for (let x = POND.x + 10; x < POND.x + POND.w; x += 30) {
        stones.push([x, POND.y - 6, 14 + Math.sin(x) * 2]);
        stones.push([x + 8, POND.y + POND.h + 6, 13 + Math.cos(x) * 2]);
      }
      for (let y = POND.y + 16; y < POND.y + POND.h; y += 28) {
        stones.push([POND.x - 6, y, 13 + Math.sin(y) * 2]);
        stones.push([POND.x + POND.w + 6, y + 4, 14 + Math.cos(y) * 2]);
      }
      ctx.save();
      for (const [x, y, r] of stones) {
        const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 2, x, y, r);
        g.addColorStop(0, '#d8d0bd');
        g.addColorStop(1, '#8b8878');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.1, r * 0.78, Math.sin(x * 0.071 + y * 0.037) * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    drawFishLayer(ctx) {
      ctx.save();
      this.roundedRect(ctx, POND.x, POND.y, POND.w, POND.h, 42);
      ctx.clip();
      for (const f of this.fish) this.drawFish(ctx, f);
      ctx.restore();
    }

    drawFish(ctx, f) {
      const jumpLift = f.jump > 0 ? Math.sin((f.jump / 0.62) * Math.PI) * 10 : 0;
      const failSpin = f.fail > 0 ? Math.sin(f.fail * 24) * 0.55 : 0;
      const pulse = f.fail > 0 ? 1 + Math.sin(f.fail * 36) * 0.06 : 1;
      ctx.save();
      ctx.translate(f.x, f.y - jumpLift);
      ctx.rotate(f.angle + failSpin);
      ctx.scale(pulse * (f.scale || 1), pulse * (f.scale || 1));

      const isRed = f.type === 'red';
      const sheetKey = isRed ? 'redKoiSheet' : (this.imageReady('blackGreenKoiSheet') ? 'blackGreenKoiSheet' : 'greenKoiSheet');
      if (this.imageReady(sheetKey)) {
        const sheet = this.images[sheetKey];
        const frames = 8;
        const fw = sheet.naturalWidth / frames;
        const fh = sheet.naturalHeight;
        const frame = Math.floor(f.tail * 1.35) % frames;
        const dw = BASE_FISH_DRAW.w;
        const dh = BASE_FISH_DRAW.h;
        ctx.drawImage(sheet, frame * fw, 0, fw, fh, -dw / 2, -dh / 2, dw, dh);
        if (f.fed) {
          ctx.globalAlpha = 0.42;
          ctx.fillStyle = '#fff3a8';
          ctx.beginPath();
          ctx.arc(0, 0, 31, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (f.pending) {
          ctx.strokeStyle = '#fff4a0';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, 36, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      const body = ctx.createLinearGradient(-30, -18, 30, 18);
      if (isRed) {
        body.addColorStop(0, '#ff9a76');
        body.addColorStop(0.55, '#cf382b');
        body.addColorStop(1, '#8e1f1f');
      } else {
        body.addColorStop(0, '#294944');
        body.addColorStop(0.58, '#0d2a2c');
        body.addColorStop(1, '#081819');
      }

      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.ellipse(0, 0, 30, 17, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = isRed ? '#f15f3f' : '#183a38';
      const tailWag = Math.sin(f.tail) * 0.22;
      ctx.beginPath();
      ctx.moveTo(-26, 0);
      ctx.lineTo(-46, -16 + tailWag * 10);
      ctx.lineTo(-42, 0);
      ctx.lineTo(-46, 16 + tailWag * 10);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = isRed ? 'rgba(255, 224, 153, 0.78)' : 'rgba(117, 163, 140, 0.56)';
      ctx.beginPath();
      ctx.ellipse(4, -18, 11, 5, -0.8, 0, Math.PI * 2);
      ctx.ellipse(3, 18, 11, 5, 0.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1.2;
      for (let i = -10; i <= 16; i += 8) {
        ctx.beginPath();
        ctx.arc(i, 0, 13, -0.9, 0.9);
        ctx.stroke();
      }

      ctx.fillStyle = '#fffdf0';
      ctx.beginPath();
      ctx.arc(22, -5, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#172020';
      ctx.beginPath();
      ctx.arc(23, -5, 1.5, 0, Math.PI * 2);
      ctx.fill();

      if (f.pending) {
        ctx.strokeStyle = '#fff4a0';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 36, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawProjectiles(ctx) {
      ctx.save();
      for (const p of this.projectiles) {
        const target = this.fish.find(item => item.id === p.fishId);
        const tx = target ? target.x : p.tx;
        const ty = target ? target.y : p.ty;
        const t = clamp(p.elapsed / p.duration, 0, 1);
        const ease = 1 - Math.pow(1 - t, 2);
        const x = p.sx + (tx - p.sx) * ease;
        const y = p.sy + (ty - p.sy) * ease;
        ctx.strokeStyle = 'rgba(255, 238, 140, 0.42)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.sx, p.sy);
        ctx.lineTo(x, y);
        ctx.stroke();
        if (this.imageReady('foodPellet')) {
          ctx.drawImage(this.images.foodPellet, x - 12, y - 12, 24, 24);
        } else {
          ctx.fillStyle = '#ffe27a';
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    drawDecorations(ctx, layer = 'all') {
      ctx.save();
      this.roundedRect(ctx, POND.x, POND.y, POND.w, POND.h, 42);
      ctx.clip();
      for (const d of this.decorations) {
        if (layer === 'under' && d.blocking) continue;
        if (layer === 'over' && !d.blocking) continue;
        this.drawDecoration(ctx, d);
      }
      ctx.restore();
    }

    drawDecoration(ctx, d) {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot || 0);
      ctx.globalAlpha = d.blocking ? 0.62 : (d.alpha || 0.42);
      const decoKeys = ['lotusLeaf', 'algae', 'reeds', 'lotusBloom', 'shadowGrass', 'stoneMoss'];
      const type = d.type % decoKeys.length;
      const decoKey = decoKeys[type];
      if (this.imageReady(decoKey)) {
        const img = this.images[decoKey];
        const dw = Math.max(58, d.rx * 3.0);
        const dh = Math.max(52, d.ry * 3.0);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        if (d.blocking) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(0, 0, d.rx + 3, d.ry + 3, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      if (type === 0) {
        ctx.fillStyle = '#3d8d62';
        ctx.beginPath();
        ctx.ellipse(0, 0, d.rx, d.ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.35)';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(d.rx * 0.75, -d.ry * 0.45);
        ctx.stroke();
      } else if (type === 1) {
        ctx.fillStyle = '#77a85d';
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.ellipse(i * 14, 0, 16, 6, i * 0.28, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (type === 2) {
        ctx.strokeStyle = '#5d8f50';
        ctx.lineWidth = 5;
        for (let i = -3; i <= 3; i++) {
          ctx.beginPath();
          ctx.moveTo(i * 9, d.ry);
          ctx.quadraticCurveTo(i * 7 + 6, 0, i * 8 + Math.sin(i) * 16, -d.ry);
          ctx.stroke();
        }
      } else if (type === 3) {
        ctx.fillStyle = '#f3c5db';
        for (let i = 0; i < 7; i++) {
          ctx.save();
          ctx.rotate(i * Math.PI * 2 / 7);
          ctx.beginPath();
          ctx.ellipse(0, -10, 8, 18, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.fillStyle = '#e9c948';
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#a6b779';
        ctx.beginPath();
        ctx.ellipse(0, 0, d.rx * 0.8, d.ry * 0.68, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(250,255,230,.35)';
        ctx.fillRect(-d.rx * 0.34, -2, d.rx * 0.7, 4);
      }
      if (d.blocking) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, d.rx + 3, d.ry + 3, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawWave(ctx, w) {
      const progress = clamp(1 - w.life / w.maxLife, 0, 1);
      const kind = w.kind || (w.strong ? 'success' : 'fail');
      const isAmbient = kind === 'ambient';
      const rippleKey = kind === 'fail' ? 'rippleFail' : 'rippleSuccess';
      const splashKey = kind === 'fail' ? 'splashFail' : 'splashSuccess';
      ctx.save();
      if (this.imageReady(rippleKey) || (!isAmbient && this.imageReady(splashKey))) {
        const frame = Math.min(7, Math.floor(progress * 8));
        const alpha = Math.max(0, (w.alpha ?? (isAmbient ? 0.36 : 1)) * (1 - progress * 0.88));
        if (this.imageReady(rippleKey)) {
          ctx.globalAlpha = alpha * (isAmbient ? 0.72 : 0.82);
          const size = (isAmbient ? 96 : 132) + progress * (isAmbient ? 118 : 88);
          this.drawSheetFrame(ctx, rippleKey, frame, 8, w.x, w.y, size, size);
        }
        if (!isAmbient && this.imageReady(splashKey)) {
          ctx.globalAlpha = alpha * (kind === 'success' ? 0.72 : 0.88);
          this.drawSheetFrame(ctx, splashKey, frame, 8, w.x, w.y, 116, 116);
        }
        ctx.restore();
        return;
      }
      ctx.globalAlpha = Math.max(0, (isAmbient ? 0.34 : 0.75) - progress * (isAmbient ? 0.34 : 0.75));
      ctx.strokeStyle = w.strong ? '#fff7b7' : '#d7f5ff';
      ctx.lineWidth = w.strong ? 3 : 2;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r + progress * (isAmbient ? 62 : 46), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha *= 0.65;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r + progress * (isAmbient ? 38 : 28), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawSheetFrame(ctx, key, frame, frames, x, y, dw, dh) {
      const img = this.images[key];
      const fw = img.naturalWidth / frames;
      const fh = img.naturalHeight;
      ctx.drawImage(img, frame * fw, 0, fw, fh, x - dw / 2, y - dh / 2, dw, dh);
    }

    drawFeeder(ctx) {
      ctx.save();
      if (this.imageReady('feeder')) {
        ctx.drawImage(this.images.feeder, FEEDER.x - 91, FEEDER.y - 82, 182, 128);
        ctx.fillStyle = '#fff7d3';
        ctx.font = '700 18px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${this.foodLeft}/${this.foodMax}`, FEEDER.x, FEEDER.y - 2);
        ctx.restore();
        return;
      }
      ctx.fillStyle = 'rgba(29, 47, 45, 0.42)';
      ctx.beginPath();
      ctx.ellipse(FEEDER.x, FEEDER.y + 14, 92, 19, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(FEEDER.x - 60, FEEDER.y - 28, FEEDER.x + 60, FEEDER.y + 24);
      g.addColorStop(0, '#fff1b5');
      g.addColorStop(0.55, '#d3943c');
      g.addColorStop(1, '#8d5521');
      ctx.fillStyle = g;
      this.roundedRect(ctx, FEEDER.x - 74, FEEDER.y - 42, 148, 64, 18);
      ctx.fill();
      ctx.fillStyle = '#5b3515';
      ctx.fillRect(FEEDER.x - 12, FEEDER.y - 68, 24, 40);
      ctx.beginPath();
      ctx.arc(FEEDER.x, FEEDER.y - 68, 20, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#fff7d3';
      ctx.font = '700 18px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${this.foodLeft}/${this.foodMax}`, FEEDER.x, FEEDER.y - 2);
      ctx.restore();
    }

    drawStartFx(ctx) {
      if (this.startFx <= 0) return;
      const a = clamp(this.startFx, 0, 1);
      ctx.save();
      this.roundedRect(ctx, POND.x, POND.y, POND.w, POND.h, 42);
      ctx.clip();
      if (this.imageReady('pondWater')) {
        ctx.globalAlpha = a * 0.28;
        ctx.filter = `blur(${(a * 6).toFixed(2)}px)`;
        ctx.drawImage(this.images.pondWater, POND.x - 12, POND.y - 12, POND.w + 24, POND.h + 24);
        ctx.filter = 'none';
      }
      ctx.globalAlpha = a * 0.34;
      ctx.fillStyle = '#d9fff7';
      ctx.fillRect(POND.x, POND.y, POND.w, POND.h);
      ctx.globalAlpha = a * 0.85;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(POND.x + POND.w / 2, POND.y + POND.h / 2, (1 - a) * 430 + i * 28, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawTutorialGuide(ctx) {
      if (this.mode !== 'tutorial') return;
      let target = null;
      if (this.tutorialStep === 1) target = this.fish.find(f => f.id === 1);
      if (this.tutorialStep === 2) target = this.fish.find(f => f.id === 2);
      if (!target) return;
      const pulse = 1 + Math.sin(performance.now() * 0.008) * 0.12;
      ctx.save();
      ctx.strokeStyle = '#fff18a';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(target.x, target.y, Math.max(46, target.radius * 1.7) * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,241,138,.18)';
      ctx.beginPath();
      ctx.arc(target.x, target.y, Math.max(46, target.radius * 1.7) * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    roundedRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }
  }

  const game = new SilentPondGame();
  game.boot();
  globalThis.SilentPondGameInstance = game;
})();

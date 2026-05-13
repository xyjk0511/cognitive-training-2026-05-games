(function () {
  const ACTION_PATTERNS = [
    { re: /^(开始游戏|进入游戏|开始|进入训练|开始训练|准备开始|直接准备开始|直接进入小店|进入车站|进入花园|开始场景演示|开始演示)$/u, text: '开始训练', action: 'start' },
    { re: /^(开始教学|进入教学|跟着.*学习|先看教学|开始 6 屏教学|开始低压教学)$/u, text: '先看教学', action: 'teach' },
    { re: /^(怎么玩|游戏说明|玩法|查看说明|查看详情|说明|再看说明|目标是什么)$/u, text: '玩法说明', action: 'info' },
    { re: /^(直接练习|直接低压练习|先玩低压练习|低压练习|跳到低压练习|开始小练习)$/u, text: '低压练习', action: 'practice' },
    { re: /^(返回首页|进入封面页|回到首页卡片|看封面页|直接看封面|看封面|返回封面|回封面)$/u, text: '回到封面', action: 'cover' },
    { re: /^(低刺激.*|柔和模式.*|开启柔和模式|关闭柔和模式|安静模式.*|大数字.*|大目标.*|大按钮模式.*)$/u, text: null, action: 'setting' },
    { re: /^(按推荐再来|按推荐再玩|按推荐再玩一轮|按推荐训练)$/u, text: '按推荐继续', action: 'start' },
    { re: /^(重新演示|重看路线|再看一遍|播放灯光)$/u, text: '重新演示', action: 'info' }
  ];

  const DEBUG_RE = /(hasAdaptive\s*=|localStorage|__hasAdaptive|adaptive=true|当前推荐难度：.*localStorage|数据已本地保存：localStorage|保存状态：.*localStorage|页面文字和代码均包含自适应难度|本地\s*PNG\s*资产|图像资产|GPTImage|source-collage|本版包含|离线资源|任务编号)/iu;

  const GAME_META = {
    'visual-search': { domain: 'attention', taskFamily: 'visual-search' },
    'reaction-time': { domain: 'attention', taskFamily: 'go-no-go' },
    stroop: { domain: 'attention', taskFamily: 'stroop' },
    'schulte-table': { domain: 'attention', taskFamily: 'schulte-table' },
    'strong-memory': { domain: 'memory', taskFamily: 'corsi-spatial-recall' },
    'card-matching': { domain: 'memory', taskFamily: 'paired-associate' },
    'simon-says': { domain: 'memory', taskFamily: 'serial-recall' },
    'n-back': { domain: 'memory', taskFamily: 'n-back' },
    'logic-puzzles': { domain: 'executive', taskFamily: 'rule-induction' },
    'tower-of-hanoi': { domain: 'executive', taskFamily: 'tower-planning' },
    'trail-making': { domain: 'executive', taskFamily: 'trail-making' },
    'water-jugs': { domain: 'executive', taskFamily: 'water-jug-planning' },
    'mental-rotation': { domain: 'perception', taskFamily: 'mental-rotation' },
    'word-scramble': { domain: 'language', taskFamily: 'anagram' },
    'quick-math': { domain: 'language', taskFamily: 'mental-arithmetic' },
    'number-sequence': { domain: 'language', taskFamily: 'number-series' },
    maze: { domain: 'executive', taskFamily: 'route-memory' },
    'global-local': { domain: 'perception', taskFamily: 'global-local' },
    'visual-discrimination': { domain: 'perception', taskFamily: 'visual-discrimination' },
    'category-fluency': { domain: 'language', taskFamily: 'semantic-categorization' },
    'emotion-match': { domain: 'social-cognition', taskFamily: 'emotion-recognition' },
    'gaze-follow': { domain: 'social-cognition', taskFamily: 'gaze-cueing' },
    'social-scenario': { domain: 'social-cognition', taskFamily: 'social-inference' }
  };

  const REQUIRED_SESSION_FIELDS = [
    'gameId',
    'domain',
    'taskFamily',
    'mode',
    'level',
    'startedAt',
    'completedAt',
    'summary',
    'trials',
    'events',
    'adaptive'
  ];

  function appHomeHref() {
    const marker = '/playable-games/';
    const path = window.location.pathname;
    const idx = path.indexOf(marker);
    const base = idx >= 0 ? path.slice(0, idx + 1) : '/';
    return `${window.location.origin}${base}`;
  }

  function detectGameId() {
    const marker = '/playable-games/';
    const path = window.location.pathname;
    const idx = path.indexOf(marker);
    if (idx < 0) return '';
    return path.slice(idx + marker.length).split('/')[0] || '';
  }

  function safeParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  function isoOrNow(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeAdaptive(raw, level) {
    if (Array.isArray(raw)) {
      const last = raw[raw.length - 1] || {};
      return {
        previousLevel: level ?? null,
        recommendedLevel: last.nextLevel ?? last.level ?? null,
        reason: last.reason || last.rule || 'legacy adaptive event list',
        rules: raw
      };
    }

    const adaptive = raw && typeof raw === 'object' ? raw : {};
    return {
      ...adaptive,
      previousLevel: adaptive.previousLevel ?? adaptive.currentLevel ?? level ?? null,
      recommendedLevel: adaptive.recommendedLevel ?? adaptive.nextLevel ?? adaptive.level ?? null,
      reason: adaptive.reason ?? adaptive.rule ?? adaptive.adjustment ?? '',
      rules: Array.isArray(adaptive.rules)
        ? adaptive.rules
        : (adaptive.rule ? [adaptive.rule] : [])
    };
  }

  function normalizeSession(gameId, session) {
    const input = session && typeof session === 'object' ? session : {};
    const meta = GAME_META[gameId] || {};
    const level = input.level ?? input.summary?.level ?? null;

    return {
      ...input,
      gameId,
      domain: input.domain || meta.domain || 'unknown',
      taskFamily: input.taskFamily || meta.taskFamily || gameId,
      mode: input.mode || 'training',
      level,
      startedAt: isoOrNow(input.startedAt || input.startTime || input.started),
      completedAt: isoOrNow(input.completedAt || input.endedAt),
      summary: input.summary && typeof input.summary === 'object' ? input.summary : {},
      trials: asArray(input.trials),
      events: asArray(input.events),
      adaptive: normalizeAdaptive(input.adaptive, level)
    };
  }

  function validateSession(session) {
    const missing = REQUIRED_SESSION_FIELDS.filter((field) => {
      if (!(field in session)) return true;
      if (field === 'summary') return !session.summary || typeof session.summary !== 'object';
      if (field === 'adaptive') return !session.adaptive || typeof session.adaptive !== 'object';
      if (field === 'trials' || field === 'events') return !Array.isArray(session[field]);
      return session[field] === undefined || session[field] === null || session[field] === '';
    });

    return { valid: missing.length === 0, missing };
  }

  function installSessionRecorder() {
    if (window.CognitiveGameRecorder) return;
    const storageKey = 'cognitive-training-session-records-v1';

    function readAll() {
      return safeParse(localStorage.getItem(storageKey) || '[]', []);
    }

    function record(gameId, session) {
      const normalized = normalizeSession(gameId, session);
      const validation = validateSession(normalized);
      const saved = {
        id: `${gameId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        savedAt: new Date().toISOString(),
        schemaVersion: 1,
        validation,
        ...normalized
      };
      const recent = readAll();
      recent.push(saved);
      localStorage.setItem(storageKey, JSON.stringify(recent.slice(-80)));

      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'cognitive-game-session', payload: saved }, '*');
      }

      return saved;
    }

    window.CognitiveGameRecorder = {
      storageKey,
      record,
      readAll,
      normalizeSession,
      validateSession,
      requiredFields: REQUIRED_SESSION_FIELDS
    };
  }

  function addHomeLink() {
    if (document.querySelector('.unified-home-link')) return;
    const link = document.createElement('a');
    link.className = 'unified-home-link';
    link.href = appHomeHref();
    link.textContent = '全部游戏';
    link.setAttribute('aria-label', '返回全部游戏');
    document.body.appendChild(link);
  }

  function ownText(element) {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function setButtonText(button, text) {
    if (!text) return;
    if (button.children.length === 0) {
      if (button.textContent === text) return;
      button.textContent = text;
      return;
    }

    const textNodes = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if ((node.textContent || '').trim()) textNodes.push(node);
      node = walker.nextNode();
    }

    if (textNodes.length === 1) {
      if (textNodes[0].textContent === text) return;
      textNodes[0].textContent = text;
    } else {
      if (button.getAttribute('aria-label') === text) return;
      button.setAttribute('aria-label', text);
    }
  }

  function normalizeButtons() {
    document.querySelectorAll('button, [role="button"]').forEach((button) => {
      const label = ownText(button);
      if (!label) return;

      const match = ACTION_PATTERNS.find((pattern) => pattern.re.test(label));
      if (!match) return;

      if (match.text) setButtonText(button, match.text);
      if (button.getAttribute('data-unified-action') !== match.action) {
        button.setAttribute('data-unified-action', match.action);
      }
    });
  }

  function hideDebugText() {
    document.querySelectorAll('p, span, small, code, footer, h1, h2, h3, h4, h5, h6, .asset-note, .asset-check, .source-box, .info-panel, .soft-card, .badge').forEach((node) => {
      if (node.children.length > 3) return;
      const text = ownText(node);
      if (!text || text.length > 260) return;
      if (!DEBUG_RE.test(text)) return;

      const target = /本版包含|离线资源/.test(text)
        ? (node.closest('.asset-note, .asset-check, .source-box, .info-panel, .soft-card, .badge') || node)
        : (node.closest('.asset-note, .asset-check, .source-box, .badge') || node);
      target.classList.add('unified-debug-hidden');
    });
  }

  function tidyDocument() {
    installSessionRecorder();
    document.documentElement.classList.add('playable-unified');
    const gameId = detectGameId();
    if (gameId) {
      document.documentElement.dataset.game = gameId;
      document.body.dataset.game = gameId;
    }
    addHomeLink();
    normalizeButtons();
    hideDebugText();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tidyDocument);
  } else {
    tidyDocument();
  }

  const observer = new MutationObserver(() => {
    window.clearTimeout(window.__playableUnifiedTimer);
    window.__playableUnifiedTimer = window.setTimeout(tidyDocument, 40);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();


/* === smooth-polish-v1: 交互反馈工具层 === */
(function () {
  if (window.__CognitiveSmoothPolishInstalled) return;
  window.__CognitiveSmoothPolishInstalled = true;

  function appHomeHref() {
    if (window.CognitiveGameUI && typeof window.CognitiveGameUI.appHomeHref === 'function') {
      return window.CognitiveGameUI.appHomeHref();
    }
    const path = window.location.pathname;
    if (/\/playable-games\/[\w-]+\//.test(path)) return '../index.html';
    return './index.html';
  }

  function ripple(target, event) {
    if (!target || !target.getBoundingClientRect || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const x = event && Number.isFinite(event.clientX) ? event.clientX - rect.left : rect.width / 2;
    const y = event && Number.isFinite(event.clientY) ? event.clientY - rect.top : rect.height / 2;
    const dot = document.createElement('span');
    dot.className = 'cg-ripple';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    target.appendChild(dot);
    window.setTimeout(() => dot.remove(), 560);
  }

  function press(target) {
    if (!target || !target.classList) return;
    target.classList.remove('cg-pressed');
    void target.offsetWidth;
    target.classList.add('cg-pressed');
    window.setTimeout(() => target.classList.remove('cg-pressed'), 220);
  }

  function toast(message, kind) {
    if (!message) return;
    document.querySelectorAll('.cg-toast').forEach((node) => node.remove());
    const node = document.createElement('div');
    node.className = 'cg-toast ' + (kind || '');
    node.textContent = message;
    document.body.appendChild(node);
    window.setTimeout(() => node.remove(), 1200);
  }

  function particlesAt(x, y, options) {
    const opts = options || {};
    const icons = opts.icons || ['✦', '★', '✧', '◆', '●'];
    const count = opts.count || 8;
    for (let i = 0; i < count; i += 1) {
      const p = document.createElement('span');
      p.className = 'cg-particle';
      p.textContent = icons[i % icons.length];
      p.style.left = (x + (Math.random() * 24 - 12)) + 'px';
      p.style.top = (y + (Math.random() * 14 - 7)) + 'px';
      p.style.setProperty('--cg-dx', (Math.random() * 84 - 42).toFixed(0) + 'px');
      p.style.setProperty('--cg-rot', (Math.random() * 90 - 45).toFixed(0) + 'deg');
      document.body.appendChild(p);
      window.setTimeout(() => p.remove(), 760);
    }
  }

  function particlesFromElement(element, options) {
    if (!element || !element.getBoundingClientRect) return;
    const rect = element.getBoundingClientRect();
    particlesAt(rect.left + rect.width / 2, rect.top + rect.height / 2, options);
  }

  function markAnswer(element, correct, message) {
    if (!element || !element.classList) return;
    element.classList.remove('cg-answer-correct', 'cg-answer-wrong');
    element.classList.add(correct ? 'cg-answer-correct' : 'cg-answer-wrong');
    if (correct) particlesFromElement(element);
    if (message) toast(message, correct ? 'good' : 'bad');
    window.setTimeout(() => {
      element.classList.remove('cg-answer-correct', 'cg-answer-wrong');
    }, 900);
  }

  function preloadImages() {
    const urls = new Set();
    document.querySelectorAll('img[src]').forEach((img) => urls.add(img.getAttribute('src')));
    document.querySelectorAll('[style*="url("]').forEach((node) => {
      const style = node.getAttribute('style') || '';
      const matches = style.matchAll(/url\((['"]?)(.*?)\1\)/g);
      for (const match of matches) if (match[2]) urls.add(match[2]);
    });
    urls.forEach((url) => {
      if (!url || url.startsWith('data:')) return;
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    });
  }

  document.addEventListener('click', function (event) {
    const target = event.target && event.target.closest ? event.target.closest('button, [role="button"], .btn, .button, .option, .choice, .tile, .cell, .node, .object-btn, .dg-option, .dg-btn') : null;
    if (!target) return;
    ripple(target, event);
    press(target);
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', preloadImages);
  } else {
    preloadImages();
  }

  window.CognitiveGameUI = Object.assign({}, window.CognitiveGameUI || {}, {
    appHomeHref,
    ripple,
    press,
    toast,
    particlesAt,
    particlesFromElement,
    markAnswer,
    preloadImages
  });
})();

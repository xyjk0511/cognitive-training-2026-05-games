import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ids = [
  'welcomeScreen','menuScreen','gameScreen','modeLabel','welcomeVersion','menuVersion',
  'btnWelcomeStart','btnStartTraining','btnReplayGuide','btnSkipToMenu',
  'trainingSeconds','startLevel','difficultyPicker','selectedDifficultyText','difficultyLabel','levelTimer','sessionTimer',
  'targetCounter','streakCounter','questionText','card','answerRow','btnDifferent','btnSame',
  'floatLayer','progressDots','historyText','pauseBtn','pauseOverlay','btnResume',
  'btnSound','btnMusic','btnHelp','btnCloseHelp','helpOverlay','resultOverlay',
  'resultRibbon','resultInfo','btnContinueLevel','btnRestartTraining','btnResultMenu',
  'btnResultReplayGuide'
];

class MiniClassList {
  constructor(el){ this.el = el; this.set = new Set(String(el.className || '').split(/\s+/).filter(Boolean)); }
  add(...names){ names.forEach(n=>this.set.add(n)); this._sync(); }
  remove(...names){ names.forEach(n=>this.set.delete(n)); this._sync(); }
  contains(name){ return this.set.has(name); }
  toggle(name, force){
    const shouldAdd = force === undefined ? !this.set.has(name) : Boolean(force);
    if (shouldAdd) this.set.add(name); else this.set.delete(name);
    this._sync();
    return shouldAdd;
  }
  _sync(){ this.el.className = [...this.set].join(' '); }
}
class MiniElement {
  constructor(id=''){
    this.id = id;
    this.className = '';
    this.classList = new MiniClassList(this);
    this.style = {};
    this.listeners = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.max = '';
    this.attributes = {};
    this.dataset = {};
    this.offsetWidth = 120;
  }
  set innerHTML(v){ this._innerHTML = String(v); this.children = []; }
  get innerHTML(){ return this._innerHTML; }
  addEventListener(type, fn){ (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(ev){ ev.target ||= this; for (const fn of this.listeners[ev.type] || []) fn(ev); return true; }
  click(){ this.dispatchEvent({type:'click', target:this}); }
  appendChild(node){ node.parentNode = this; this.children.push(node); return node; }
  remove(){ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c=>c!==this); }
  replaceWith(node){ if (!this.parentNode) return; const idx=this.parentNode.children.indexOf(this); if(idx>=0){node.parentNode=this.parentNode; this.parentNode.children[idx]=node;} }
  setAttribute(k,v){ this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); }
  getAttribute(k){ return this.attributes[k]; }
  querySelector(){ return null; }
  querySelectorAll(sel){
    if (sel === '.difficulty-option') return this.children.filter(e=>e.classList.contains('difficulty-option'));
    return [];
  }
}
class MiniDocument {
  constructor(){
    this.elements = new Map();
    this.listeners = {};
    this.title = '';
    for (const id of ids) this.elements.set(id, new MiniElement(id));
    for (const id of ['welcomeScreen','menuScreen','gameScreen']) this.elements.get(id).classList.add('screen');
    this.elements.get('welcomeScreen').classList.add('active');
    this.elements.get('answerRow').classList.add('answer-row','hidden');
    this.elements.get('trainingSeconds').value='10';
    this.elements.get('startLevel').value='1';
    this._setupDifficultyPicker();
  }
  _setupDifficultyPicker(){
    const picker = this.elements.get('difficultyPicker');
    const items = [
      ['easy','容易','1'],
      ['normal','普通','15'],
      ['hard','困难','30']
    ];
    for (const [id,label,level] of items) {
      const btn = new MiniElement(`difficulty-${id}`);
      btn.classList.add('difficulty-option');
      if (id === 'easy') btn.classList.add('active');
      btn.dataset.difficulty = id;
      btn.dataset.startLevel = level;
      btn.textContent = `${label} 从第${level}关开始`;
      btn.setAttribute('aria-pressed', id === 'easy' ? 'true' : 'false');
      picker.appendChild(btn);
    }
  }
  getElementById(id){ return this.elements.get(id) || null; }
  createElement(tag){ return new MiniElement(tag); }
  addEventListener(type, fn){ (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(ev){ for (const fn of this.listeners[ev.type] || []) fn(ev); return true; }
  querySelectorAll(sel){
    if (sel === '.screen') return [...this.elements.values()].filter(e=>e.classList.contains('screen'));
    if (sel === '.guide-hand') return [];
    return [];
  }
}

function createContext({version='child', trainingSeconds=10, startLevel=1, difficulty='', locationSearch='', firstCardMs=1, autoContinueMs=1, accelerated=true}={}) {
  const document = new MiniDocument();
  document.getElementById('trainingSeconds').value = String(trainingSeconds);
  document.getElementById('startLevel').value = String(startLevel);
  let fakeNow = 0;
  const activeIntervals = new Map();
  const activeTimeouts = new Map();
  let intervalSeq = 1;
  let timeoutSeq = 1000;
  const resultPayloads = [];
  const messages = [];
  const events = {};
  const localStore = new Map();
  const win = {
    document,
    location: { search: locationSearch },
    console,
    URLSearchParams,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Date,
    CustomEvent: class CustomEvent { constructor(type, init){ this.type=type; this.detail=init?.detail; } },
    performance: { now: () => fakeNow },
    addEventListener(type, fn){ (events[type] ||= []).push(fn); },
    dispatchEvent(ev){ for (const fn of events[ev.type] || []) fn(ev); return true; },
    postMessage(msg, origin){ messages.push({msg, origin}); },
    parent: null,
    localStorage: { setItem(k,v){ localStore.set(k,v); }, getItem(k){ return localStore.get(k) || null; } },
    Image: class Image { constructor(){ this.decoding=''; this.src=''; } },
    Audio: class Audio { constructor(src){ this.src=src; this.preload=''; this.volume=1; this.loop=false; this.currentTime=0; } play(){ return Promise.resolve(); } pause(){} cloneNode(){ const a=new win.Audio(this.src); a.volume=this.volume; return a; } },
    AudioContext: class AudioContext { constructor(){ this.currentTime=0; this.destination={}; } createOscillator(){ return {type:'', frequency:{value:0}, connect(){return this;}, start(){}, stop(){}}; } createGain(){ return {gain:{setValueAtTime(){}, exponentialRampToValueAtTime(){}}, connect(){return this;}}; } },
    webkitAudioContext: null,
    KX_BOOT_CONFIG: { version, defaultTrainingSeconds: trainingSeconds, defaultStartLevel: startLevel, defaultDifficulty: difficulty || undefined, firstCardMs, autoContinueMs, postMessageTargetOrigin:'*' },
    KX_ASSET_BASE: '../assets',
    KX_onTrainingEnd(payload){ resultPayloads.push(payload); }
  };
  win.window = win;
  win.parent = win;
  win.setTimeout = (fn, delay=0) => {
    const id = timeoutSeq++;
    const real = setTimeout(() => { activeTimeouts.delete(id); fakeNow += accelerated ? 20 : delay; fn(); }, accelerated ? Math.min(Math.max(delay,0), 3) : delay);
    activeTimeouts.set(id, real);
    return id;
  };
  win.clearTimeout = (id) => { const real = activeTimeouts.get(id); if (real) clearTimeout(real); activeTimeouts.delete(id); };
  win.setInterval = (fn, delay=100) => {
    const id = intervalSeq++;
    const real = setInterval(() => { fakeNow += accelerated ? 1000 : delay; fn(); }, accelerated ? 12 : delay);
    activeIntervals.set(id, real);
    return id;
  };
  win.clearInterval = (id) => { const real=activeIntervals.get(id); if (real) clearInterval(real); activeIntervals.delete(id); };

  const context = { window: win, document, console, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval, performance: win.performance, URLSearchParams, CustomEvent: win.CustomEvent, Image: win.Image, Audio: win.Audio, AudioContext: win.AudioContext, webkitAudioContext: null };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(`${ROOT}/shared/data.js`,'utf8'), context, {filename:'data.js'});
  vm.runInContext(fs.readFileSync(`${ROOT}/shared/game.js`,'utf8'), context, {filename:'game.js'});
  document.dispatchEvent({type:'DOMContentLoaded'});
  return {context, window:win, document, payloads: resultPayloads, messages, localStore, cleanup(){ for (const id of [...activeIntervals.keys()]) win.clearInterval(id); for (const id of [...activeTimeouts.keys()]) win.clearTimeout(id); }};
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function waitFor(cond, timeout=2000, label='condition'){
  const start=Date.now();
  while(Date.now()-start<timeout){ if (cond()) return true; await sleep(2); }
  throw new Error('timeout waiting for '+label);
}
function assert(cond, msg){ if (!cond) throw new Error(msg); }

function difficultySelectionScenario() {
  const sim = createContext({version:'child'});
  const {window:w, document:d} = sim;
  const presets = w.KX_DEBUG.getDifficultyPresets();
  assert(JSON.stringify(presets.map(p=>p.label)) === JSON.stringify(['容易','普通','困难']), 'difficulty labels mismatch');
  assert(JSON.stringify(presets.map(p=>p.startLevel)) === JSON.stringify([1,15,30]), 'difficulty starts mismatch');
  const buttons = d.getElementById('difficultyPicker').querySelectorAll('.difficulty-option');
  buttons[1].click();
  assert(d.getElementById('startLevel').value === '15', 'normal should set startLevel 15');
  assert(w.KX_DEBUG.getSelectedDifficultyPreset().id === 'normal', 'normal selected id mismatch');
  buttons[2].click();
  assert(d.getElementById('startLevel').value === '30', 'hard should set startLevel 30');
  assert(w.KX_DEBUG.getSelectedDifficultyPreset().id === 'hard', 'hard selected id mismatch');
  buttons[0].click();
  assert(d.getElementById('startLevel').value === '1', 'easy should set startLevel 1');
  sim.cleanup();
  return {presets, finalStartLevel: d.getElementById('startLevel').value};
}

async function startLevelScenario(difficulty, expectedLevel, options = {}) {
  const sim = createContext({version:'child', trainingSeconds:10, difficulty, locationSearch: options.locationSearch || '', firstCardMs:1, autoContinueMs:1, accelerated:true});
  const {window:w, document:d} = sim;
  const labelName = options.label || difficulty || 'query';
  d.getElementById('btnStartTraining').click();
  await waitFor(()=>w.KX_DEBUG.getState().levelActive, 1000, `level active ${labelName}`);
  const st = w.KX_DEBUG.getState();
  assert(st.currentLevel === expectedLevel, `${labelName} should start at ${expectedLevel}, got ${st.currentLevel}`);
  assert(st.levelCfg.Level === expectedLevel, `${labelName} cfg level mismatch`);
  assert(d.getElementById('difficultyLabel').textContent.includes(String(expectedLevel)), 'difficulty label should include level');
  sim.cleanup();
  return {difficulty: labelName, expectedLevel, currentLevel: st.currentLevel, label: d.getElementById('difficultyLabel').textContent};
}

async function guideScenario() {
  const sim = createContext({version:'child', trainingSeconds:10, firstCardMs:1, autoContinueMs:1, accelerated:true});
  const {window:w, document:d} = sim;
  d.getElementById('btnWelcomeStart').click();
  await waitFor(()=>w.KX_DEBUG.getState().screen==='guide' && w.KX_DEBUG.getState().guideStep===1, 1000, 'guide step1');
  d.getElementById('btnSame').click();
  d.getElementById('btnDifferent').click();
  assert(w.KX_DEBUG.getGuideAnswerLocked() === true, 'guide answer should lock during transition');
  await waitFor(()=>w.KX_DEBUG.getState().guideStep===2 && w.KX_DEBUG.getState().guideExpectedSame===false, 1000, 'guide step2 rendered');
  d.getElementById('btnDifferent').click();
  await waitFor(()=>d.getElementById('resultOverlay').classList.contains('active'), 1000, 'guide finish overlay');
  const st = w.KX_DEBUG.getState();
  const result = {screen:st.screen, guideStep:st.guideStep, overlayActive:d.getElementById('resultOverlay').classList.contains('active'), ribbon:d.getElementById('resultRibbon').textContent};
  sim.cleanup();
  return result;
}

async function playCorrectScenario() {
  const sim = createContext({version:'child', trainingSeconds:10, difficulty:'easy', firstCardMs:1, autoContinueMs:1, accelerated:true});
  const {window:w, document:d} = sim;
  d.getElementById('btnStartTraining').click();
  const start = Date.now();
  let clicks = 0;
  while (Date.now()-start < 3000) {
    const st = w.KX_DEBUG.getState();
    if (!st.trainingActive && sim.payloads.length) break;
    if (st.levelActive && st.canAnswer && !st.paused) {
      (st.expectedSame ? d.getElementById('btnSame') : d.getElementById('btnDifferent')).click();
      clicks++;
    }
    await sleep(1);
  }
  await waitFor(()=>sim.payloads.length>=1, 2000, 'correct scenario payload');
  const payload = sim.payloads[0];
  assert(payload.completed === true, 'correct scenario should complete by time=0');
  assert(payload.passFlag === 1, 'correct scenario should pass at least one level');
  assert(payload.difficultyId === 'easy' && payload.difficultyStartLevel === 1, 'payload difficulty mismatch');
  assert(sim.localStore.get('KX_LAST_TRAINING_RESULT'), 'localStorage result missing');
  const result = {clicks, totalScore:payload.totalScore, passFlag:payload.passFlag, completed:payload.completed, difficultyId:payload.difficultyId, difficultyStartLevel:payload.difficultyStartLevel, history:payload.history};
  sim.cleanup();
  return result;
}

async function playForcedFailScenario() {
  const sim = createContext({version:'adult', trainingSeconds:10, difficulty:'normal', firstCardMs:1, autoContinueMs:50, accelerated:true});
  const {window:w, document:d} = sim;
  d.getElementById('btnStartTraining').click();
  let wrongClicks = 0;
  const start = Date.now();
  while (Date.now()-start < 1000) {
    const st = w.KX_DEBUG.getState();
    if (st.history.length >= 1) break;
    if (st.levelActive && st.canAnswer) {
      (st.expectedSame ? d.getElementById('btnDifferent') : d.getElementById('btnSame')).click();
      wrongClicks++;
    }
    await sleep(1);
  }
  await waitFor(()=>w.KX_DEBUG.getState().history.length>=1, 1000, 'forced-fail history');
  const firstRow = w.KX_DEBUG.getState().history[0];
  assert(firstRow.level === 15, 'normal difficulty should start at level 15');
  assert(firstRow.reason === '连续选错两次', 'forced fail reason mismatch');
  assert(firstRow.pass === false, 'forced fail should not pass');
  assert(firstRow.score === 10, 'forced fail should get fixed 10');
  assert(firstRow.nextLevel === 15, 'first fail should keep original level');
  sim.cleanup();
  return {wrongClicks, firstRow};
}

async function pauseScenario() {
  const sim = createContext({version:'child', trainingSeconds:10, difficulty:'easy', firstCardMs:200, autoContinueMs:1, accelerated:false});
  const {window:w, document:d} = sim;
  d.getElementById('btnStartTraining').click();
  await sleep(30);
  d.getElementById('pauseBtn').click();
  const paused = w.KX_DEBUG.getState();
  await sleep(60);
  const stillPaused = w.KX_DEBUG.getState();
  d.getElementById('btnResume').click();
  await waitFor(()=>w.KX_DEBUG.getState().canAnswer===true, 800, 'question after resume');
  const resumed = w.KX_DEBUG.getState();
  assert(paused.paused === true, 'pause state not set');
  assert(stillPaused.canAnswer === false, 'question advanced while paused');
  assert(resumed.canAnswer === true, 'question did not resume');
  const result = {pausedRemainingMs: Math.round(paused.questionDelayRemainingMs), stillPausedCanAnswer: stillPaused.canAnswer, resumedCanAnswer: resumed.canAnswer, overlayInactive: !d.getElementById('pauseOverlay').classList.contains('active')};
  sim.cleanup();
  return result;
}

async function main() {
  const diffSim = createContext();
  const diffPreview = diffSim.window.KX_DEBUG.adjustDifficultyPreview(10, [false,false,false,true,false,false,false]);
  diffSim.cleanup();
  assert(JSON.stringify(diffPreview.map(x=>x.to)) === JSON.stringify([10,9,7,8,8,7,5]), 'difficulty preview mismatch');
  const results = {
    difficultySelection: difficultySelectionScenario(),
    startEasy: await startLevelScenario('easy', 1),
    startNormal: await startLevelScenario('normal', 15),
    startHard: await startLevelScenario('hard', 30),
    queryHard: await startLevelScenario('', 30, { locationSearch: '?difficulty=hard', label: 'query-hard' }),
    guide: await guideScenario(),
    correct: await playCorrectScenario(),
    fail: await playForcedFailScenario(),
    pause: await pauseScenario(),
    diffPreview
  };
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err=>{ console.error(err); process.exit(1); });

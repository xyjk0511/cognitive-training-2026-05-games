const fs = require('fs');
const vm = require('vm');
const path = require('path');

class ClassList {
  constructor(){ this.set = new Set(); }
  add(x){ this.set.add(x); }
  remove(x){ this.set.delete(x); }
  toggle(x, flag){ if (flag) this.add(x); else this.remove(x); }
  contains(x){ return this.set.has(x); }
}
class Element {
  constructor(id='') { this.id=id; this.classList=new ClassList(); this.style={}; this.children=[]; this._listeners={}; this.textContent=''; this.innerHTML=''; this.className=''; this.dataset={}; this.onclick=null; this.value='0.55'; this.checked=false; }
  appendChild(x){ this.children.push(x); return x; }
  addEventListener(type, fn){ this._listeners[type]=fn; }
  querySelectorAll(){ return []; }
  querySelector(){ return null; }
  getContext(){ return ctx; }
  getBoundingClientRect(){ return {left:0, top:0, width:980, height:640}; }
}
const ids = ['pondCanvas','modal','modalCard','tutorialPrompt','toast','levelText','timeText','foodText','faultText','scoreText','totalScoreText','cooldownFill','cooldownText','pauseBtn','topbar','feederbar','volumeSlider','muteCheck'];
const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
elements.pondCanvas.width = 980; elements.pondCanvas.height = 640;
const ctx = new Proxy({}, { get(target, prop) { if (prop === 'canvas') return elements.pondCanvas; if (prop in target) return target[prop]; return (...args) => {}; }, set(target, prop, val){ target[prop] = val; return true; } });
global.document = { getElementById: id => elements[id] || (elements[id]=new Element(id)), createElement: tag => new Element(tag) };
global.window = global;
global.addEventListener = () => {};
global.requestAnimationFrame = () => 0;
global.performance = { now: () => 1000 };
global.CustomEvent = class { constructor(type, opts){ this.type=type; this.detail=opts && opts.detail; } };
global.dispatchEvent = () => {};
global.Image = class { constructor(){ this.complete=true; this.naturalWidth=1280; this.naturalHeight=96; this.src=''; } };
global.Audio = class { constructor(src){ this.src=src; this.volume=1; this.preload=''; this.loop=false; } cloneNode(){ const a = new global.Audio(this.src); a.volume=this.volume; return a; } play(){ return { catch(){} }; } pause(){} };
global.AudioContext = class { constructor(){ this.currentTime=0; this.state='running'; this.destination={}; } resume(){} createOscillator(){ return { frequency:{setValueAtTime(){}}, connect(){return this;}, start(){}, stop(){}, type:'sine'}; } createGain(){ return { gain:{setValueAtTime(){}, exponentialRampToValueAtTime(){}}, connect(){return this;} }; } };
global.webkitAudioContext = global.AudioContext;

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8'));
const game = global.SilentPondGameInstance;
function assert(cond, msg){ if (!cond) throw new Error(msg); }
assert(game.mode === 'welcome', 'boot should show welcome');

// Difficulty selection: easy / normal / hard must start at levels 1 / 15 / 30.
game.startTraining('easy');
assert(game.levelIndex === 0 && game.currentLevel.Level === 1, 'easy should start at level 1');
game.startTraining('normal');
assert(game.levelIndex === 14 && game.currentLevel.Level === 15, 'normal should start at level 15');
game.startTraining('hard');
assert(game.levelIndex === 29 && game.currentLevel.Level === 30, 'hard should start at level 30');
game.trend = [295];
game.sessionStartIndex = 29;
assert(game.buildTrendSvg().includes('第30关'), 'trend chart should label hard-session first point as level 30');

// P1 regression: final successful feed at 0.2s must clear the level, not fail after animation delay.
game.startLevel(0);
let reds = game.fish.filter(f => f.type === 'red');
assert(reds.length === 2, 'level 1 should have two red koi');
reds[0].fed = true;
game.timer = 0.2;
game.finishProjectile({fishId: reds[1].id, success: true});
assert(game.mode === 'resolving', 'final feed should enter resolving and freeze input/timer');
game.update(0.4);
assert(game.mode === 'levelComplete', 'final feed near timeout should complete, not fail');
assert(game.timer === 0.2, 'remaining time should be frozen at successful clear moment');

// Fault policy: Fault=2 means two mistakes are tolerated; third mistake fails.
game.startLevel(0);
const bad = game.fish.find(f => f.type !== 'red');
assert(bad, 'level 1 should have interference koi');
game.finishProjectile({fishId: bad.id, success: false});
assert(game.errors === 1 && game.mode === 'playing', 'first mistake tolerated');
game.finishProjectile({fishId: bad.id, success: false});
assert(game.errors === 2 && game.mode === 'playing', 'second mistake tolerated when Fault=2');
game.finishProjectile({fishId: bad.id, success: false});
assert(game.errors === 3 && game.mode === 'resolving', 'third mistake exceeds Fault=2 and starts failure resolution');

// Fish size config should affect hit radius.
game.currentLevel = { RedSize: 120 };
const f = game.makeFish('red', 100, 100, 0, 99);
assert(Math.abs(f.radius - 32.4) < 1e-6, 'RedSize=120 should scale fish radius to 120%');

console.log('runtime checks passed');

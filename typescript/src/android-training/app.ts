import { canonicalSha256, canonicalString } from "../canonical.js";
import type {
  A620InteractiveTrainingGameModule,
  TrainingPointerEvent,
} from "../game-plugin.js";
import {
  CatchLightGameModule,
  fruitDefinition,
  type CatchLightSessionSnapshot,
  type FruitPresentationSnapshot,
} from "../games/catch-light/index.js";
import {
  SignalStationTrainingGameModule,
  type GeneratedBatchPlan,
  type GeneratedSignalInstance,
  type SignalSymbol,
} from "../games/signal-station/index.js";

declare global {
  interface Window {
    A620Native: {
      emitEvent(messageType: string, correlationId: string | null, canonicalPayload: string): void;
      reportFatal(reason: string): void;
      requestControl(action: string): void;
      finishTraining(): void;
      uptimeMs(): number;
    };
    A620Runtime: {
      receiveCommand(canonicalCommand: string): void;
    };
  }
}

type JsonObject = Record<string, unknown>;
interface RuntimeCommand {
  messageType: string;
  messageId: string;
  senderSeq: number;
  payload: JsonObject;
}

const SESSION_DURATION_MS = 300_000;
const root = requireElement("app");
const title = requireElement("game-title");
const status = requireElement("status");
const timer = requireElement("timer");
const batch = requireElement("batch");
const cue = requireElement("cue");
const board = requireElement("board");
const pauseButton = requireElement("pause-button") as HTMLButtonElement;
const endButton = requireElement("end-button") as HTMLButtonElement;

let module: A620InteractiveTrainingGameModule | null = null;
let gameCode = "";
let commandQueue = Promise.resolve();
let state: "BOOT" | "READY" | "RUNNING" | "PAUSED" | "RESULT" | "TERMINATED" = "BOOT";
let effectiveStartUptimeMs = 0;
let cutoffUptimeMs = 0;
let totalPausedMs = 0;
let pauseStartedUptimeMs: number | null = null;
let pointerSequence = 0;
let frameHandle = 0;
let lastRenderBucket = -1;
let lastSignalPlan: GeneratedBatchPlan | null = null;

const fruitEmoji: Record<string, string> = {
  APPLE: "🍎", BANANA: "🍌", ORANGE: "🍊", PEAR: "🍐", STRAWBERRY: "🍓", GRAPE: "🍇",
  WATERMELON: "🍉", PINEAPPLE: "🍍", PEACH: "🍑", LEMON: "🍋", CHERRY: "🍒", MANGO: "🥭",
};
const colorValue: Record<string, string> = {
  BLUE: "#3b82f6", TEAL: "#14b8a6", AMBER: "#f59e0b", VIOLET: "#8b5cf6",
};

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}

function uptimeMs(): number {
  const value = Number(window.A620Native.uptimeMs());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("native uptime is invalid");
  return value;
}

function emit(messageType: string, correlationId: string | null, payload: JsonObject): void {
  window.A620Native.emitEvent(messageType, correlationId, canonicalString(payload));
}

function accepted(command: RuntimeCommand, runtimeState: string, effectiveAtUptimeMs: number): void {
  emit("COMMAND_ACCEPTED", command.messageId, {
    acceptedMessageType: command.messageType,
    effectiveAtUptimeMs,
    runtimeState,
    clockRevision: Number(command.payload.clockRevision ?? 1),
  });
}

function activeElapsedAt(now: number): number {
  if (effectiveStartUptimeMs === 0 || now <= effectiveStartUptimeMs) return 0;
  const pauseAdjustment = totalPausedMs + (pauseStartedUptimeMs === null ? 0 : Math.max(0, now - pauseStartedUptimeMs));
  return Math.max(0, Math.min(SESSION_DURATION_MS, now - effectiveStartUptimeMs - pauseAdjustment));
}

async function receive(command: RuntimeCommand): Promise<void> {
  switch (command.messageType) {
    case "PREPARE":
      await prepare(command);
      return;
    case "START":
      start(command);
      return;
    case "PAUSE":
      pause(command);
      return;
    case "RESUME":
      resume(command);
      return;
    case "DEADLINE":
      deadline(command);
      return;
    case "QUERY_STATE":
      queryState(command);
      return;
    case "ACK_RESULT_COMMITTED":
      committed(command);
      return;
    case "TERMINATE":
      terminate(command);
      return;
    default:
      throw new Error(`unsupported controller command ${command.messageType}`);
  }
}

async function prepare(command: RuntimeCommand): Promise<void> {
  if (state !== "BOOT" && state !== "TERMINATED") throw new Error(`PREPARE is illegal in ${state}`);
  const payload = command.payload;
  gameCode = String(payload.gameCode);
  module = gameCode === "CATCH_LIGHT"
    ? new CatchLightGameModule()
    : gameCode === "SIGNAL_STATION"
      ? new SignalStationTrainingGameModule()
      : null;
  if (module === null) throw new Error(`unsupported gameCode ${gameCode}`);

  module.setEvidenceSink(closedBatch => emit("BATCH_CLOSED", null, closedBatch as JsonObject));
  await module.prepare({
    gameCode,
    sessionSeed: Number(payload.sessionSeed),
    sessionStartLevel: Number(payload.sessionStartLevel),
    durationMs: 300000,
    runtimeConfigHash: String(payload.runtimeConfigHash),
    gameConfig: payload.gameConfig as Readonly<JsonObject>,
  });

  state = "READY";
  title.textContent = gameCode === "CATCH_LIGHT" ? "捕光行动" : "信号反应站";
  status.textContent = "准备完成";
  cue.textContent = "等待训练开始";
  board.replaceChildren();
  root.dataset.game = gameCode;
  pauseButton.disabled = true;
  endButton.disabled = false;
  emit("READY", command.messageId, {
    runtimeConfigHash: payload.runtimeConfigHash,
    plannedBatchCount: payload.plannedBatchCount,
    runtimeState: "READY",
  });
}

function start(command: RuntimeCommand): void {
  const runtime = requireModule();
  const startAt = Number(command.payload.effectiveStartUptimeMs);
  const cutoff = Number(command.payload.cutoffUptimeMs);
  accepted(command, "START_SCHEDULED", startAt);
  runtime.onStart(startAt, cutoff);
  effectiveStartUptimeMs = startAt;
  cutoffUptimeMs = cutoff;
  totalPausedMs = 0;
  pauseStartedUptimeMs = null;
  state = "RUNNING";
  status.textContent = "训练中";
  pauseButton.disabled = false;
  pauseButton.textContent = "暂停";
  emit("STARTED", command.messageId, {
    effectiveStartUptimeMs: startAt,
    cutoffUptimeMs: cutoff,
    runtimeState: "RUNNING",
    clockRevision: Number(command.payload.clockRevision),
  });
  startFrameLoop();
}

function pause(command: RuntimeCommand): void {
  if (state !== "RUNNING") throw new Error(`PAUSE is illegal in ${state}`);
  const pauseAt = Number(command.payload.effectivePauseUptimeMs);
  accepted(command, "PAUSE_SCHEDULED", pauseAt);
  requireModule().advanceToUptime(pauseAt);
  requireModule().onInputStreamsCancelled("PAUSE");
  requireModule().onPause(pauseAt);
  pauseStartedUptimeMs = pauseAt;
  state = "PAUSED";
  status.textContent = "已暂停";
  pauseButton.textContent = "继续";
  emit("PAUSED", command.messageId, {
    effectivePauseUptimeMs: pauseAt,
    activeElapsedMs: Number(command.payload.activeElapsedMs),
    runtimeState: "PAUSED",
    clockRevision: Number(command.payload.clockRevision),
  });
  render(uptimeMs(), true);
}

function resume(command: RuntimeCommand): void {
  if (state !== "PAUSED" || pauseStartedUptimeMs === null) throw new Error(`RESUME is illegal in ${state}`);
  const resumeAt = Number(command.payload.resumeInputEnabledUptimeMs);
  const cutoff = Number(command.payload.cutoffUptimeMs);
  accepted(command, "RESUME_SCHEDULED", resumeAt);
  requireModule().onResume(resumeAt, cutoff);
  totalPausedMs += Math.max(0, resumeAt - pauseStartedUptimeMs);
  pauseStartedUptimeMs = null;
  cutoffUptimeMs = cutoff;
  state = "RUNNING";
  status.textContent = "训练中";
  pauseButton.textContent = "暂停";
  emit("RESUMED", command.messageId, {
    resumeInputEnabledUptimeMs: resumeAt,
    cutoffUptimeMs: cutoff,
    activeElapsedMs: Number(command.payload.activeElapsedMs),
    runtimeState: "RUNNING",
    clockRevision: Number(command.payload.clockRevision),
  });
  startFrameLoop();
}

function deadline(command: RuntimeCommand): void {
  if (state !== "RUNNING") throw new Error(`DEADLINE is illegal in ${state}`);
  const cutoff = Number(command.payload.cutoffUptimeMs);
  const runtime = requireModule();
  runtime.advanceToUptime(cutoff);
  runtime.retryPendingBatchEvidence();
  runtime.onInputStreamsCancelled("DEADLINE");
  runtime.onDeadline(cutoff);
  const gamePayload = runtime.buildResultDraft() as unknown as JsonObject;
  state = "RESULT";
  status.textContent = "正在保存结果";
  cue.textContent = "训练完成";
  pauseButton.disabled = true;
  cancelAnimationFrame(frameHandle);
  emit("RESULT_READY", null, {
    resultDraftSha256: canonicalSha256(gamePayload),
    gamePayload,
  });
  renderResult(gamePayload);
}

function queryState(command: RuntimeCommand): void {
  emit("STATE_SNAPSHOT", command.messageId, {
    runtimeState: state === "RESULT" ? "RESULT_PENDING_COMMIT" : state,
    activeElapsedMs: activeElapsedAt(uptimeMs()),
    clockRevision: Number(command.payload.clockRevision ?? 1),
    lastAppliedControllerSeq: command.senderSeq,
  });
}

function committed(_: RuntimeCommand): void {
  status.textContent = "结果已安全保存";
  cue.textContent = "可以返回首页";
  endButton.textContent = "返回首页";
  document.body.classList.add("committed");
}

function terminate(command: RuntimeCommand): void {
  const terminateAt = Number(command.payload.effectiveTerminateUptimeMs);
  accepted(command, "TERMINATING", terminateAt);
  if (module !== null) {
    module.onInputStreamsCancelled("TERMINATE");
    module.onTerminate(String(command.payload.reasonCode));
  }
  state = "TERMINATED";
  cancelAnimationFrame(frameHandle);
  emit("TERMINATED", command.messageId, {
    effectiveTerminateUptimeMs: terminateAt,
    runtimeState: "TERMINATED",
    reasonCode: command.payload.reasonCode,
  });
  status.textContent = "训练已结束";
  cue.textContent = "正在返回首页";
  pauseButton.disabled = true;
  window.setTimeout(() => window.A620Native.finishTraining(), 350);
}

function startFrameLoop(): void {
  cancelAnimationFrame(frameHandle);
  const tick = (): void => {
    if (state !== "RUNNING") return;
    const now = uptimeMs();
    if (now >= effectiveStartUptimeMs && now <= cutoffUptimeMs) {
      requireModule().advanceToUptime(now);
      render(now, false);
    }
    frameHandle = requestAnimationFrame(tick);
  };
  frameHandle = requestAnimationFrame(tick);
}

function render(now: number, force: boolean): void {
  const activeMs = activeElapsedAt(now);
  const bucket = Math.floor(activeMs / 100);
  if (!force && bucket === lastRenderBucket) return;
  lastRenderBucket = bucket;
  const remaining = Math.max(0, SESSION_DURATION_MS - activeMs);
  timer.textContent = `${Math.floor(remaining / 60_000).toString().padStart(2, "0")}:${Math.floor((remaining % 60_000) / 1000).toString().padStart(2, "0")}`;
  if (gameCode === "CATCH_LIGHT") renderCatchLight(now);
  else renderSignalStation(activeMs);
}

function renderCatchLight(now: number): void {
  const runtime = requireModule() as CatchLightGameModule;
  const snapshot: CatchLightSessionSnapshot = runtime.snapshotAtUptime(now);
  const current = snapshot.currentBatch;
  batch.textContent = current === null ? "准备批次" : `第 ${current.batchOrdinal}/8 批 · 等级 ${current.levelBefore}`;
  if (current === null) {
    cue.textContent = "准备下一批";
    board.replaceChildren();
    return;
  }
  const target = fruitDefinition(current.targetFruitId);
  cue.textContent = current.phase === "PROMPT"
    ? `请记住目标：${fruitEmoji[target.fruitId] ?? "●"} ${target.displayNameZh}`
    : `找到 ${fruitEmoji[target.fruitId] ?? "●"} ${target.displayNameZh}`;
  board.style.setProperty("--rows", current.gridId.split("x")[0] ?? "2");
  board.style.setProperty("--cols", current.gridId.split("x")[1] ?? "2");
  renderObjects(current.visibleObjects, object => fruitButton(object));
}

function fruitButton(object: FruitPresentationSnapshot): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `game-object fruit ${object.role.toLowerCase()} ${object.visualPhase.toLowerCase()}`;
  button.dataset.hitToken = object.instanceId;
  button.dataset.slot = object.slotId;
  const rowCol = /^R(\d+)C(\d+)$/.exec(object.slotId);
  if (rowCol !== null) {
    button.style.gridRow = rowCol[1]!;
    button.style.gridColumn = rowCol[2]!;
  }
  button.disabled = !object.clickable;
  button.textContent = fruitEmoji[object.fruitId] ?? "●";
  if (object.isDouble) button.dataset.double = object.doubleProgress === 1 ? "再点一次" : "×2";
  return button;
}

function renderSignalStation(activeMs: number): void {
  const runtime = requireModule() as SignalStationTrainingGameModule;
  const plan = runtime.currentPlan();
  if (plan === null) {
    board.replaceChildren();
    cue.textContent = "准备下一批";
    return;
  }
  lastSignalPlan = plan;
  const batchOrdinal = plan.batchOrdinal;
  const activeInBatch = activeMs - (batchOrdinal - 1) * 37_500;
  batch.textContent = `第 ${batchOrdinal}/8 批 · 等级 ${plan.level}`;
  const cards = Object.values(plan.targetCards).filter((value): value is SignalSymbol => value !== null);
  cue.replaceChildren(document.createTextNode("目标 "));
  cards.forEach(card => cue.appendChild(symbolElement(card, "target-card")));

  const visible = plan.waves.flatMap(wave => wave.instances).filter(instance =>
    activeInBatch >= instance.enterStartInBatchMs && activeInBatch < instance.naturalExitEndInBatchMs,
  );
  const rows = Math.max(1, ...plan.waves.flatMap(wave => wave.instances.map(value => value.row)));
  const cols = Math.max(1, ...plan.waves.flatMap(wave => wave.instances.map(value => value.column)));
  board.style.setProperty("--rows", String(rows));
  board.style.setProperty("--cols", String(cols));
  renderObjects(visible, object => signalButton(object));
}

function signalButton(instance: GeneratedSignalInstance): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `game-object signal ${instance.role.toLowerCase()}`;
  button.dataset.hitToken = instance.instanceId;
  button.style.gridRow = String(instance.row + 1);
  button.style.gridColumn = String(instance.column + 1);
  button.appendChild(symbolElement(instance.symbol, "signal-symbol"));
  if (instance.requiresDouble) button.dataset.double = "×2";
  return button;
}

function symbolElement(symbol: SignalSymbol, className: string): HTMLElement {
  const element = document.createElement("span");
  element.className = `${className} contour-${symbol.contour.toLowerCase()}`;
  element.style.setProperty("--symbol-color", colorValue[symbol.colorFamily] ?? "#fff");
  element.style.setProperty("--rotation", `${symbol.directionDeg}deg`);
  element.dataset.mark = symbol.innerMark;
  return element;
}

function renderObjects<T>(objects: readonly T[], create: (object: T) => HTMLElement): void {
  const fragment = document.createDocumentFragment();
  objects.forEach(object => fragment.appendChild(create(object)));
  board.replaceChildren(fragment);
}

function renderResult(payload: JsonObject): void {
  board.replaceChildren();
  const panel = document.createElement("section");
  panel.className = "result-panel";
  const score = Number(payload.sessionRawScore ?? 0);
  const eligible = Number(payload.eligibleBatchCount ?? 0);
  panel.innerHTML = `<strong>训练完成</strong><span>完成批次 ${eligible}/8</span><span>本次积分 ${score}</span>`;
  board.appendChild(panel);
}

function requireModule(): A620InteractiveTrainingGameModule {
  if (module === null) throw new Error("game module is not prepared");
  return module;
}

board.addEventListener("pointerdown", event => {
  if (state !== "RUNNING") return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-hit-token]");
  const sourceUptimeMs = uptimeMs();
  const pointerEvent: TrainingPointerEvent = {
    pointerEventId: `WEB-${sourceUptimeMs}-${++pointerSequence}`,
    pointerId: String(event.pointerId),
    phase: "DOWN",
    sourceUptimeMs,
    xPx: Math.round(event.clientX),
    yPx: Math.round(event.clientY),
    hitToken: target?.dataset.hitToken ?? null,
  };
  requireModule().onPointerEvent(pointerEvent);
  render(sourceUptimeMs, true);
});

pauseButton.addEventListener("click", () => {
  if (state === "RUNNING") window.A620Native.requestControl("PAUSE");
  else if (state === "PAUSED") window.A620Native.requestControl("RESUME");
});
endButton.addEventListener("click", () => {
  if (state === "RESULT" || state === "TERMINATED") window.A620Native.finishTraining();
  else window.A620Native.requestControl("TERMINATE");
});

window.A620Runtime = {
  receiveCommand(canonicalCommand: string): void {
    commandQueue = commandQueue.then(async () => {
      const command = JSON.parse(canonicalCommand) as RuntimeCommand;
      await receive(command);
    }).catch(error => {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      status.textContent = "运行异常";
      cue.textContent = reason;
      window.A620Native.reportFatal(reason.slice(0, 240));
    });
  },
};

status.textContent = "正在连接训练服务";
window.A620Native.requestControl("WEB_READY");

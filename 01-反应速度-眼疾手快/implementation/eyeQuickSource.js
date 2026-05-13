import eyeQuickData from './eyeQuickData.json' with { type: 'json' }

export const EYE_QUICK_SOURCE_PATH =
  'cognitive-training-2026-05/01 感知觉/01 反应速度-眼疾手快/data.json'

export const EYE_QUICK_EXPECTED_COLUMNS = [
  'ID',
  'Level',
  'Num',
  'LineCount',
  'LineSpace',
  'CountMax',
  'CountMin',
  'Time',
  'Normal',
  'Helmet',
  'Bomb',
  'White',
  'Other',
  'Fault',
  'Time',
  'Brains',
  'Score',
  'Scores',
  'Reward',
  'RewardNum',
  'Limit',
]

export const EYE_QUICK_LEVEL_COUNT = 51
export const EYE_QUICK_BASE_AWARD = 10
export const EYE_QUICK_TOTAL_ROUNDS = 3

export const EYE_QUICK_LEVELS = parseEyeQuickLevels(eyeQuickData)

export function parseEyeQuickLevels(source = eyeQuickData) {
  const columns = source?.Level?.Columes
  const values = source?.Level?.Values

  if (!Array.isArray(columns) || !Array.isArray(values)) {
    throw new Error('Eye Quick source data is missing Level.Columes or Level.Values')
  }

  assertExpectedColumns(columns)

  if (values.length !== EYE_QUICK_LEVEL_COUNT) {
    throw new Error(`Eye Quick source data must contain ${EYE_QUICK_LEVEL_COUNT} levels, got ${values.length}`)
  }

  const levels = values.map((row, index) => mapLevelRow(row, index))
  validateSequentialLevels(levels)
  return levels
}

export function selectStimulusType(config, draw) {
  const value = Math.max(1, Math.min(100, Math.ceil(draw)))
  if (value <= config.thresholds.normal) return 'normal'
  if (value <= config.thresholds.helmet) return 'helmet'
  if (value <= config.thresholds.bomb) return 'bomb'
  if (value <= config.thresholds.white) return 'whiteCat'
  if (value <= config.thresholds.other) return 'otherCat'
  return 'otherCat'
}

export function createEyeQuickSession(level = 1, options = {}) {
  const config = getEyeQuickLevel(level)
  const now = options.now ?? 0
  const durationMs = options.durationMs ?? config.roundDurationSeconds * 1000
  return {
    active: [],
    award: 0,
    bestStreak: 0,
    completed: false,
    config,
    consecutiveWrong: 0,
    correctTargets: 0,
    effects: [],
    ended: false,
    eventLog: [],
    failureStreak: options.failureStreak ?? 0,
    forbiddenResolved: 0,
    forbiddenSpawned: 0,
    helmetResolved: 0,
    helmetSpawned: 0,
    lastSpawnAt: now - config.spawnIntervalMs,
    lastTickAt: now,
    level: config.level,
    misses: 0,
    mistakes: 0,
    nextId: 1,
    nextLevel: config.level,
    reactionTimes: [],
    remainingMs: durationMs,
    roundDurationMs: durationMs,
    roundResult: null,
    score: 0,
    spawnedCount: 0,
    startedAt: now,
    streak: 0,
    targetCount: config.targetCount,
    totalClicks: 0,
  }
}

export function createNextEyeQuickSession(previousSession, options = {}) {
  return createEyeQuickSession(previousSession.nextLevel || previousSession.level || 1, {
    durationMs: options.durationMs ?? previousSession.roundDurationMs,
    failureStreak: previousSession.failureStreak ?? 0,
    now: options.now ?? previousSession.lastTickAt ?? 0,
  })
}

export function stepEyeQuickSession(session, now, rng = Math.random) {
  if (session.ended) {
    return pruneEyeQuickEffects(session, now)
  }

  let next = cloneEyeQuickSession(session)
  const delta = Math.max(0, now - next.lastTickAt)
  next.lastTickAt = now
  next.remainingMs = Math.max(0, next.remainingMs - delta)
  next = expireEyeQuickStimuli(next, now)

  if (!shouldFinalize(next)) {
    next = spawnEyeQuickBatch(next, now, rng)
  }

  next = pruneEyeQuickEffects(next, now)
  if (shouldFinalize(next)) {
    next = finalizeEyeQuickRound(next, next.remainingMs <= 0 ? 'time' : 'fault', now)
  }
  return next
}

export function applyEyeQuickClick(session, cellIndex, now) {
  if (session.ended) {
    return session
  }

  const next = cloneEyeQuickSession(session)
  const activeIndex = next.active.findIndex((stimulus) => stimulus.cellIndex === cellIndex)
  next.totalClicks += 1

  if (activeIndex === -1) {
    registerMistake(next, cellIndex, now, 'empty')
    next.eventLog.push(makeEyeEvent('click', now, { cellIndex, outcome: 'empty' }))
    return maybeFinalizeAfterClick(pruneEyeQuickEffects(next, now), now)
  }

  const stimulus = { ...next.active[activeIndex] }
  next.active[activeIndex] = stimulus
  next.eventLog.push(makeEyeEvent('click', now, {
    cellIndex,
    outcome: 'hit',
    stimulusId: stimulus.id,
    type: stimulus.type,
  }))

  if (stimulus.type === 'normal') {
    resolveTarget(next, activeIndex, stimulus, now, next.config.scoreValue)
    return maybeFinalizeAfterClick(pruneEyeQuickEffects(next, now), now)
  }

  if (stimulus.type === 'helmet') {
    stimulus.hits += 1
    if (stimulus.hits < 2) {
      next.effects.push(makeEyeEffect(cellIndex, 'helmet-hit', now, '再点一下'))
      return pruneEyeQuickEffects(next, now)
    }
    next.helmetResolved += 1
    resolveTarget(next, activeIndex, stimulus, now, next.config.scoreValue)
    return maybeFinalizeAfterClick(pruneEyeQuickEffects(next, now), now)
  }

  next.forbiddenResolved += 1
  registerMistake(next, cellIndex, now, stimulus.type)
  next.active.splice(activeIndex, 1)
  next.eventLog.push(makeEyeEvent('resolve', now, {
    cellIndex,
    outcome: 'forbidden-click',
    scoreEffect: -next.config.scoreValue,
    stimulusId: stimulus.id,
    type: stimulus.type,
  }))
  return maybeFinalizeAfterClick(pruneEyeQuickEffects(next, now), now)
}

export function buildEyeQuickRoundResult(session, reason = 'time') {
  const passed = session.correctTargets >= session.targetCount
  const levelMove = calculateEyeQuickNextLevel(session.level, passed, session.failureStreak)
  const award = calculateEyeQuickAward(session.config, session.correctTargets, passed)
  const averageReactionMs = session.reactionTimes.length
    ? Math.round(session.reactionTimes.reduce((total, item) => total + item, 0) / session.reactionTimes.length)
    : 0
  const doubleHitCompletionRate = session.helmetSpawned === 0
    ? 100
    : Math.round((session.helmetResolved / session.helmetSpawned) * 100)
  const inhibitionControlRate = session.forbiddenSpawned === 0
    ? 100
    : Math.max(0, Math.round(((session.forbiddenSpawned - session.forbiddenResolved) / session.forbiddenSpawned) * 100))

  return {
    accuracy: session.targetCount === 0 ? 100 : Math.round((session.correctTargets / session.targetCount) * 100),
    averageReactionMs,
    award,
    bestStreak: session.bestStreak,
    correctTargets: session.correctTargets,
    doubleHitCompletionRate,
    eventCount: session.eventLog.length,
    failureStreak: levelMove.failureStreak,
    forbiddenResolved: session.forbiddenResolved,
    forbiddenSpawned: session.forbiddenSpawned,
    helmetResolved: session.helmetResolved,
    helmetSpawned: session.helmetSpawned,
    inhibitionControlRate,
    level: session.level,
    misses: session.misses,
    mistakes: session.mistakes,
    nextLevel: levelMove.nextLevel,
    note: levelMove.note,
    passed,
    reason,
    score: session.score,
    targetCount: session.targetCount,
    totalClicks: session.totalClicks,
  }
}

export function calculateEyeQuickAward(config, actualCount, passed) {
  if (!passed) {
    return EYE_QUICK_BASE_AWARD
  }
  return Math.round(config.passScore + Math.max(0, actualCount - config.targetCount) * config.rewardScore + EYE_QUICK_BASE_AWARD)
}

export function calculateEyeQuickNextLevel(level, passed, failureStreak = 0) {
  if (passed) {
    return {
      failureStreak: 0,
      nextLevel: Math.min(EYE_QUICK_LEVEL_COUNT, level + 1),
      note: '通过，难度 +1',
    }
  }

  const nextFailureStreak = failureStreak + 1
  if (nextFailureStreak >= 3) {
    return {
      failureStreak: 0,
      nextLevel: Math.max(1, level - 3),
      note: '连续失败 3 次，难度 -3，并重置失败计数',
    }
  }
  if (nextFailureStreak === 2) {
    return {
      failureStreak: nextFailureStreak,
      nextLevel: Math.max(1, level - 1),
      note: '连续失败 2 次，难度 -1',
    }
  }
  return {
    failureStreak: nextFailureStreak,
    nextLevel: level,
    note: '失败 1 次，原难度继续训练',
  }
}

export function getEyeQuickLevel(level) {
  const index = Math.max(0, Math.min(EYE_QUICK_LEVELS.length - 1, level - 1))
  return EYE_QUICK_LEVELS[index]
}

export function isEyeQuickTarget(type) {
  return type === 'normal' || type === 'helmet'
}

export function getEyeQuickTargetProgress(session) {
  return `${session.correctTargets}/${session.targetCount}`
}

function assertExpectedColumns(columns) {
  if (columns.length !== EYE_QUICK_EXPECTED_COLUMNS.length) {
    throw new Error(`Eye Quick source columns length mismatch: ${columns.length}`)
  }
  EYE_QUICK_EXPECTED_COLUMNS.forEach((expected, index) => {
    if (columns[index] !== expected) {
      throw new Error(`Eye Quick source column ${index} must be ${expected}, got ${columns[index]}`)
    }
  })
}

function mapLevelRow(row, index) {
  if (!Array.isArray(row) || row.length !== EYE_QUICK_EXPECTED_COLUMNS.length) {
    throw new Error(`Eye Quick level row ${index + 1} has invalid length`)
  }

  const dimensions = parseBoardDimensions(row[2], index)
  const thresholds = {
    normal: toNumber(row[8], index, 'Normal'),
    helmet: toNumber(row[9], index, 'Helmet'),
    bomb: toNumber(row[10], index, 'Bomb'),
    white: toNumber(row[11], index, 'White'),
    other: toNumber(row[12], index, 'Other'),
  }
  validateThresholds(thresholds, index)

  const rawCountMax = toNumber(row[5], index, 'CountMax')
  const rawCountMin = toNumber(row[6], index, 'CountMin')
  const scoreValue = toNumber(row[16], index, 'Score')
  const passScore = toNumber(row[17], index, 'Scores')
  const targetCount = scoreValue > 0 ? Math.ceil(passScore / scoreValue) : 0

  return {
    id: toNumber(row[0], index, 'ID'),
    level: toNumber(row[1], index, 'Level'),
    sourceIndex: index,
    sourcePath: EYE_QUICK_SOURCE_PATH,
    num: row[2],
    rows: dimensions.rows,
    columns: dimensions.columns,
    boardSize: dimensions.rows * dimensions.columns,
    lineCount: toNumber(row[3], index, 'LineCount'),
    spawnIntervalMs: toNumber(row[4], index, 'LineSpace'),
    rawCountMax,
    rawCountMin,
    spawnCountMin: Math.min(rawCountMin, rawCountMax),
    spawnCountMax: Math.max(rawCountMin, rawCountMax),
    responseWindowMs: toNumber(row[7], index, 'response Time'),
    thresholds,
    faultLimit: toNumber(row[13], index, 'Fault'),
    roundDurationSeconds: toNumber(row[14], index, 'round Time'),
    brains: toNumber(row[15], index, 'Brains'),
    scoreValue,
    passScore,
    scores: passScore,
    reward: toNumber(row[18], index, 'Reward'),
    rewardScore: toNumber(row[19], index, 'RewardNum'),
    limit: toNumber(row[20], index, 'Limit'),
    targetCount,
  }
}

function validateSequentialLevels(levels) {
  levels.forEach((level, index) => {
    if (level.id !== index + 1 || level.level !== index + 1) {
      throw new Error(`Eye Quick level row ${index + 1} must have matching ID and Level`)
    }
    if (level.spawnCountMin < 1 || level.spawnCountMax < level.spawnCountMin) {
      throw new Error(`Eye Quick level ${level.level} has invalid spawn count bounds`)
    }
    if (level.roundDurationSeconds <= 0) {
      throw new Error(`Eye Quick level ${level.level} has invalid round duration`)
    }
  })
}

function validateThresholds(thresholds, index) {
  const values = [thresholds.normal, thresholds.helmet, thresholds.bomb, thresholds.white, thresholds.other]
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < 0 || values[i] > 100) {
      throw new Error(`Eye Quick row ${index + 1} threshold out of range`)
    }
    if (i > 0 && values[i] < values[i - 1]) {
      throw new Error(`Eye Quick row ${index + 1} thresholds must be cumulative`)
    }
  }
  if (thresholds.other !== 100) {
    throw new Error(`Eye Quick row ${index + 1} Other threshold must be 100`)
  }
}

function parseBoardDimensions(value, index) {
  const match = /^(\d+)\*(\d+)$/.exec(String(value))
  if (!match) {
    throw new Error(`Eye Quick row ${index + 1} has invalid Num value: ${value}`)
  }
  const columns = Number(match[1])
  const rows = Number(match[2])
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns <= 0 || rows <= 0) {
    throw new Error(`Eye Quick row ${index + 1} has invalid board dimensions`)
  }
  return { columns, rows }
}

function spawnEyeQuickBatch(session, now, rng) {
  if (now - session.lastSpawnAt < session.config.spawnIntervalMs) {
    return session
  }

  const occupied = new Set(session.active.map((stimulus) => stimulus.cellIndex))
  const openCells = []
  for (let index = 0; index < session.config.boardSize; index += 1) {
    if (!occupied.has(index)) {
      openCells.push(index)
    }
  }

  const remainingCapacity = Math.min(openCells.length, session.config.spawnCountMax - session.active.length)
  if (remainingCapacity <= 0) {
    return session
  }

  const requestedCount = randomInt(session.config.spawnCountMin, session.config.spawnCountMax, rng)
  const batchCount = Math.min(remainingCapacity, requestedCount)
  for (let count = 0; count < batchCount; count += 1) {
    const slotIndex = randomInt(0, openCells.length - 1, rng)
    const [cellIndex] = openCells.splice(slotIndex, 1)
    const type = selectStimulusType(session.config, randomInt(1, 100, rng))
    const stimulus = {
      cellIndex,
      expiresAt: now + session.config.responseWindowMs,
      hits: 0,
      id: `eye-${session.nextId}`,
      spawnedAt: now,
      type,
    }

    session.nextId += 1
    session.spawnedCount += 1
    if (type === 'helmet') session.helmetSpawned += 1
    if (!isEyeQuickTarget(type)) session.forbiddenSpawned += 1
    session.active.push(stimulus)
    session.eventLog.push(makeEyeEvent('spawn', now, {
      cellIndex,
      stimulusId: stimulus.id,
      type,
    }))
  }

  session.lastSpawnAt = now
  return session
}

function expireEyeQuickStimuli(session, now) {
  const survivors = []
  for (const stimulus of session.active) {
    if (stimulus.expiresAt > now) {
      survivors.push(stimulus)
      continue
    }
    if (isEyeQuickTarget(stimulus.type)) {
      session.misses += 1
      session.consecutiveWrong += 1
      session.streak = 0
      session.effects.push(makeEyeEffect(stimulus.cellIndex, 'miss', now, '漏击'))
    }
    session.eventLog.push(makeEyeEvent('resolve', now, {
      cellIndex: stimulus.cellIndex,
      outcome: 'expired',
      scoreEffect: 0,
      stimulusId: stimulus.id,
      type: stimulus.type,
    }))
  }
  session.active = survivors
  return session
}

function resolveTarget(session, activeIndex, stimulus, now, scoreEffect) {
  session.correctTargets += 1
  session.consecutiveWrong = 0
  session.streak += 1
  session.bestStreak = Math.max(session.bestStreak, session.streak)
  session.score += scoreEffect
  session.reactionTimes.push(now - stimulus.spawnedAt)
  session.effects.push(makeEyeEffect(stimulus.cellIndex, 'good-hit', now, `+${scoreEffect}`))
  session.eventLog.push(makeEyeEvent('resolve', now, {
    cellIndex: stimulus.cellIndex,
    outcome: 'success',
    scoreEffect,
    stimulusId: stimulus.id,
    type: stimulus.type,
  }))
  session.active.splice(activeIndex, 1)
}

function registerMistake(session, cellIndex, now, type) {
  session.mistakes += 1
  session.consecutiveWrong += 1
  session.streak = 0
  session.score = Math.max(0, session.score - session.config.scoreValue)
  session.effects.push(makeEyeEffect(cellIndex, 'mistake', now, `-${session.config.scoreValue}`))
  session.eventLog.push(makeEyeEvent('mistake', now, {
    cellIndex,
    outcome: 'mistake',
    scoreEffect: -session.config.scoreValue,
    type,
  }))
}

function maybeFinalizeAfterClick(session, now) {
  if (shouldFinalize(session)) {
    return finalizeEyeQuickRound(session, session.remainingMs <= 0 ? 'time' : 'fault', now)
  }
  return session
}

function shouldFinalize(session) {
  return session.remainingMs <= 0 ||
    session.mistakes > session.config.faultLimit ||
    session.consecutiveWrong >= 2
}

function finalizeEyeQuickRound(session, reason, now) {
  if (session.ended) {
    return session
  }
  const result = buildEyeQuickRoundResult(session, reason)
  session.award = result.award
  session.ended = true
  session.active = []
  session.completed = result.passed
  session.failureStreak = result.failureStreak
  session.nextLevel = result.nextLevel
  session.roundResult = result
  session.eventLog.push(makeEyeEvent('round-result', now, {
    level: session.level,
    nextLevel: result.nextLevel,
    outcome: result.passed ? 'passed' : 'failed',
    reason,
    scoreEffect: result.award,
  }))
  return session
}

function cloneEyeQuickSession(session) {
  return {
    ...session,
    active: session.active.map((stimulus) => ({ ...stimulus })),
    effects: session.effects.map((effect) => ({ ...effect })),
    eventLog: session.eventLog.map((event) => ({ ...event })),
    reactionTimes: [...session.reactionTimes],
    roundResult: session.roundResult ? { ...session.roundResult } : null,
  }
}

function pruneEyeQuickEffects(session, now) {
  return {
    ...session,
    effects: session.effects.filter((effect) => now - effect.createdAt <= 720),
  }
}

function randomInt(min, max, rng) {
  if (max <= min) {
    return min
  }
  return min + Math.floor(rng() * (max - min + 1))
}

function makeEyeEffect(cellIndex, type, createdAt, label) {
  return {
    cellIndex,
    createdAt,
    id: `eye-effect-${cellIndex}-${createdAt}-${type}`,
    label,
    type,
  }
}

function makeEyeEvent(kind, at, extra) {
  return {
    at,
    kind,
    ...extra,
  }
}

function toNumber(value, index, field) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new Error(`Eye Quick row ${index + 1} field ${field} must be numeric`)
  }
  return number
}

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EYE_QUICK_EXPECTED_COLUMNS,
  EYE_QUICK_LEVELS,
  applyEyeQuickClick,
  buildEyeQuickRoundResult,
  calculateEyeQuickAward,
  calculateEyeQuickNextLevel,
  createEyeQuickSession,
  getEyeQuickTargetProgress,
  parseEyeQuickLevels,
  selectStimulusType,
  stepEyeQuickSession,
} from './eyeQuickSource.js'

test('source config maps all 51 levels with duplicate Time columns', () => {
  assert.equal(EYE_QUICK_LEVELS.length, 51)

  const first = EYE_QUICK_LEVELS[0]
  assert.equal(first.level, 1)
  assert.equal(first.columns, 3)
  assert.equal(first.rows, 3)
  assert.equal(first.spawnIntervalMs, 2065)
  assert.equal(first.responseWindowMs, 3500)
  assert.equal(first.roundDurationSeconds, 30)
  assert.equal(first.spawnCountMin, 1)
  assert.equal(first.spawnCountMax, 3)
  assert.equal(first.targetCount, 19)

  const middle = EYE_QUICK_LEVELS[20]
  assert.equal(middle.level, 21)
  assert.equal(middle.columns, 4)
  assert.equal(middle.rows, 4)
  assert.equal(middle.faultLimit, 2)
  assert.equal(middle.targetCount, 20)

  const final = EYE_QUICK_LEVELS[50]
  assert.equal(final.level, 51)
  assert.equal(final.columns, 5)
  assert.equal(final.rows, 4)
  assert.equal(final.scoreValue, 0)
  assert.equal(final.targetCount, 0)
})

test('source validation rejects wrong column sequence and level count', () => {
  assert.throws(() => parseEyeQuickLevels({ Level: { Columes: ['ID'], Values: [] } }), /columns length/)
  assert.throws(
    () => parseEyeQuickLevels({ Level: { Columes: EYE_QUICK_EXPECTED_COLUMNS, Values: [] } }),
    /51 levels/,
  )
})

test('cumulative thresholds select source stimulus types exactly', () => {
  const config = EYE_QUICK_LEVELS[0]

  assert.equal(selectStimulusType(config, 1), 'normal')
  assert.equal(selectStimulusType(config, 77), 'normal')
  assert.equal(selectStimulusType(config, 78), 'helmet')
  assert.equal(selectStimulusType(config, 87), 'helmet')
  assert.equal(selectStimulusType(config, 88), 'bomb')
  assert.equal(selectStimulusType(config, 92), 'bomb')
  assert.equal(selectStimulusType(config, 93), 'whiteCat')
  assert.equal(selectStimulusType(config, 97), 'whiteCat')
  assert.equal(selectStimulusType(config, 98), 'otherCat')
  assert.equal(selectStimulusType(config, 100), 'otherCat')
})

test('spawn uses source board, count bounds, timing, and event records', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  const next = stepEyeQuickSession(session, 2065, () => 0)

  assert.equal(next.config.boardSize, 9)
  assert.equal(next.active.length, 1)
  assert.equal(next.active[0].cellIndex, 0)
  assert.equal(next.active[0].type, 'normal')
  assert.equal(next.active[0].expiresAt, 5565)
  assert.equal(next.eventLog[0].kind, 'spawn')
})

test('single target click scores once and records reaction time', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  session.active = [{ cellIndex: 2, expiresAt: 5000, hits: 0, id: 'normal-1', spawnedAt: 1000, type: 'normal' }]

  const next = applyEyeQuickClick(session, 2, 1300)

  assert.equal(next.active.length, 0)
  assert.equal(next.correctTargets, 1)
  assert.equal(next.score, 11)
  assert.deepEqual(next.reactionTimes, [300])
  assert.equal(getEyeQuickTargetProgress(next), '1/19')
})

test('helmet target requires two clicks before resolving', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  session.active = [{ cellIndex: 4, expiresAt: 5000, hits: 0, id: 'helmet-1', spawnedAt: 1000, type: 'helmet' }]
  session.helmetSpawned = 1

  const first = applyEyeQuickClick(session, 4, 1400)
  assert.equal(first.active.length, 1)
  assert.equal(first.active[0].hits, 1)
  assert.equal(first.score, 0)

  const second = applyEyeQuickClick(first, 4, 1800)
  const result = buildEyeQuickRoundResult(second)
  assert.equal(second.active.length, 0)
  assert.equal(second.correctTargets, 1)
  assert.equal(second.helmetResolved, 1)
  assert.equal(result.doubleHitCompletionRate, 100)
})

test('forbidden click consumes source fault tolerance before failure', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  session.active = [{ cellIndex: 6, expiresAt: 5000, hits: 0, id: 'bomb-1', spawnedAt: 1000, type: 'bomb' }]
  session.forbiddenSpawned = 1
  session.score = 44

  const next = applyEyeQuickClick(session, 6, 1200)

  assert.equal(next.ended, false)
  assert.equal(next.roundResult, null)
  assert.equal(next.mistakes, 1)
  assert.equal(next.forbiddenResolved, 1)
  assert.equal(next.score, 33)
})

test('second consecutive mistake ends the round by documented wrong condition', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  const first = applyEyeQuickClick(session, 6, 1200)
  const second = applyEyeQuickClick(first, 7, 1300)

  assert.equal(second.ended, true)
  assert.equal(second.roundResult.passed, false)
  assert.equal(second.mistakes, 2)
  assert.equal(second.roundResult.award, 10)
})

test('expired target counts as miss and consecutive wrong evidence', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  session.active = [{ cellIndex: 0, expiresAt: 1050, hits: 0, id: 'normal-2', spawnedAt: 1000, type: 'normal' }]
  session.lastSpawnAt = 1200

  const next = stepEyeQuickSession(session, 1200, () => 0.99)

  assert.equal(next.misses, 1)
  assert.equal(next.consecutiveWrong, 1)
  assert.equal(next.active.length, 0)
})

test('award and level movement follow revised logic', () => {
  const config = EYE_QUICK_LEVELS[0]

  assert.equal(calculateEyeQuickAward(config, 19, true), 210)
  assert.equal(calculateEyeQuickAward(config, 21, true), 212)
  assert.equal(calculateEyeQuickAward(config, 4, false), 10)

  assert.deepEqual(calculateEyeQuickNextLevel(5, true, 2), {
    failureStreak: 0,
    nextLevel: 6,
    note: '通过，难度 +1',
  })
  assert.equal(calculateEyeQuickNextLevel(5, false, 0).nextLevel, 5)
  assert.equal(calculateEyeQuickNextLevel(5, false, 1).nextLevel, 4)
  assert.equal(calculateEyeQuickNextLevel(5, false, 2).nextLevel, 2)
  assert.equal(calculateEyeQuickNextLevel(1, false, 2).nextLevel, 1)
})

test('round result includes audit metrics and next level', () => {
  const session = createEyeQuickSession(1, { now: 0 })
  session.correctTargets = 19
  session.score = 209
  session.reactionTimes = [200, 300]
  session.eventLog = [{ kind: 'spawn' }, { kind: 'resolve' }]

  const result = buildEyeQuickRoundResult(session, 'time')

  assert.equal(result.passed, true)
  assert.equal(result.award, 210)
  assert.equal(result.averageReactionMs, 250)
  assert.equal(result.nextLevel, 2)
  assert.equal(result.eventCount, 2)
})

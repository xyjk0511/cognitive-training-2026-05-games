import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  brainValue,
  evaluateDifficultyAttempt,
  hydrateStrongMemoryData,
  nextDifficulty,
  roundScore,
  validateFloorTargets
} from '../../public/playable-games/strong-memory/rules.mjs';

const dataPath = path.resolve(process.cwd(), 'public/playable-games/strong-memory/data.json');
const strongMemoryData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

describe('strong memory reference rules', () => {
  it('calculates the configured score formula', () => {
    expect(roundScore(1, 15, 15)).toBe(150);
    expect(roundScore(10, 7.5, 15)).toBe(350);
    expect(roundScore(60, 0, 15)).toBe(1280);
  });

  it('calculates the configured brain value formula', () => {
    expect(brainValue(1)).toBe(100);
    expect(brainValue(2)).toBe(100);
    expect(brainValue(3)).toBe(105);
    expect(brainValue(60)).toBe(245);
  });

  it('upgrades difficulty after three successful missions', () => {
    const level = { level: 12, missionPass: 3 };
    expect(evaluateDifficultyAttempt({ level, passedRounds: 3 })).toMatchObject({
      passed: true,
      nextLevel: 13,
      consecutiveFailures: 0
    });
  });

  it('repeats a difficulty after one failed attempt', () => {
    expect(nextDifficulty({ difficulty: 12, passed: false, consecutiveFailures: 0 })).toMatchObject({
      nextLevel: 12,
      consecutiveFailures: 1
    });
  });

  it('downgrades after two consecutive failed attempts without going below level 1', () => {
    expect(nextDifficulty({ difficulty: 12, passed: false, consecutiveFailures: 1 })).toMatchObject({
      nextLevel: 11,
      consecutiveFailures: 0
    });
    expect(nextDifficulty({ difficulty: 1, passed: false, consecutiveFailures: 1 })).toMatchObject({
      nextLevel: 1,
      consecutiveFailures: 0
    });
  });

  it('resets next start after passing level 60', () => {
    expect(nextDifficulty({ difficulty: 60, passed: true, consecutiveFailures: 0 })).toMatchObject({
      nextLevel: 1,
      consecutiveFailures: 0,
      maxCompleted: true
    });
  });
});

describe('strong memory data contract', () => {
  it('loads 800 floors and 60 levels from data.json', () => {
    const hydrated = hydrateStrongMemoryData(strongMemoryData);
    expect(hydrated.floorRows).toHaveLength(800);
    expect(hydrated.levels).toHaveLength(60);
  });

  it('keeps all target coordinates inside each floor grid', () => {
    const hydrated = hydrateStrongMemoryData(strongMemoryData);
    expect(validateFloorTargets(hydrated.floorRows)).toEqual([]);
  });
});

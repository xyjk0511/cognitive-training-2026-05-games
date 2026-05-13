export const STRONG_MEMORY_MAX_LEVEL = 60;
export const STRONG_MEMORY_MIN_LEVEL = 1;

export function roundScore(difficulty, remainingTime, operationTime) {
  const safeDifficulty = Number(difficulty) || 1;
  const safeRemaining = Math.max(0, Number(remainingTime) || 0);
  const safeOperation = Math.max(1, Number(operationTime) || 1);
  return Math.round(80 + safeDifficulty * 20 + (40 + safeDifficulty * 10) * safeRemaining / safeOperation);
}

export function brainValue(difficulty) {
  const safeDifficulty = Math.max(1, Number(difficulty) || 1);
  return 100 + Math.floor((safeDifficulty - 1) / 2) * 5;
}

export function nextDifficulty({ difficulty, passed, consecutiveFailures = 0, maxLevel = STRONG_MEMORY_MAX_LEVEL }) {
  const current = clamp(Number(difficulty) || 1, STRONG_MEMORY_MIN_LEVEL, maxLevel);
  if (passed && current >= maxLevel) {
    return { nextLevel: STRONG_MEMORY_MIN_LEVEL, consecutiveFailures: 0, maxCompleted: true };
  }
  if (passed) {
    return { nextLevel: clamp(current + 1, STRONG_MEMORY_MIN_LEVEL, maxLevel), consecutiveFailures: 0, maxCompleted: false };
  }
  const failures = Number(consecutiveFailures) + 1;
  if (failures >= 2) {
    return { nextLevel: clamp(current - 1, STRONG_MEMORY_MIN_LEVEL, maxLevel), consecutiveFailures: 0, maxCompleted: false };
  }
  return { nextLevel: current, consecutiveFailures: failures, maxCompleted: false };
}

export function evaluateDifficultyAttempt({ level, passedRounds, previousConsecutiveFailures = 0, maxLevel = STRONG_MEMORY_MAX_LEVEL }) {
  const passed = Number(passedRounds) >= Number(level.missionPass);
  const movement = nextDifficulty({
    difficulty: level.level,
    passed,
    consecutiveFailures: previousConsecutiveFailures,
    maxLevel
  });
  return {
    passed,
    nextLevel: movement.nextLevel,
    consecutiveFailures: movement.consecutiveFailures,
    maxCompleted: movement.maxCompleted
  };
}

export function rowsFromTable(table) {
  if (!table || !Array.isArray(table.Columes) || !Array.isArray(table.Values)) return [];
  return table.Values.map((values) => Object.fromEntries(table.Columes.map((column, index) => [column, values[index]])));
}

export function parseGrid(value) {
  const match = String(value || '3x3').match(/^(\d+)x(\d+)$/i);
  if (!match) return { rows: 3, cols: 3 };
  return { rows: Number(match[1]), cols: Number(match[2]) };
}

export function parseTargets(value) {
  try {
    const list = JSON.parse(value);
    return list.map((item, index) => {
      const [row, col] = String(item).split(',').map((part) => Number(part.trim()));
      return { row, col, type: index % 2 };
    }).filter((target) => Number.isFinite(target.row) && Number.isFinite(target.col));
  } catch {
    return [];
  }
}

export function validateFloorTargets(floorRows) {
  const errors = [];
  for (const row of floorRows) {
    const grid = parseGrid(row.TargetGrid);
    const targets = parseTargets(row.posBlock);
    for (const target of targets) {
      if (target.row < 1 || target.row > grid.rows || target.col < 1 || target.col > grid.cols) {
        errors.push({
          id: Number(row.ID),
          target,
          grid
        });
      }
    }
  }
  return errors;
}

export function hydrateStrongMemoryData(data) {
  const floorRows = rowsFromTable(data?.Floor);
  const levelRows = rowsFromTable(data?.Level);
  const floorsById = new Map(floorRows.map((row) => {
    const grid = parseGrid(row.TargetGrid);
    return [Number(row.ID), {
      id: Number(row.ID),
      floor: Number(row.Floor),
      blockNum: Number(row.BlockNum),
      rows: grid.rows,
      cols: grid.cols,
      targets: parseTargets(row.posBlock)
    }];
  }));

  const levels = levelRows.map((row) => {
    const blockIds = String(row.Blocks || '').split(',').map((item) => Number(item.trim())).filter(Boolean);
    return {
      id: Number(row.ID),
      level: Number(row.Level),
      totalNum: Number(row.TotalNum),
      blockIds,
      blockTypeNum: Number(row.BlockTypeNum),
      missionNum: Number(row.MissionNum),
      missionPass: Number(row.MissionPass),
      fault: Number(row.Fault),
      time: Number(row.Time),
      brains: Number(row.Brains),
      score: Number(row.Score),
      scores: Number(row.Scores),
      reward: Number(row.Reward),
      rewardNum: Number(row.RewardNum),
      limit: Number(row.Limit),
      floorPool: blockIds.map((id) => floorsById.get(id)).filter(Boolean)
    };
  }).filter((level) => level.floorPool.length > 0);

  return { floorRows, levelRows, floorsById, levels };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

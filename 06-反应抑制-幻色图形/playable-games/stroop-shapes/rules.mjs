export const STROOP_SHAPES_LEVEL_COUNT = 100;

export function rowsFromTable(table) {
  if (!table || !Array.isArray(table.Columes) || !Array.isArray(table.Values)) return [];
  return table.Values.map((row) => Object.fromEntries(table.Columes.map((column, index) => [column, row[index]])));
}

export function hydrateStroopShapesData(data) {
  const colors = rowsFromTable(data?.Floor).map((row) => ({
    id: Number(row.ID),
    name: String(row.Color),
    rgba: String(row.RGB).split(',').map((part) => Number(part.trim())),
  }));
  const levels = rowsFromTable(data?.Level).map((row) => ({
    id: Number(row.ID),
    level: Number(row.Level),
    colorCount: Number(row.Value),
    congruentRate: Number(row.Rate),
    missionNum: Number(row.MissionNum),
    missionPass: Number(row.MissionPass),
    fault: Number(row.Fault),
    time: Number(row.Time),
    brains: Number(row.Brains),
    score: Number(row.Score),
    passScore: Number(row.Scores),
    reward: Number(row.Reward),
    rewardNum: Number(row.RewardNum),
    limit: Number(row.Limit),
  })).slice(0, STROOP_SHAPES_LEVEL_COUNT);
  return { colors, levels };
}

export function buildStroopTrial(level, colors, draw = 0) {
  const available = colors.slice(0, Math.max(2, Math.min(colors.length, level.colorCount)));
  const displayColor = available[Math.floor(draw * available.length) % available.length];
  const congruent = draw * 100 < level.congruentRate;
  const wordColor = congruent
    ? displayColor
    : available.find((color) => color.id !== displayColor.id) || displayColor;
  return {
    congruent,
    displayColor,
    expectedResponse: congruent ? 'check' : 'cross',
    word: wordColor.name,
    wordColor,
  };
}

export function judgeStroopResponse(trial, response) {
  const normalized = response === true ? 'check' : response === false ? 'cross' : String(response);
  return {
    correct: normalized === trial.expectedResponse,
    expectedResponse: trial.expectedResponse,
  };
}

export function completeStroopLevel({ level, correctCount }) {
  const passed = correctCount >= level.missionPass;
  return {
    passed,
    score: passed ? level.score + Math.max(0, correctCount - level.missionPass) * level.passScore + 10 : 10,
  };
}

export function nextStroopLevel({ level, passed, consecutiveFailures = 0 }) {
  if (passed) return { nextLevel: Math.min(STROOP_SHAPES_LEVEL_COUNT, level + 1), consecutiveFailures: 0 };
  const failures = consecutiveFailures + 1;
  if (failures >= 3) return { nextLevel: Math.max(1, level - 3), consecutiveFailures: 0 };
  if (failures === 2) return { nextLevel: Math.max(1, level - 1), consecutiveFailures: failures };
  return { nextLevel: level, consecutiveFailures: failures };
}

export function shouldEndStroopLevel({ level, correctCount, consecutiveWrong = 0, remainingTime = 1 }) {
  return remainingTime <= 0 || consecutiveWrong >= 2 || correctCount >= level.missionPass;
}

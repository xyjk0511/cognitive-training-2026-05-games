export const FLASH_SHAPES_MAX_LEVEL = 50;
export const FLASH_SHAPES_MIN_LEVEL = 1;

export function rowsFromTable(table) {
  if (!table || !Array.isArray(table.Columes) || !Array.isArray(table.Values)) return [];
  return table.Values.map((row) => Object.fromEntries(table.Columes.map((column, index) => [column, row[index]])));
}

export function hydrateFlashShapesData(data) {
  const levels = rowsFromTable(data?.Level).map((row) => ({
    id: Number(row.ID),
    level: Number(row.Level),
    sameRate: Number(row.Rate),
    stimulusType: Number(row.Type),
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
  }));
  return { levels };
}

export function getFlashLevel(data, level) {
  const { levels } = hydrateFlashShapesData(data);
  const index = Math.max(0, Math.min(levels.length - 1, Number(level || 1) - 1));
  return levels[index];
}

export function createFlashTrial({ previousStimulus, candidateStimulus, level, draw = 0 }) {
  if (!previousStimulus) {
    return {
      candidateStimulus,
      expectedResponse: null,
      firstTrial: true,
      previousStimulus: null,
      same: null,
    };
  }
  const same = draw * 100 < Number(level.sameRate);
  const nextStimulus = same ? previousStimulus : candidateStimulus;
  return {
    candidateStimulus: nextStimulus,
    expectedResponse: same ? 'same' : 'different',
    firstTrial: false,
    previousStimulus,
    same,
  };
}

export function judgeFlashResponse(trial, response) {
  if (trial.firstTrial) {
    return { correct: false, ignored: true, reason: 'first-stimulus-has-no-one-back-answer' };
  }
  const normalized = response === true ? 'same' : response === false ? 'different' : String(response);
  return {
    correct: normalized === trial.expectedResponse,
    expectedResponse: trial.expectedResponse,
    ignored: false,
  };
}

export function scoreFlashAttempt(level, correct) {
  return correct ? Number(level.score) : 0;
}

export function completeFlashLevel({ level, correctCount, wrongCount, remainingTime = 0 }) {
  const passed = correctCount >= level.missionPass && wrongCount <= level.fault;
  const score = passed
    ? level.passScore + Math.max(0, correctCount - level.missionPass) * level.rewardNum + (remainingTime >= level.limit ? level.reward : 0)
    : 10;
  return {
    passed,
    score,
    reason: passed ? 'mission-pass' : 'mission-failed',
  };
}

export function nextFlashLevel({ level, passed, consecutiveFailures = 0 }) {
  if (passed) {
    return { nextLevel: Math.min(FLASH_SHAPES_MAX_LEVEL, level + 1), consecutiveFailures: 0 };
  }
  const failures = consecutiveFailures + 1;
  if (failures >= 3) {
    return { nextLevel: Math.max(FLASH_SHAPES_MIN_LEVEL, level - 3), consecutiveFailures: 0 };
  }
  if (failures >= 2) {
    return { nextLevel: Math.max(FLASH_SHAPES_MIN_LEVEL, level - 1), consecutiveFailures: failures };
  }
  return { nextLevel: level, consecutiveFailures: failures };
}

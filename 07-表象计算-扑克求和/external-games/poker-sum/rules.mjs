export function rowsFromTable(table) {
  if (!table || !Array.isArray(table.Columes) || !Array.isArray(table.Values)) return [];
  return table.Values.map((row) => Object.fromEntries(table.Columes.map((column, index) => [column, row[index]])));
}

export function hydrateSumLevels(data) {
  return rowsFromTable(data?.Level).map((row) => ({
    id: Number(row.ID),
    level: Number(row.Level),
    cardCount: Number(row.TotalNum),
    values: String(row.Value).split(',').map(Number).filter(Number.isFinite),
    missionNum: Number(row.MissionNum),
    missionPass: Number(row.MissionPass),
    fault: Number(row.Fault),
    time: Number(row.Time),
    brains: Number(row.Brains),
    score: Number(row.Score),
    extraScore: Number(row.Scores),
    reward: Number(row.Reward),
    rewardNum: Number(row.RewardNum),
    limit: Number(row.Limit),
  })).slice(0, 100);
}

export function buildPokerProblem(level, draw = 0) {
  const cards = Array.from({ length: level.cardCount }, (_, index) => {
    const value = level.values[(Math.floor(draw * 1000) + index) % level.values.length];
    return { value, suit: ['spade', 'heart', 'club', 'diamond'][index % 4] };
  });
  const answer = cards.reduce((sum, card) => sum + card.value, 0);
  return {
    answer,
    cards,
    options: [answer, answer + 1, Math.max(0, answer - 1), answer + 2].sort((a, b) => a - b),
  };
}

export function judgeSumAnswer(problem, answer) {
  return { correct: Number(answer) === problem.answer, expectedAnswer: problem.answer };
}

export function completeSumLevel({ level, correctCount, wrongCount }) {
  const passed = correctCount >= level.missionPass && wrongCount <= level.fault;
  return {
    passed,
    score: passed ? level.score + Math.max(0, correctCount - level.missionPass) * level.extraScore + 10 : 10,
  };
}

export function nextSumLevel({ level, passed, consecutiveFailures = 0 }) {
  if (passed) return { nextLevel: Math.min(100, level + 1), consecutiveFailures: 0 };
  const failures = consecutiveFailures + 1;
  if (failures >= 3) return { nextLevel: Math.max(1, level - 3), consecutiveFailures: 0 };
  if (failures >= 2) return { nextLevel: Math.max(1, level - 1), consecutiveFailures: failures };
  return { nextLevel: level, consecutiveFailures: failures };
}

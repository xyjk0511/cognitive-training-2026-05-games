export const NUMBER_LADDER_LEVEL_COUNT = 100;

export function rowsFromTable(table) {
  if (!table || !Array.isArray(table.Columes) || !Array.isArray(table.Values)) return [];
  return table.Values.map((row) => Object.fromEntries(table.Columes.map((column, index) => [column, row[index]])));
}

export function hydrateNumberLadderData(data) {
  const floors = rowsFromTable(data?.Floor).map((row) => ({
    id: Number(row.ID),
    floor: Number(row.Floor),
    positions: parsePositions(row.posBlock),
  }));
  const symbols = rowsFromTable(data?.Symbol).map((row) => ({
    id: Number(row.ID),
    answerMin: Number(row.AnswerMin),
    answerMax: Number(row.AnswerMax),
    form: Number(row.Form),
    symbol1: Number(row.Symbol1),
    min: Number(row.Min),
    max: Number(row.Max),
  }));
  const levels = rowsFromTable(data?.Level).map((row) => ({
    id: Number(row.ID),
    level: Number(row.Level),
    totalNum: Number(row.TotalNum),
    blockIds: String(row.Blocks || '').split(',').map((item) => Number(item.trim())).filter(Boolean),
    symbolNumber: Number(row.SymbolNumber),
    bubbleNumber: Number(row.BubbleNumber),
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
  return { floors, levels, symbols };
}

export function parsePositions(value) {
  try {
    return JSON.parse(value).map((item) => {
      const [row, col] = String(item).split(',').map((part) => Number(part.trim()));
      return { row, col };
    }).filter((item) => Number.isFinite(item.row) && Number.isFinite(item.col));
  } catch {
    return [];
  }
}

export function generateNumberValue(symbol, index = 0) {
  const span = Math.max(1, symbol.answerMax - symbol.answerMin + 1);
  const base = symbol.answerMin + (index % span);
  if (symbol.symbol1 === 1) return base + symbol.min;
  if (symbol.symbol1 === 2) return base - symbol.min;
  return base;
}

export function buildNumberLadderRound(level, floor, symbol) {
  const count = Math.max(1, level.totalNum);
  const values = Array.from({ length: count }, (_, index) => generateNumberValue(symbol, index));
  const bubbles = values.map((value, index) => ({
    id: `bubble-${index + 1}`,
    position: floor.positions[index % floor.positions.length] || { row: 1, col: index + 1 },
    value,
  }));
  return {
    bubbles,
    expectedOrder: bubbles.slice().sort((a, b) => a.value - b.value || a.id.localeCompare(b.id)).map((bubble) => bubble.id),
    level,
  };
}

export function selectNumberBubble(round, selectedIds, bubbleId) {
  const expectedId = round.expectedOrder[selectedIds.length];
  const correct = bubbleId === expectedId;
  return {
    correct,
    complete: correct && selectedIds.length + 1 === round.expectedOrder.length,
    expectedId,
    selectedIds: correct ? selectedIds.concat(bubbleId) : selectedIds,
  };
}

export function completeNumberLadderLevel({ level, correctRounds, wrongCount, remainingTime = 0 }) {
  const passed = correctRounds >= level.missionPass && wrongCount <= level.fault;
  const timeRatio = Math.max(0, Math.min(level.time, remainingTime)) / Math.max(1, level.time);
  return {
    passed,
    score: passed ? Math.round(level.score + level.passScore * timeRatio) : 10,
  };
}

export function nextNumberLadderLevel({ level, passed, consecutiveFailures = 0 }) {
  if (passed) return { nextLevel: Math.min(NUMBER_LADDER_LEVEL_COUNT, level + 1), consecutiveFailures: 0 };
  const failures = consecutiveFailures + 1;
  if (failures >= 2) return { nextLevel: Math.max(1, level - 1), consecutiveFailures: 0 };
  return { nextLevel: level, consecutiveFailures: failures };
}

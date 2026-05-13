export function loadParcelLevels(levelConfig) {
  return levelConfig.filter(Boolean).map((row) => ({
    level: Number(row.level),
    mapId: Number(row.mapId),
    speed: Number(row.movSpeed),
    produceTime: Number(row.produceTime),
    produceTotal: Number(row.produceTotal),
    totalTime: Number(row.totalTime),
    repetitionRate: Number(row.repetitionRate),
    singleScore: Number(row.singleScore),
    perfectScore: Number(row.perfectScore),
    passScore: Number(row.passScore),
  }));
}

export function routeParcel(parcel, selectedExit) {
  return {
    correct: Number(parcel.exit) === Number(selectedExit),
    expectedExit: Number(parcel.exit),
    selectedExit: Number(selectedExit),
  };
}

export function scoreParcelAttempt(level, correct) {
  return correct ? level.singleScore : 0;
}

export function scoreParcelLevel({ level, correctCount, producedCount }) {
  const safeProduced = Math.max(1, producedCount);
  const accuracy = Math.max(0, Math.min(1, correctCount / safeProduced));
  const reward = accuracy === 1 ? level.perfectScore : accuracy > 0.5 ? Math.round(level.perfectScore * 0.5) : 0;
  return {
    accuracy,
    reward,
    score: correctCount * level.singleScore + reward,
  };
}

export function completeParcelLevel({ level, correctCount, producedCount }) {
  const scoring = scoreParcelLevel({ level, correctCount, producedCount });
  const passed = scoring.score >= level.passScore;
  return {
    passed,
    ...scoring,
  };
}

export function nextParcelLevel({ level, passed, consecutivePasses = 0, consecutiveFailures = 0 }) {
  if (passed) {
    const passes = consecutivePasses + 1;
    if (passes >= 2) {
      return { nextLevel: Math.min(50, level + 3), consecutivePasses: 0, consecutiveFailures: 0 };
    }
    return { nextLevel: level, consecutivePasses: passes, consecutiveFailures: 0 };
  }
  const failures = consecutiveFailures + 1;
  if (failures >= 3) return { nextLevel: Math.max(1, level - 5), consecutivePasses: 0, consecutiveFailures: 0 };
  if (failures === 2) return { nextLevel: Math.max(1, level - 3), consecutivePasses: 0, consecutiveFailures: failures };
  return { nextLevel: level, consecutivePasses: 0, consecutiveFailures: failures };
}

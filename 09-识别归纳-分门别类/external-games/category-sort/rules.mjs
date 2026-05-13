export function rowsFromTable(table) {
  if (!table || !Array.isArray(table.Columes) || !Array.isArray(table.Values)) return [];
  return table.Values.map((row) => Object.fromEntries(table.Columes.map((column, index) => [column, row[index]])));
}

export function hydrateCategoryData(data) {
  const typeRows = rowsFromTable(data?.Type);
  const items = rowsFromTable(data?.Item).map((row) => {
    const [primary, secondary, tertiary] = String(row.Type).split('-').map(Number);
    return {
      id: Number(row.ID),
      name: String(row.Name),
      primary,
      secondary,
      tertiary,
      image: `assets/item-${String(row.ID).padStart(2, '0')}.png`,
    };
  });
  const levels = rowsFromTable(data?.Level).map((row) => ({
    level: Number(row.Level),
    dimension: Number(row.Type),
    targets: String(row.Target).split('/').map(Number).filter(Number.isFinite),
    optionalQuantity: Number(row.OptionalQuantity),
    stageTime: Number(row.StageTime),
    baseScore: Number(row.BaseScore),
    rewardScore: Number(row.RewardScore),
    passTarget: Number(row.PassTarget),
  }));
  return { typeRows, items, levels };
}

export function itemMatchesCategory(item, level, target) {
  const value = level.dimension === 0 ? item.primary : level.dimension === 1 ? item.secondary : item.tertiary;
  return Number(value) === Number(target);
}

export function buildCategoryRound(level, items, draw = 0) {
  const target = level.targets[Math.floor(draw * 1000) % level.targets.length];
  const matches = items.filter((item) => itemMatchesCategory(item, level, target));
  const distractors = items.filter((item) => !itemMatchesCategory(item, level, target));
  return {
    cue: matches[0],
    target,
    options: matches.slice(0, 1).concat(distractors.slice(0, Math.max(1, level.optionalQuantity - 1))),
  };
}

export function scoreCategoryLevel({ level, correctCount, remainingTime = 0 }) {
  const passed = correctCount >= level.passTarget;
  const optionFactor = 1 + (level.optionalQuantity - 2) / 10;
  return {
    passed,
    score: passed ? Math.round(level.baseScore * optionFactor + remainingTime * 2 + Math.max(0, correctCount - level.passTarget) * level.rewardScore + 10) : 10,
  };
}

export { buildPokerProblem as buildDiceProblem, completeSumLevel, hydrateSumLevels, judgeSumAnswer, nextSumLevel, rowsFromTable } from '../../../07-表象计算-扑克求和/external-games/poker-sum/rules.mjs';

export function diceAssetReference(value) {
  return `source-dice-face-${Number(value)}`;
}

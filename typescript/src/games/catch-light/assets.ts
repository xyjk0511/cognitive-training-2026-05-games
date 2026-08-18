import type { FruitDefinition, FruitId, FruitPoolId, GridDefinition, GridId, GridSlot } from "./types.js";

export const FRUIT_CATALOG: readonly FruitDefinition[] = Object.freeze([
  {fruitId:"APPLE",displayNameZh:"苹果",assetPath:"assets/fruits/apple.png",mainColorHex:"#D94141",outlineShape:"ROUND_STEM",textureCue:"SMOOTH_LEAF",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_ROUND_APPLE_ORANGE","SIM_SMOOTH_APPLE_BANANA"]},
  {fruitId:"BANANA",displayNameZh:"香蕉",assetPath:"assets/fruits/banana.png",mainColorHex:"#F2CF45",outlineShape:"CURVED_CRESCENT",textureCue:"RIDGED_TIPS",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_SMOOTH_APPLE_BANANA","SIM_ELONGATED_BANANA_PEAR"]},
  {fruitId:"ORANGE",displayNameZh:"橙子",assetPath:"assets/fruits/orange.png",mainColorHex:"#F28B2D",outlineShape:"ROUND_LEAF",textureCue:"DIMPLED_PEEL",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_ROUND_GRAPE_ORANGE","SIM_ROUND_APPLE_ORANGE"]},
  {fruitId:"PEAR",displayNameZh:"梨",assetPath:"assets/fruits/pear.png",mainColorHex:"#A8C957",outlineShape:"BELL_STEM",textureCue:"SPECKLED_SMOOTH",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_ELONGATED_BANANA_PEAR","SIM_TAPERED_PEAR_STRAWBERRY"]},
  {fruitId:"STRAWBERRY",displayNameZh:"草莓",assetPath:"assets/fruits/strawberry.png",mainColorHex:"#E84655",outlineShape:"HEART_LEAF_CROWN",textureCue:"SEEDED",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_TAPERED_PEAR_STRAWBERRY","SIM_SEEDED_STRAWBERRY_GRAPE"]},
  {fruitId:"GRAPE",displayNameZh:"葡萄",assetPath:"assets/fruits/grape.png",mainColorHex:"#7550A6",outlineShape:"CLUSTER",textureCue:"ROUND_SEEDED_CLUSTER",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_SEEDED_STRAWBERRY_GRAPE","SIM_ROUND_GRAPE_ORANGE"]},
  {fruitId:"WATERMELON",displayNameZh:"西瓜",assetPath:"assets/fruits/watermelon.png",mainColorHex:"#4DAD66",outlineShape:"ROUND_STRIPED",textureCue:"STRIPED_RIND",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_ROUND_WATERMELON_PEACH","SIM_RIND_LEMON_WATERMELON"]},
  {fruitId:"PINEAPPLE",displayNameZh:"菠萝",assetPath:"assets/fruits/pineapple.png",mainColorHex:"#E8B83D",outlineShape:"OVAL_CROWN",textureCue:"DIAMOND_TEXTURE",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_OVAL_MANGO_PINEAPPLE","SIM_YELLOW_PINEAPPLE_LEMON"]},
  {fruitId:"PEACH",displayNameZh:"桃",assetPath:"assets/fruits/peach.png",mainColorHex:"#F19B75",outlineShape:"ROUND_CLEFT_LEAF",textureCue:"SOFT_SMOOTH",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_ROUND_WATERMELON_PEACH","SIM_SMOOTH_PEACH_CHERRY"]},
  {fruitId:"LEMON",displayNameZh:"柠檬",assetPath:"assets/fruits/lemon.png",mainColorHex:"#EAD94C",outlineShape:"OVAL_POINTED",textureCue:"DIMPLED_PEEL",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_YELLOW_PINEAPPLE_LEMON","SIM_RIND_LEMON_WATERMELON"]},
  {fruitId:"CHERRY",displayNameZh:"樱桃",assetPath:"assets/fruits/cherry.png",mainColorHex:"#B92D3A",outlineShape:"TWIN_ROUND_STEMS",textureCue:"GLOSSY_SMOOTH",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_SMOOTH_PEACH_CHERRY","SIM_WARM_CHERRY_MANGO"]},
  {fruitId:"MANGO",displayNameZh:"芒果",assetPath:"assets/fruits/mango.png",mainColorHex:"#E99A35",outlineShape:"ASYMMETRIC_OVAL",textureCue:"SMOOTH_GRADIENT",targetAllowed:true,distractorAllowed:true,similarityTags:["SIM_WARM_CHERRY_MANGO","SIM_OVAL_MANGO_PINEAPPLE"]},
]);

export const FRUIT_POOLS: Readonly<Record<FruitPoolId, readonly FruitId[]>> = Object.freeze({
  FP_CORE_A: Object.freeze(["APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE"] as const),
  FP_CORE_B: Object.freeze(["WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO"] as const),
  FP_TRANSFER: Object.freeze(["APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE", "WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO"] as const),
});

const FRUIT_BY_ID = new Map(FRUIT_CATALOG.map(fruit => [fruit.fruitId, fruit]));

export function fruitDefinition(fruitId: FruitId): FruitDefinition {
  const value = FRUIT_BY_ID.get(fruitId);
  if (value === undefined) throw new Error(`unknown fruitId: ${fruitId}`);
  return value;
}

export function fruitsAreSimilar(a: FruitId, b: FruitId): boolean {
  if (a === b) return false;
  const bTags = new Set(fruitDefinition(b).similarityTags);
  return fruitDefinition(a).similarityTags.some(tag => bTags.has(tag));
}

function buildGrid(gridId: GridId, rows: number, cols: number): GridDefinition {
  const slots: GridSlot[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      slots.push({
        slotId: `R${row + 1}C${col + 1}`,
        row: row + 1,
        col: col + 1,
        xBasisPoints: Math.round(((col + 1) * 10000) / (cols + 1)),
        yBasisPoints: Math.round(((row + 1) * 10000) / (rows + 1)),
        edgeSlot: col === 0 || col === cols - 1,
        minHitWidthDp: 120,
        minHitHeightDp: 120,
      });
    }
  }
  return {gridId, rows, cols, slots: Object.freeze(slots)};
}

export const GRID_CATALOG: readonly GridDefinition[] = Object.freeze([
  buildGrid("2x2", 2, 2),
  buildGrid("2x3", 2, 3),
  buildGrid("3x3", 3, 3),
  buildGrid("3x4", 3, 4),
]);

const GRID_BY_ID = new Map(GRID_CATALOG.map(grid => [grid.gridId, grid]));

export function gridDefinition(gridId: GridId): GridDefinition {
  const value = GRID_BY_ID.get(gridId);
  if (value === undefined) throw new Error(`unknown gridId: ${gridId}`);
  return value;
}

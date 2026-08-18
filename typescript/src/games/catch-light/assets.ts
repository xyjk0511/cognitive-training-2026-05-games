import { immutableSnapshot } from "./immutability.js";
import type {
  FruitContentQualification,
  FruitDefinition,
  FruitId,
  FruitPoolId,
  FruitSimilarityRelation,
  GridDefinition,
  GridId,
  GridSlot,
} from "./types.js";

/**
 * CORE_A is copied from the v1.4 workbook's exact single-attribute relation
 * table. The source package does not contain an exact CORE_B relation matrix
 * or final sprites. CORE_B relations below are therefore an explicitly
 * unapproved W2 compatibility mapping used only to keep the required L120
 * headless slice deterministic; they are not production product truth.
 */
export const FRUIT_SIMILARITY_RELATIONS: readonly FruitSimilarityRelation[] = immutableSnapshot([
  {tag:"SIM_COLOR_APPLE_STRAWBERRY",fruitA:"APPLE",fruitB:"STRAWBERRY",primaryAttribute:"COLOR",authority:"SOURCE_WORKBOOK_CONFIRMED"},
  {tag:"SIM_SHAPE_APPLE_ORANGE",fruitA:"APPLE",fruitB:"ORANGE",primaryAttribute:"SHAPE",authority:"SOURCE_WORKBOOK_CONFIRMED"},
  {tag:"SIM_COLOR_BANANA_PEAR",fruitA:"BANANA",fruitB:"PEAR",primaryAttribute:"COLOR",authority:"SOURCE_WORKBOOK_CONFIRMED"},
  {tag:"SIM_COLOR_ORANGE_PEAR",fruitA:"ORANGE",fruitB:"PEAR",primaryAttribute:"COLOR",authority:"SOURCE_WORKBOOK_CONFIRMED"},
  {tag:"SIM_TEXTURE_STRAWBERRY_GRAPE",fruitA:"STRAWBERRY",fruitB:"GRAPE",primaryAttribute:"TEXTURE",authority:"SOURCE_WORKBOOK_CONFIRMED"},
  {tag:"SIM_SHAPE_WATERMELON_PEACH",fruitA:"WATERMELON",fruitB:"PEACH",primaryAttribute:"SHAPE",authority:"ENGINEERING_COMPATIBILITY_UNAPPROVED"},
  {tag:"SIM_TEXTURE_LEMON_WATERMELON",fruitA:"LEMON",fruitB:"WATERMELON",primaryAttribute:"TEXTURE",authority:"ENGINEERING_COMPATIBILITY_UNAPPROVED"},
  {tag:"SIM_SHAPE_MANGO_PINEAPPLE",fruitA:"MANGO",fruitB:"PINEAPPLE",primaryAttribute:"SHAPE",authority:"ENGINEERING_COMPATIBILITY_UNAPPROVED"},
  {tag:"SIM_COLOR_PINEAPPLE_LEMON",fruitA:"PINEAPPLE",fruitB:"LEMON",primaryAttribute:"COLOR",authority:"ENGINEERING_COMPATIBILITY_UNAPPROVED"},
  {tag:"SIM_TEXTURE_PEACH_CHERRY",fruitA:"PEACH",fruitB:"CHERRY",primaryAttribute:"TEXTURE",authority:"ENGINEERING_COMPATIBILITY_UNAPPROVED"},
  {tag:"SIM_COLOR_CHERRY_MANGO",fruitA:"CHERRY",fruitB:"MANGO",primaryAttribute:"COLOR",authority:"ENGINEERING_COMPATIBILITY_UNAPPROVED"},
] satisfies FruitSimilarityRelation[]);

export const FRUIT_CONTENT_QUALIFICATION: FruitContentQualification = immutableSnapshot({
  qualificationVersion: "catch-light-fruit-content-qualification-1",
  runtimeUseStatus: "HEADLESS_VERTICAL_SLICE_ONLY",
  productionActivationStatus: "BLOCKED_PENDING_FRUIT_SPRITES_AND_CORE_B_RELATION_APPROVAL",
  fruitMetadataStatus: "ENGINEERING_PLACEHOLDER_PENDING_ART_QA",
  fruitSpriteStatus: "PLACEHOLDER_REFERENCES_ONLY",
  coreA: {
    relationStatus: "SOURCE_WORKBOOK_CONFIRMED",
    source: "捕光行动-120级数值设计-v1.4.xlsx/水果相似关系",
    relationUseApproved: true,
    productionGate: "NONE",
    pairs: FRUIT_SIMILARITY_RELATIONS
      .filter(relation => relation.authority === "SOURCE_WORKBOOK_CONFIRMED")
      .map(relation => ({tag:relation.tag,fruitA:relation.fruitA,fruitB:relation.fruitB,primaryAttribute:relation.primaryAttribute})),
  },
  coreB: {
    relationStatus: "ENGINEERING_COMPATIBILITY_UNAPPROVED",
    source: "NO_EXACT_PAIR_TABLE_IN_V1.5_OR_V1.4_WORKBOOK",
    relationUseApproved: false,
    productionGate: "BLOCK_UNTIL_PRODUCT_AND_ART_APPROVE_FINAL_SPRITES_AND_PAIR_MATRIX",
    pairs: FRUIT_SIMILARITY_RELATIONS
      .filter(relation => relation.authority === "ENGINEERING_COMPATIBILITY_UNAPPROVED")
      .map(relation => ({tag:relation.tag,fruitA:relation.fruitA,fruitB:relation.fruitB,primaryAttribute:relation.primaryAttribute})),
  },
} satisfies FruitContentQualification);

function tagsForFruit(fruitId: FruitId): string[] {
  return FRUIT_SIMILARITY_RELATIONS
    .filter(relation => relation.fruitA === fruitId || relation.fruitB === fruitId)
    .map(relation => relation.tag);
}

export const FRUIT_CATALOG: readonly FruitDefinition[] = immutableSnapshot([
  {fruitId:"APPLE",displayNameZh:"苹果",assetPath:"assets/fruits/apple.png",mainColorHex:"#D94141",outlineShape:"ROUND_STEM",textureCue:"SMOOTH_LEAF",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("APPLE")},
  {fruitId:"BANANA",displayNameZh:"香蕉",assetPath:"assets/fruits/banana.png",mainColorHex:"#F2CF45",outlineShape:"CURVED_CRESCENT",textureCue:"RIDGED_TIPS",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("BANANA")},
  {fruitId:"ORANGE",displayNameZh:"橙子",assetPath:"assets/fruits/orange.png",mainColorHex:"#F28B2D",outlineShape:"ROUND_LEAF",textureCue:"DIMPLED_PEEL",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("ORANGE")},
  {fruitId:"PEAR",displayNameZh:"梨",assetPath:"assets/fruits/pear.png",mainColorHex:"#A8C957",outlineShape:"BELL_STEM",textureCue:"SPECKLED_SMOOTH",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("PEAR")},
  {fruitId:"STRAWBERRY",displayNameZh:"草莓",assetPath:"assets/fruits/strawberry.png",mainColorHex:"#E84655",outlineShape:"HEART_LEAF_CROWN",textureCue:"SEEDED",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("STRAWBERRY")},
  {fruitId:"GRAPE",displayNameZh:"葡萄",assetPath:"assets/fruits/grape.png",mainColorHex:"#7550A6",outlineShape:"CLUSTER",textureCue:"ROUND_SEEDED_CLUSTER",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("GRAPE")},
  {fruitId:"WATERMELON",displayNameZh:"西瓜",assetPath:"assets/fruits/watermelon.png",mainColorHex:"#4DAD66",outlineShape:"ROUND_STRIPED",textureCue:"STRIPED_RIND",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("WATERMELON")},
  {fruitId:"PINEAPPLE",displayNameZh:"菠萝",assetPath:"assets/fruits/pineapple.png",mainColorHex:"#E8B83D",outlineShape:"OVAL_CROWN",textureCue:"DIAMOND_TEXTURE",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("PINEAPPLE")},
  {fruitId:"PEACH",displayNameZh:"桃",assetPath:"assets/fruits/peach.png",mainColorHex:"#F19B75",outlineShape:"ROUND_CLEFT_LEAF",textureCue:"SOFT_SMOOTH",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("PEACH")},
  {fruitId:"LEMON",displayNameZh:"柠檬",assetPath:"assets/fruits/lemon.png",mainColorHex:"#EAD94C",outlineShape:"OVAL_POINTED",textureCue:"DIMPLED_PEEL",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("LEMON")},
  {fruitId:"CHERRY",displayNameZh:"樱桃",assetPath:"assets/fruits/cherry.png",mainColorHex:"#B92D3A",outlineShape:"TWIN_ROUND_STEMS",textureCue:"GLOSSY_SMOOTH",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("CHERRY")},
  {fruitId:"MANGO",displayNameZh:"芒果",assetPath:"assets/fruits/mango.png",mainColorHex:"#E99A35",outlineShape:"ASYMMETRIC_OVAL",textureCue:"SMOOTH_GRADIENT",targetAllowed:true,distractorAllowed:true,similarityTags:tagsForFruit("MANGO")},
] satisfies FruitDefinition[]);

export const FRUIT_POOLS: Readonly<Record<FruitPoolId, readonly FruitId[]>> = immutableSnapshot({
  FP_CORE_A: ["APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE"],
  FP_CORE_B: ["WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO"],
  FP_TRANSFER: ["APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE", "WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO"],
} satisfies Record<FruitPoolId, FruitId[]>);

const FRUIT_BY_ID = new Map(FRUIT_CATALOG.map(fruit => [fruit.fruitId, fruit]));

export function fruitDefinition(fruitId: FruitId): FruitDefinition {
  const value = FRUIT_BY_ID.get(fruitId);
  if (value === undefined) throw new Error(`unknown fruitId: ${fruitId}`);
  return value;
}

export function fruitsAreSimilar(a: FruitId, b: FruitId): boolean {
  if (a === b) return false;
  return FRUIT_SIMILARITY_RELATIONS.some(relation =>
    (relation.fruitA === a && relation.fruitB === b)
      || (relation.fruitA === b && relation.fruitB === a),
  );
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
  return immutableSnapshot({gridId, rows, cols, slots});
}

export const GRID_CATALOG: readonly GridDefinition[] = immutableSnapshot([
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

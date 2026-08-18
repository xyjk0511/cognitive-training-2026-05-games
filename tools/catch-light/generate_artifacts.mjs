#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");
const modulePath = resolve(root, "typescript/dist/games/catch-light/index.js");
const {
  CATCH_LIGHT_VERTICAL_SLICE_CONFIG,
  CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
  CATCH_LIGHT_RUNTIME_SLICE_LEVELS,
  CATCH_LIGHT_GOLDEN_ANCHOR_LEVELS,
  buildGoldenVectors,
  buildHeadlessEvidence,
} = await import(modulePath);

const mode = process.argv.includes("--check") ? "check" : "write";
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const normalized = value => JSON.parse(JSON.stringify(value));

const configText = pretty(normalized(CATCH_LIGHT_VERTICAL_SLICE_CONFIG));
const goldenText = pretty(normalized(buildGoldenVectors()));
const evidenceText = pretty({
  evidenceVersion: "A620-W2-CATCH-LIGHT-HEADLESS-1",
  scenarios: buildHeadlessEvidence().map(result => ({
    name: result.name,
    level: result.level,
    policy: result.policy,
    eligibleBatchTarget: result.eligibleBatchTarget,
    emittedBatchHashes: result.batchEvents.map(batch => batch.batchPayloadSha256),
    payload: result.payload,
  })),
});

const bundleIndexText = pretty({
  gameCode: "CATCH_LIGHT",
  entryScene: "CatchLightEntry",
  status: "W2_HEADLESS_VERTICAL_SLICES",
  domainEntry: "typescript/src/games/catch-light/index.ts",
  configPath: "config/catch-light-v1.5-w2.json",
  goldenVectorPath: "golden/A620_W2_CATCH_LIGHT_golden_vectors.json",
  backgroundIndexPath: "assets/backgrounds/index.json",
  gameConfigSchemaId: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.gameConfigSchemaId,
  generatorVersion: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.generatorVersion,
  scoringRuleVersion: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.scoringRuleVersion,
  resultSchemaVersion: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.resultSchemaVersion,
  configSetId: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.configSetId,
  compiledConfigCanonicalSha256: CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256,
  sourceWorkbookName: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.sourceWorkbookName,
  sourceWorkbookSha256: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.sourceWorkbookSha256,
  sourceWorkbookRole: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.sourceWorkbookRole,
  sourceRequirementSha256: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.sourceRequirementSha256,
  publicRulesSha256: CATCH_LIGHT_VERTICAL_SLICE_CONFIG.publicRulesSha256,
  runtimeConfigHashDeclaration: {
    mode: "SESSION_SCOPED_ANDROID_PREPARE",
    algorithm: "SHA-256",
    canonicalization: "A620_CANONICAL_JSON",
    projection: "PREPARE_PAYLOAD_EXCLUDING_RUNTIME_CONFIG_HASH",
    staticValueApplicable: false,
  },
  implementedLevels: CATCH_LIGHT_RUNTIME_SLICE_LEVELS,
  goldenOnlyAdditionalLevel: CATCH_LIGHT_GOLDEN_ANCHOR_LEVELS.filter(level => !CATCH_LIGHT_RUNTIME_SLICE_LEVELS.includes(level)),
  cocosSceneStatus: "NOT_INCLUDED_IN_W2",
  fruitSpriteStatus: "PLACEHOLDER_REFERENCES_ONLY",
});

const tracked = [
  [resolve(root, "games/catch-light/configs/vertical-slices/catch-light-v1.5-w2.json"), configText],
  [resolve(root, "packages/catch-light/content/config/catch-light-v1.5-w2.json"), configText],
  [resolve(root, "games/catch-light/golden-vectors/A620_W2_CATCH_LIGHT_golden_vectors.json"), goldenText],
  [resolve(root, "packages/catch-light/content/golden/A620_W2_CATCH_LIGHT_golden_vectors.json"), goldenText],
  [resolve(root, "packages/catch-light/content/bundle/index.json"), bundleIndexText],
];

for (const [path, expected] of tracked) {
  mkdirSync(dirname(path), {recursive:true});
  if (mode === "write") {
    writeFileSync(path, expected, "utf8");
  } else {
    let actual;
    try { actual = readFileSync(path, "utf8"); }
    catch { throw new Error(`generated artifact is missing: ${path}`); }
    if (actual !== expected) throw new Error(`generated artifact is stale: ${path}`);
  }
}

const evidencePath = resolve(root, "build/catch-light/A620_W2_CATCH_LIGHT_headless_results.json");
mkdirSync(dirname(evidencePath), {recursive:true});
writeFileSync(evidencePath, evidenceText, "utf8");
console.log(`CATCH_LIGHT_ARTIFACTS_${mode.toUpperCase()}_PASS`);
console.log(`HEADLESS_EVIDENCE=${evidencePath}`);

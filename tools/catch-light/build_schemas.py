#!/usr/bin/env python3
from __future__ import annotations
import json
import sys
from pathlib import Path

MODE = "check" if "--check" in sys.argv else "write"

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "games/catch-light/schemas"
OUT.mkdir(parents=True, exist_ok=True)
FRUITS = ["APPLE","BANANA","ORANGE","PEAR","STRAWBERRY","GRAPE","WATERMELON","PINEAPPLE","PEACH","LEMON","CHERRY","MANGO"]
HASH = {"type":"string","pattern":"^[0-9a-f]{64}$"}
NONNEG = {"type":"integer","minimum":0,"maximum":1000000}
SAFE_NONNEG = {"type":"integer","minimum":0,"maximum":9007199254740991}

def write(name: str, value: dict) -> None:
    path = OUT / name
    expected = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if MODE == "check":
        if not path.exists():
            raise FileNotFoundError(f"generated schema is missing: {path}")
        if path.read_text(encoding="utf-8") != expected:
            raise RuntimeError(f"generated schema is stale: {path}")
    else:
        path.write_text(expected, encoding="utf-8")

fruit = {
    "type":"object",
    "required":["fruitId","displayNameZh","assetPath","mainColorHex","outlineShape","textureCue","targetAllowed","distractorAllowed","similarityTags"],
    "properties":{
        "fruitId":{"enum":FRUITS},
        "displayNameZh":{"type":"string","minLength":1,"maxLength":16},
        "assetPath":{"type":"string","pattern":"^assets/fruits/[a-z-]+\\.png$"},
        "mainColorHex":{"type":"string","pattern":"^#[0-9A-F]{6}$"},
        "outlineShape":{"type":"string","pattern":"^[A-Z0-9_]+$"},
        "textureCue":{"type":"string","pattern":"^[A-Z0-9_]+$"},
        "targetAllowed":{"const":True},
        "distractorAllowed":{"const":True},
        "similarityTags":{"type":"array","minItems":2,"maxItems":8,"uniqueItems":True,"items":{"type":"string","pattern":"^SIM_[A-Z0-9_]+$"}},
    },
    "additionalProperties":False,
}
slot = {
    "type":"object",
    "required":["slotId","row","col","xBasisPoints","yBasisPoints","edgeSlot","minHitWidthDp","minHitHeightDp"],
    "properties":{
        "slotId":{"type":"string","pattern":"^R[1-3]C[1-4]$"},
        "row":{"type":"integer","minimum":1,"maximum":3},
        "col":{"type":"integer","minimum":1,"maximum":4},
        "xBasisPoints":{"type":"integer","minimum":1,"maximum":9999},
        "yBasisPoints":{"type":"integer","minimum":1,"maximum":9999},
        "edgeSlot":{"type":"boolean"},
        "minHitWidthDp":{"type":"integer","minimum":56,"maximum":512},
        "minHitHeightDp":{"type":"integer","minimum":56,"maximum":512},
    },
    "additionalProperties":False,
}
grid = {
    "type":"object",
    "required":["gridId","rows","cols","slots"],
    "properties":{
        "gridId":{"enum":["2x2","2x3","3x3","3x4"]},
        "rows":{"type":"integer","enum":[2,3]},
        "cols":{"type":"integer","enum":[2,3,4]},
        "slots":{"type":"array","minItems":4,"maxItems":12,"uniqueItems":True,"items":slot},
    },
    "additionalProperties":False,
}
wave_profile = {
    "type":"object",
    "required":["waveProfileId","targetsByWave","distractorsByWave"],
    "properties":{
        "waveProfileId":{"type":"string","pattern":"^W[0-9A-Z-]+$"},
        "targetsByWave":{"type":"array","minItems":8,"maxItems":8,"items":{"type":"integer","minimum":1,"maximum":5}},
        "distractorsByWave":{"type":"array","minItems":8,"maxItems":8,"items":{"type":"integer","minimum":0,"maximum":2}},
    },
    "additionalProperties":False,
}
level_required = [
    "level","difficultyStateId","stageNo","timingBand","repetitionIndex","repetitionRole","contentVariantId","fruitPoolId","waveRotation","backgroundId","gridId",
    "waveCount","roundActiveMs","firstWaveMs","waveSpacingMs","stimulusLifecycleMs","enterAnimationMs","activeHoldMs","exitAnimationMs","interWaveBlankMs","postLastBufferMs","hitFeedbackMs",
    "targetTotal","distractorTotal","sameScreenCap","waveProfileId","coexistWaveCount","peakWaveCount","similarDistractorCount","targetFarEdgeCount","distractorFarEdgeCount",
    "doubleTargetCount","doubleWindowMs","doublePatternId","minTargetHits","upgradeFalseLimit","holdFalseLimit","scoringProfileId","layoutPoolId","seedKey","ruleIntroFlag","backgroundLockRule","interactionProfileId",
]
level = {
    "type":"object",
    "required":level_required,
    "properties":{
        "level":{"type":"integer","minimum":1,"maximum":120},
        "difficultyStateId":{"type":"string","pattern":"^DS[0-9]{2}$"},
        "stageNo":{"type":"integer","minimum":1,"maximum":16},
        "timingBand":{"enum":["A","C","H"]},
        "repetitionIndex":{"type":"integer","minimum":1,"maximum":8},
        "repetitionRole":{"type":"string","minLength":1,"maxLength":16},
        "contentVariantId":{"type":"string","pattern":"^DS[0-9]{2}-V[0-9]+$"},
        "fruitPoolId":{"enum":["FP_CORE_A","FP_CORE_B","FP_TRANSFER"]},
        "waveRotation":{"type":"integer","minimum":0,"maximum":7},
        "backgroundId":{"type":"string","pattern":"^BG0[1-8]$"},
        "gridId":{"enum":["2x2","2x3","3x3","3x4"]},
        "waveCount":{"const":8},
        "roundActiveMs":{"const":30000},
        "firstWaveMs":{"const":500},
        "waveSpacingMs":{"const":3650},
        "stimulusLifecycleMs":{"enum":[3100,3200,3300]},
        "enterAnimationMs":{"const":200},
        "activeHoldMs":{"enum":[2700,2800,2900]},
        "exitAnimationMs":{"const":200},
        "interWaveBlankMs":{"enum":[350,450,550]},
        "postLastBufferMs":{"enum":[650,750,850]},
        "hitFeedbackMs":{"const":300},
        "targetTotal":{"enum":[10,15,20,25]},
        "distractorTotal":{"enum":[0,5,10]},
        "sameScreenCap":{"type":"integer","minimum":2,"maximum":5},
        "waveProfileId":{"type":"string","pattern":"^W[0-9A-Z-]+$"},
        "coexistWaveCount":{"type":"integer","minimum":0,"maximum":8},
        "peakWaveCount":{"type":"integer","minimum":0,"maximum":8},
        "similarDistractorCount":{"type":"integer","minimum":0,"maximum":10},
        "targetFarEdgeCount":{"type":"integer","minimum":0,"maximum":25},
        "distractorFarEdgeCount":{"type":"integer","minimum":0,"maximum":10},
        "doubleTargetCount":{"type":"integer","minimum":0,"maximum":6},
        "doubleWindowMs":{"enum":[0,1200,1300,1400,1500]},
        "doublePatternId":{"enum":["NONE","SEP_NO_W1","MAX2_CONSEC","MAX3_CONSEC"]},
        "minTargetHits":{"type":"integer","minimum":1,"maximum":25},
        "upgradeFalseLimit":{"type":"integer","minimum":0,"maximum":2},
        "holdFalseLimit":{"type":"integer","minimum":0,"maximum":3},
        "scoringProfileId":{"enum":["SC_NO_DISTRACTOR","SC_WITH_DISTRACTOR"]},
        "layoutPoolId":{"type":"string","pattern":"^LP_S[0-9]{2}_[ACH]_V[0-9]+$"},
        "seedKey":{"type":"string","pattern":"^CL-L[0-9]{3}-DS[0-9]{2}-V[0-9]+$"},
        "ruleIntroFlag":{"enum":["FULL_RULE","DISTRACTOR_RULE","NONE","DOUBLE_RULE"]},
        "backgroundLockRule":{"const":"HIGHEST_UNLOCKED_CHAPTER_SESSION_LOCK"},
        "interactionProfileId":{"const":"CL_CHILD_V1"},
    },
    "additionalProperties":False,
}
formal_config = {
    "type":"object",
    "required":[
        "schemaVersion","gameCode","gameConfigSchemaId","generatorVersion","scoringRuleVersion","resultSchemaVersion",
        "durationMs","plannedBatchCount","designMaxLevel","qaSeed","configSetId",
        "sourceWorkbookName","sourceWorkbookSha256","sourceWorkbookRole","sourceRequirementSha256","publicRulesSha256",
        "fruitCatalogVersion","layoutCatalogVersion","fruitCatalog","fruitPools","grids","waveProfiles","levels",
    ],
    "properties":{
        "schemaVersion":{"const":"1.5.0"},
        "gameCode":{"const":"CATCH_LIGHT"},
        "gameConfigSchemaId":{"const":"urn:a620:catch-light:config:1.5"},
        "generatorVersion":{"const":"catch-light-gen-1"},
        "scoringRuleVersion":{"const":"1.5.0"},
        "resultSchemaVersion":{"const":"A620-TRR-1.1"},
        "durationMs":{"const":300000},
        "plannedBatchCount":{"const":8},
        "designMaxLevel":{"const":120},
        "qaSeed":{"const":20260817},
        "configSetId":{"const":"catch-light-v1.5-w2-vertical-slices"},
        "sourceWorkbookName":{"const":"捕光行动-120级数值设计-v1.4.xlsx"},
        "sourceWorkbookSha256":{"const":"592a6313bb3f308aa63d5e1313db98b617dfc735ac8fd61efb7c7f06112d716d"},
        "sourceWorkbookRole":{"const":"HISTORICAL_NUMERIC_INPUT_ONLY"},
        "sourceRequirementSha256":{"const":"1ff1d38470aead2270d6b237b3cda2a21a7540174420252a5bda8b242bfb425c"},
        "publicRulesSha256":{"const":"c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794"},
        "fruitCatalogVersion":{"const":"catch-light-fruit-catalog-1"},
        "layoutCatalogVersion":{"const":"catch-light-grid-catalog-1"},
        "fruitCatalog":{"type":"array","minItems":12,"maxItems":12,"items":fruit},
        "fruitPools":{
            "type":"object","required":["FP_CORE_A","FP_CORE_B","FP_TRANSFER"],
            "properties":{
                "FP_CORE_A":{"type":"array","minItems":6,"maxItems":6,"uniqueItems":True,"items":{"enum":FRUITS}},
                "FP_CORE_B":{"type":"array","minItems":6,"maxItems":6,"uniqueItems":True,"items":{"enum":FRUITS}},
                "FP_TRANSFER":{"type":"array","minItems":12,"maxItems":12,"uniqueItems":True,"items":{"enum":FRUITS}},
            },"additionalProperties":False,
        },
        "grids":{"type":"array","minItems":4,"maxItems":4,"items":grid},
        "waveProfiles":{"type":"array","minItems":5,"maxItems":32,"items":wave_profile},
        "levels":{"type":"array","minItems":1,"maxItems":120,"items":level},
    },
    "additionalProperties":False,
}
write("game_config.schema.json", {
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "$id":"urn:a620:catch-light:config:1.5",
    "title":"CATCH_LIGHT Game Config 1.5",
    "description":"The empty branch exists only for inherited Gate 0 vectors; W2 runtime validation rejects it.",
    "oneOf":[{"type":"object","maxProperties":0,"additionalProperties":False}, formal_config],
})

batch_props = {
    "metricsVersion":{"const":"catch-light-batch-metrics-1"},
    "H":{"type":"integer","minimum":0,"maximum":25},
    "T":{"type":"integer","minimum":1,"maximum":25},
    "F":{"type":"integer","minimum":0,"maximum":10},
    "D":{"enum":[0,5,10]},
    "targetFruitId":{"enum":FRUITS},
    "backgroundId":{"type":"string","pattern":"^BG0[1-8]$"},
    "configSetId":{"const":"catch-light-v1.5-w2-vertical-slices"},
    "generatorVersion":{"const":"catch-light-gen-1"},
    "difficultyStateId":{"type":"string","pattern":"^DS[0-9]{2}$"},
    "timingProfile":{"enum":["A","C","H"]},
    "contentVariantId":{"type":"string","pattern":"^DS[0-9]{2}-V[0-9]+$"},
    "waveProfileId":{"type":"string","pattern":"^W[0-9A-Z-]+$"},
    "seedKey":{"type":"string","pattern":"^CL-L[0-9]{3}-DS[0-9]{2}-V[0-9]+$"},
    "scheduleSha256":HASH,
    "instanceAuditSha256":HASH,
    "targetTimeouts":{"type":"integer","minimum":0,"maximum":25},
    "distractorAvoided":{"type":"integer","minimum":0,"maximum":10},
    "doubleTargets":{"type":"integer","minimum":0,"maximum":6},
    "doubleCompleted":{"type":"integer","minimum":0,"maximum":6},
    "doubleFirstOnly":{"type":"integer","minimum":0,"maximum":6},
    "totalObjectTouches":NONNEG,
    "blankTouches":NONNEG,
    "duplicateTouches":NONNEG,
    "consecutiveFailBefore":{"enum":[0,1]},
    "consecutiveFailAfter":{"enum":[0,1]},
}
formal_batch_required = list(batch_props)
legacy_batch = {
    "type":"object","required":["H","T","F","D"],
    "properties":{k:batch_props[k] for k in ["H","T","F","D"]},
    "maxProperties":4,"additionalProperties":False,
}
write("game_batch_metrics.schema.json", {
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "$id":"urn:a620:catch-light:batch-metrics:1.5",
    "title":"CATCH_LIGHT Batch Metrics 1.5",
    "oneOf":[legacy_batch,{"type":"object","required":formal_batch_required,"properties":batch_props,"additionalProperties":False}],
})

session_props = {
    "metricsVersion":{"const":"catch-light-session-metrics-1"},
    "passEngineType":{"const":"PE-EVENT"},
    "configSetId":{"const":"catch-light-v1.5-w2-vertical-slices"},
    "generatorVersion":{"const":"catch-light-gen-1"},
    "scoringRuleVersion":{"const":"1.5.0"},
    "resultSchemaVersion":{"const":"A620-TRR-1.1"},
    "sessionSeed":{"type":"integer","minimum":0,"maximum":9007199254740991},
    "backgroundId":{"type":"string","pattern":"^BG0[1-8]$"},
    "pauseCount":SAFE_NONNEG,
    "totalPausedDurationMs":SAFE_NONNEG,
    "eligibleBatchCount":{"type":"integer","minimum":0,"maximum":8},
    "incompleteBatchCount":{"type":"integer","minimum":0,"maximum":1},
    "H":{"type":"integer","minimum":0,"maximum":200},
    "T":{"type":"integer","minimum":0,"maximum":200},
    "F":{"type":"integer","minimum":0,"maximum":80},
    "D":{"type":"integer","minimum":0,"maximum":80},
    "eligibleTargetInstances":{"type":"integer","minimum":0,"maximum":200},
    "eligibleTargetHits":{"type":"integer","minimum":0,"maximum":200},
    "eligibleDistractorInstances":{"type":"integer","minimum":0,"maximum":80},
    "eligibleDistractorFalseTouches":{"type":"integer","minimum":0,"maximum":80},
    "eligibleDoubleTargets":{"type":"integer","minimum":0,"maximum":48},
    "eligibleDoubleCompleted":{"type":"integer","minimum":0,"maximum":48},
    "totalObjectTouches":NONNEG,
    "blankTouches":NONNEG,
    "duplicateTouches":NONNEG,
    "hitRateBasisPoints":{"oneOf":[{"type":"integer","minimum":0,"maximum":10000},{"type":"null"}]},
    "distractorAvoidanceBasisPoints":{"oneOf":[{"type":"integer","minimum":0,"maximum":10000},{"type":"null"}]},
    "scheduleAuditSha256":HASH,
}
write("game_metrics.schema.json", {
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "$id":"urn:a620:catch-light:game-metrics:1.5",
    "title":"CATCH_LIGHT Session Metrics 1.5",
    "oneOf":[
        {"type":"object","properties":{"totalTouches":NONNEG},"maxProperties":1,"additionalProperties":False},
        {"type":"object","required":list(session_props),"properties":session_props,"additionalProperties":False},
    ],
})

partial_props = {
    "metricsVersion":{"const":"catch-light-partial-metrics-1"},
    "phase":{"enum":["PROMPT","OPERATION","FEEDBACK","TRANSITION"]},
    "waveOrdinal":{"type":"integer","minimum":0,"maximum":8},
    "presentedTargetCount":{"type":"integer","minimum":0,"maximum":25},
    "presentedDistractorCount":{"type":"integer","minimum":0,"maximum":10},
    "H":{"type":"integer","minimum":0,"maximum":25},
    "F":{"type":"integer","minimum":0,"maximum":10},
    "unresolvedTargetCount":{"type":"integer","minimum":0,"maximum":25},
    "totalObjectTouches":NONNEG,
    "blankTouches":NONNEG,
    "scheduleSha256":HASH,
    "instanceAuditSha256":HASH,
}
write("partial_metrics.schema.json", {
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "$id":"urn:a620:catch-light:partial-metrics:1.5",
    "title":"CATCH_LIGHT Partial Batch Metrics 1.5",
    "oneOf":[
        {"type":"object","properties":{"waveOrdinal":{"type":"integer","minimum":1,"maximum":8}},"maxProperties":1,"additionalProperties":False},
        {"type":"object","required":list(partial_props),"properties":partial_props,"additionalProperties":False},
    ],
})

print(f"CATCH_LIGHT_SCHEMAS_{MODE.upper()}_PASS")

"use strict";
(() => {
  // src/generated-runtime-profiles.ts
  var JSON_MAX_DEPTH = 64;
  var JSON_MAX_TOTAL_NODES = 5e4;
  var JSON_MAX_OBJECT_MEMBERS = 2048;
  var JSON_MAX_ARRAY_ITEMS = 2048;
  var JSON_MAX_STRING_UTF8_BYTES = 262144;
  var JSON_MAX_OBJECT_KEY_UTF8_BYTES = 512;
  var JSON_MAX_TOTAL_STRING_UTF8_BYTES = 1572864;
  var DELIVERY_RESPONSE_OBLIGATIONS = Object.freeze({
    "PREPARE": ["READY"],
    "START": ["COMMAND_ACCEPTED", "STARTED"],
    "PAUSE": ["COMMAND_ACCEPTED", "PAUSED"],
    "RESUME": ["COMMAND_ACCEPTED", "RESUMED"],
    "TERMINATE": ["COMMAND_ACCEPTED", "TERMINATED"],
    "QUERY_STATE": ["STATE_SNAPSHOT"],
    "RESULT_READY": ["ACK_RESULT_COMMITTED"]
  });
  var WATCHDOG_TIMEOUTS_MS = Object.freeze({
    "prepareReady": 1e4,
    "commandAccepted": 100,
    "startConfirmationAfterBoundary": 1e3,
    "pauseConfirmationAfterBoundary": 1e3,
    "resumeConfirmationAfterBoundary": 1e3,
    "terminateConfirmationAfterBoundary": 1e3,
    "queryState": 1e3,
    "heartbeatInterval": 1e3,
    "heartbeatSilence": 3500,
    "finalizationResultReady": 5e3,
    "localResultCommit": 5e3
  });

  // src/canonical.ts
  var SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
  var A620_JSON_RESOURCE_LIMITS = Object.freeze({
    maxDepth: JSON_MAX_DEPTH,
    maxTotalNodes: JSON_MAX_TOTAL_NODES,
    maxObjectMembers: JSON_MAX_OBJECT_MEMBERS,
    maxArrayItems: JSON_MAX_ARRAY_ITEMS,
    maxStringUtf8Bytes: JSON_MAX_STRING_UTF8_BYTES,
    maxObjectKeyUtf8Bytes: JSON_MAX_OBJECT_KEY_UTF8_BYTES,
    maxTotalStringUtf8Bytes: JSON_MAX_TOTAL_STRING_UTF8_BYTES
  });
  function utf8Length(value) {
    return new TextEncoder().encode(value).length;
  }
  function assertWellFormedUtf16(value, path) {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 55296 && code <= 56319) {
        const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
        if (next < 56320 || next > 57343) {
          throw new Error(`${path}[${i}]: unpaired high surrogate is forbidden`);
        }
        i += 1;
        continue;
      }
      if (code >= 56320 && code <= 57343) {
        throw new Error(`${path}[${i}]: unpaired low surrogate is forbidden`);
      }
    }
  }
  function accountString(value, path, byteLimit, budget) {
    assertWellFormedUtf16(value, path);
    const size = utf8Length(value);
    if (size > byteLimit) throw new Error(`${path}: UTF-8 string exceeds ${byteLimit} bytes`);
    budget.totalStringBytes += size;
    if (budget.totalStringBytes > A620_JSON_RESOURCE_LIMITS.maxTotalStringUtf8Bytes) {
      throw new Error("JSON total UTF-8 string budget exceeded");
    }
  }
  function assertValue(value, path = "$", depth = 0, budget) {
    const state2 = budget ?? { nodes: 0, totalStringBytes: 0, activeContainers: /* @__PURE__ */ new WeakSet() };
    if (depth > A620_JSON_RESOURCE_LIMITS.maxDepth) {
      throw new Error(`${path}: JSON nesting exceeds depth ${A620_JSON_RESOURCE_LIMITS.maxDepth}`);
    }
    state2.nodes += 1;
    if (state2.nodes > A620_JSON_RESOURCE_LIMITS.maxTotalNodes) {
      throw new Error(`${path}: JSON node budget exceeds ${A620_JSON_RESOURCE_LIMITS.maxTotalNodes}`);
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      accountString(value, path, A620_JSON_RESOURCE_LIMITS.maxStringUtf8Bytes, state2);
      return;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error(`${path}: only safe integers are allowed`);
      if (Object.is(value, -0)) throw new Error(`${path}: negative zero is forbidden`);
      return;
    }
    if (typeof value !== "object") {
      throw new Error(`${path}: unsupported JSON type ${typeof value}`);
    }
    if (state2.activeContainers.has(value)) throw new Error(`${path}: cyclic JSON value is forbidden`);
    state2.activeContainers.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > A620_JSON_RESOURCE_LIMITS.maxArrayItems) {
          throw new Error(`${path}: array exceeds ${A620_JSON_RESOURCE_LIMITS.maxArrayItems} items`);
        }
        value.forEach((v, i) => assertValue(v, `${path}[${i}]`, depth + 1, state2));
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path}: non-plain object is forbidden`);
      }
      const entries = Object.entries(value);
      if (entries.length > A620_JSON_RESOURCE_LIMITS.maxObjectMembers) {
        throw new Error(`${path}: object exceeds ${A620_JSON_RESOURCE_LIMITS.maxObjectMembers} members`);
      }
      for (const [key, child] of entries) {
        accountString(key, `${path}.<key>`, A620_JSON_RESOURCE_LIMITS.maxObjectKeyUtf8Bytes, state2);
        assertValue(child, `${path}.${key}`, depth + 1, state2);
      }
    } finally {
      state2.activeContainers.delete(value);
    }
  }
  function validateJsonResources(value) {
    assertValue(value);
  }
  function utf16Compare(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = a.charCodeAt(i) - b.charCodeAt(i);
      if (diff !== 0) return diff;
    }
    return a.length - b.length;
  }
  function emit(value) {
    if (value === null) return "null";
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(emit).join(",")}]`;
    const keys = Object.keys(value).sort(utf16Compare);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${emit(value[k])}`).join(",")}}`;
  }
  function canonicalUtf8(value) {
    assertValue(value);
    return new TextEncoder().encode(emit(value));
  }
  function canonicalString(value) {
    return new TextDecoder().decode(canonicalUtf8(value));
  }
  var SHA256_K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function rotr(value, shift) {
    return value >>> shift | value << 32 - shift;
  }
  function sha256Hex(input) {
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(input);
    padded[input.length] = 128;
    const bitLengthHigh = Math.floor(input.length / 536870912);
    const bitLengthLow = input.length * 8 >>> 0;
    const tail = new DataView(padded.buffer);
    tail.setUint32(paddedLength - 8, bitLengthHigh, false);
    tail.setUint32(paddedLength - 4, bitLengthLow, false);
    let h0 = 1779033703, h1 = 3144134277, h2 = 1013904242, h3 = 2773480762;
    let h4 = 1359893119, h5 = 2600822924, h6 = 528734635, h7 = 1541459225;
    const words = new Uint32Array(64);
    const view = new DataView(padded.buffer);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const w15 = words[i - 15];
        const w2 = words[i - 2];
        const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ w15 >>> 3) >>> 0;
        const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ w2 >>> 10) >>> 0;
        words[i] = words[i - 16] + s0 + words[i - 7] + s1 >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = (e & f ^ ~e & g) >>> 0;
        const t1 = h + s1 + ch + SHA256_K[i] + words[i] >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = (a & b ^ a & c ^ b & c) >>> 0;
        const t2 = s0 + maj >>> 0;
        h = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h0 = h0 + a >>> 0;
      h1 = h1 + b >>> 0;
      h2 = h2 + c >>> 0;
      h3 = h3 + d >>> 0;
      h4 = h4 + e >>> 0;
      h5 = h5 + f >>> 0;
      h6 = h6 + g >>> 0;
      h7 = h7 + h >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, "0")).join("");
  }
  function canonicalSha256(value) {
    return sha256Hex(canonicalUtf8(value));
  }

  // src/games/catch-light/types.ts
  var CATCH_LIGHT_GAME_CODE = "CATCH_LIGHT";
  var CATCH_LIGHT_CONFIG_VERSION = "1.5.0";
  var CATCH_LIGHT_GENERATOR_VERSION = "catch-light-gen-2";
  var CATCH_LIGHT_SCORING_RULE_VERSION = "1.5.0";
  var CATCH_LIGHT_RESULT_SCHEMA_VERSION = "A620-TRR-1.1";
  var CATCH_LIGHT_CONFIG_SCHEMA_ID = "urn:a620:catch-light:config:1.5";
  var CATCH_LIGHT_CONFIG_SET_ID = "catch-light-v1.5-w2-vertical-slices-r2";
  var CATCH_LIGHT_QA_SEED = 20260817;
  var CATCH_LIGHT_RUNTIME_SLICE_LEVELS = [1, 28, 102, 120];
  var CATCH_LIGHT_SOURCE_WORKBOOK_NAME = "\u6355\u5149\u884C\u52A8-120\u7EA7\u6570\u503C\u8BBE\u8BA1-v1.4.xlsx";
  var CATCH_LIGHT_SOURCE_WORKBOOK_SHA256 = "592a6313bb3f308aa63d5e1313db98b617dfc735ac8fd61efb7c7f06112d716d";
  var CATCH_LIGHT_SOURCE_WORKBOOK_ROLE = "HISTORICAL_NUMERIC_INPUT_ONLY";
  var CATCH_LIGHT_REQUIREMENT_SHA256 = "1ff1d38470aead2270d6b237b3cda2a21a7540174420252a5bda8b242bfb425c";
  var A620_PUBLIC_RULES_SHA256 = "c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794";
  var SESSION_DURATION_MS = 3e5;
  var PLANNED_BATCH_COUNT = 8;
  var BATCH_DURATION_MS = 37500;
  var PROMPT_DURATION_MS = 3e3;
  var OPERATION_DURATION_MS = 3e4;
  var FEEDBACK_DURATION_MS = 2e3;
  var TRANSITION_DURATION_MS = 2500;
  var WAVE_COUNT = 8;
  var FIRST_WAVE_MS = 500;
  var WAVE_ONSET_INTERVAL_MS = 3650;
  var ENTER_ANIMATION_MS = 200;
  var EXIT_ANIMATION_MS = 200;
  var HIT_FEEDBACK_MS = 300;
  var DESIGN_MAX_LEVEL = 120;

  // src/games/catch-light/immutability.ts
  function cloneJsonValue(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = cloneJsonValue(child);
    return copy;
  }
  function freezeJsonValue(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      for (const child of value) freezeJsonValue(child);
    } else {
      for (const child of Object.values(value)) freezeJsonValue(child);
    }
    return Object.freeze(value);
  }
  function deepFreezeInPlace(value) {
    validateJsonResources(value);
    return freezeJsonValue(value);
  }
  function immutableSnapshot(value) {
    validateJsonResources(value);
    return freezeJsonValue(cloneJsonValue(value));
  }
  function isDeepFrozenJson(value) {
    validateJsonResources(value);
    const visit = (node) => {
      if (node === null || typeof node !== "object") return true;
      if (!Object.isFrozen(node)) return false;
      return Array.isArray(node) ? node.every(visit) : Object.values(node).every(visit);
    };
    return visit(value);
  }

  // src/games/catch-light/assets.ts
  var FRUIT_SIMILARITY_RELATIONS = immutableSnapshot([
    { tag: "SIM_COLOR_APPLE_STRAWBERRY", fruitA: "APPLE", fruitB: "STRAWBERRY", primaryAttribute: "COLOR", authority: "SOURCE_WORKBOOK_CONFIRMED" },
    { tag: "SIM_SHAPE_APPLE_ORANGE", fruitA: "APPLE", fruitB: "ORANGE", primaryAttribute: "SHAPE", authority: "SOURCE_WORKBOOK_CONFIRMED" },
    { tag: "SIM_COLOR_BANANA_PEAR", fruitA: "BANANA", fruitB: "PEAR", primaryAttribute: "COLOR", authority: "SOURCE_WORKBOOK_CONFIRMED" },
    { tag: "SIM_COLOR_ORANGE_PEAR", fruitA: "ORANGE", fruitB: "PEAR", primaryAttribute: "COLOR", authority: "SOURCE_WORKBOOK_CONFIRMED" },
    { tag: "SIM_TEXTURE_STRAWBERRY_GRAPE", fruitA: "STRAWBERRY", fruitB: "GRAPE", primaryAttribute: "TEXTURE", authority: "SOURCE_WORKBOOK_CONFIRMED" },
    { tag: "SIM_SHAPE_WATERMELON_PEACH", fruitA: "WATERMELON", fruitB: "PEACH", primaryAttribute: "SHAPE", authority: "ENGINEERING_COMPATIBILITY_UNAPPROVED" },
    { tag: "SIM_TEXTURE_LEMON_WATERMELON", fruitA: "LEMON", fruitB: "WATERMELON", primaryAttribute: "TEXTURE", authority: "ENGINEERING_COMPATIBILITY_UNAPPROVED" },
    { tag: "SIM_SHAPE_MANGO_PINEAPPLE", fruitA: "MANGO", fruitB: "PINEAPPLE", primaryAttribute: "SHAPE", authority: "ENGINEERING_COMPATIBILITY_UNAPPROVED" },
    { tag: "SIM_COLOR_PINEAPPLE_LEMON", fruitA: "PINEAPPLE", fruitB: "LEMON", primaryAttribute: "COLOR", authority: "ENGINEERING_COMPATIBILITY_UNAPPROVED" },
    { tag: "SIM_TEXTURE_PEACH_CHERRY", fruitA: "PEACH", fruitB: "CHERRY", primaryAttribute: "TEXTURE", authority: "ENGINEERING_COMPATIBILITY_UNAPPROVED" },
    { tag: "SIM_COLOR_CHERRY_MANGO", fruitA: "CHERRY", fruitB: "MANGO", primaryAttribute: "COLOR", authority: "ENGINEERING_COMPATIBILITY_UNAPPROVED" }
  ]);
  var FRUIT_CONTENT_QUALIFICATION = immutableSnapshot({
    qualificationVersion: "catch-light-fruit-content-qualification-1",
    runtimeUseStatus: "HEADLESS_VERTICAL_SLICE_ONLY",
    productionActivationStatus: "BLOCKED_PENDING_FRUIT_SPRITES_AND_CORE_B_RELATION_APPROVAL",
    fruitMetadataStatus: "ENGINEERING_PLACEHOLDER_PENDING_ART_QA",
    fruitSpriteStatus: "PLACEHOLDER_REFERENCES_ONLY",
    coreA: {
      relationStatus: "SOURCE_WORKBOOK_CONFIRMED",
      source: "\u6355\u5149\u884C\u52A8-120\u7EA7\u6570\u503C\u8BBE\u8BA1-v1.4.xlsx/\u6C34\u679C\u76F8\u4F3C\u5173\u7CFB",
      relationUseApproved: true,
      productionGate: "NONE",
      pairs: FRUIT_SIMILARITY_RELATIONS.filter((relation) => relation.authority === "SOURCE_WORKBOOK_CONFIRMED").map((relation) => ({ tag: relation.tag, fruitA: relation.fruitA, fruitB: relation.fruitB, primaryAttribute: relation.primaryAttribute }))
    },
    coreB: {
      relationStatus: "ENGINEERING_COMPATIBILITY_UNAPPROVED",
      source: "NO_EXACT_PAIR_TABLE_IN_V1.5_OR_V1.4_WORKBOOK",
      relationUseApproved: false,
      productionGate: "BLOCK_UNTIL_PRODUCT_AND_ART_APPROVE_FINAL_SPRITES_AND_PAIR_MATRIX",
      pairs: FRUIT_SIMILARITY_RELATIONS.filter((relation) => relation.authority === "ENGINEERING_COMPATIBILITY_UNAPPROVED").map((relation) => ({ tag: relation.tag, fruitA: relation.fruitA, fruitB: relation.fruitB, primaryAttribute: relation.primaryAttribute }))
    }
  });
  function tagsForFruit(fruitId) {
    return FRUIT_SIMILARITY_RELATIONS.filter((relation) => relation.fruitA === fruitId || relation.fruitB === fruitId).map((relation) => relation.tag);
  }
  var FRUIT_CATALOG = immutableSnapshot([
    { fruitId: "APPLE", displayNameZh: "\u82F9\u679C", assetPath: "assets/fruits/apple.png", mainColorHex: "#D94141", outlineShape: "ROUND_STEM", textureCue: "SMOOTH_LEAF", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("APPLE") },
    { fruitId: "BANANA", displayNameZh: "\u9999\u8549", assetPath: "assets/fruits/banana.png", mainColorHex: "#F2CF45", outlineShape: "CURVED_CRESCENT", textureCue: "RIDGED_TIPS", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("BANANA") },
    { fruitId: "ORANGE", displayNameZh: "\u6A59\u5B50", assetPath: "assets/fruits/orange.png", mainColorHex: "#F28B2D", outlineShape: "ROUND_LEAF", textureCue: "DIMPLED_PEEL", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("ORANGE") },
    { fruitId: "PEAR", displayNameZh: "\u68A8", assetPath: "assets/fruits/pear.png", mainColorHex: "#A8C957", outlineShape: "BELL_STEM", textureCue: "SPECKLED_SMOOTH", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("PEAR") },
    { fruitId: "STRAWBERRY", displayNameZh: "\u8349\u8393", assetPath: "assets/fruits/strawberry.png", mainColorHex: "#E84655", outlineShape: "HEART_LEAF_CROWN", textureCue: "SEEDED", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("STRAWBERRY") },
    { fruitId: "GRAPE", displayNameZh: "\u8461\u8404", assetPath: "assets/fruits/grape.png", mainColorHex: "#7550A6", outlineShape: "CLUSTER", textureCue: "ROUND_SEEDED_CLUSTER", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("GRAPE") },
    { fruitId: "WATERMELON", displayNameZh: "\u897F\u74DC", assetPath: "assets/fruits/watermelon.png", mainColorHex: "#4DAD66", outlineShape: "ROUND_STRIPED", textureCue: "STRIPED_RIND", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("WATERMELON") },
    { fruitId: "PINEAPPLE", displayNameZh: "\u83E0\u841D", assetPath: "assets/fruits/pineapple.png", mainColorHex: "#E8B83D", outlineShape: "OVAL_CROWN", textureCue: "DIAMOND_TEXTURE", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("PINEAPPLE") },
    { fruitId: "PEACH", displayNameZh: "\u6843", assetPath: "assets/fruits/peach.png", mainColorHex: "#F19B75", outlineShape: "ROUND_CLEFT_LEAF", textureCue: "SOFT_SMOOTH", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("PEACH") },
    { fruitId: "LEMON", displayNameZh: "\u67E0\u6AAC", assetPath: "assets/fruits/lemon.png", mainColorHex: "#EAD94C", outlineShape: "OVAL_POINTED", textureCue: "DIMPLED_PEEL", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("LEMON") },
    { fruitId: "CHERRY", displayNameZh: "\u6A31\u6843", assetPath: "assets/fruits/cherry.png", mainColorHex: "#B92D3A", outlineShape: "TWIN_ROUND_STEMS", textureCue: "GLOSSY_SMOOTH", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("CHERRY") },
    { fruitId: "MANGO", displayNameZh: "\u8292\u679C", assetPath: "assets/fruits/mango.png", mainColorHex: "#E99A35", outlineShape: "ASYMMETRIC_OVAL", textureCue: "SMOOTH_GRADIENT", targetAllowed: true, distractorAllowed: true, similarityTags: tagsForFruit("MANGO") }
  ]);
  var FRUIT_POOLS = immutableSnapshot({
    FP_CORE_A: ["APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE"],
    FP_CORE_B: ["WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO"],
    FP_TRANSFER: ["APPLE", "BANANA", "ORANGE", "PEAR", "STRAWBERRY", "GRAPE", "WATERMELON", "PINEAPPLE", "PEACH", "LEMON", "CHERRY", "MANGO"]
  });
  var FRUIT_BY_ID = new Map(FRUIT_CATALOG.map((fruit) => [fruit.fruitId, fruit]));
  function fruitDefinition(fruitId) {
    const value = FRUIT_BY_ID.get(fruitId);
    if (value === void 0) throw new Error(`unknown fruitId: ${fruitId}`);
    return value;
  }
  function fruitsAreSimilar(a, b) {
    if (a === b) return false;
    return FRUIT_SIMILARITY_RELATIONS.some(
      (relation) => relation.fruitA === a && relation.fruitB === b || relation.fruitA === b && relation.fruitB === a
    );
  }
  function buildGrid(gridId, rows, cols) {
    const slots = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        slots.push({
          slotId: `R${row + 1}C${col + 1}`,
          row: row + 1,
          col: col + 1,
          xBasisPoints: Math.round((col + 1) * 1e4 / (cols + 1)),
          yBasisPoints: Math.round((row + 1) * 1e4 / (rows + 1)),
          edgeSlot: col === 0 || col === cols - 1,
          minHitWidthDp: 120,
          minHitHeightDp: 120
        });
      }
    }
    return immutableSnapshot({ gridId, rows, cols, slots });
  }
  var GRID_CATALOG = immutableSnapshot([
    buildGrid("2x2", 2, 2),
    buildGrid("2x3", 2, 3),
    buildGrid("3x3", 3, 3),
    buildGrid("3x4", 3, 4)
  ]);
  var GRID_BY_ID = new Map(GRID_CATALOG.map((grid) => [grid.gridId, grid]));
  function gridDefinition(gridId) {
    const value = GRID_BY_ID.get(gridId);
    if (value === void 0) throw new Error(`unknown gridId: ${gridId}`);
    return value;
  }

  // src/games/catch-light/prng.ts
  var ZERO_STATE_REPLACEMENT = 1831565813;
  var UINT32_MAX = 4294967295;
  var UINT32_RANGE = 4294967296;
  function assertWellFormedUtf162(value, label) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 55296 && code <= 56319) {
        const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
        if (next < 56320 || next > 57343) throw new Error(`${label} contains an unpaired high surrogate`);
        index += 1;
      } else if (code >= 56320 && code <= 57343) {
        throw new Error(`${label} contains an unpaired low surrogate`);
      }
    }
  }
  function fnv1a32Utf8(value) {
    assertWellFormedUtf162(value, "FNV input");
    let hash = 2166136261;
    for (const byte of new TextEncoder().encode(value)) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  function seedMaterial(seedKey, sessionSeed, batchOrdinal, waveOrdinal) {
    if (seedKey.length === 0 || seedKey.includes("|") || /[\u0000-\u001f\u007f]/.test(seedKey)) {
      throw new Error("seedKey must be non-empty and must not contain separators or control characters");
    }
    assertWellFormedUtf162(seedKey, "seedKey");
    if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
    if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1) throw new Error("batchOrdinal must be a positive safe integer");
    if (!Number.isSafeInteger(waveOrdinal) || waveOrdinal < 0 || waveOrdinal > WAVE_COUNT) {
      throw new Error(`waveOrdinal must be in 0..${WAVE_COUNT}`);
    }
    return `${seedKey}|${sessionSeed}|${batchOrdinal}|${waveOrdinal}`;
  }
  var XorShift32 = class {
    state;
    constructor(seed) {
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) throw new Error("xorshift32 seed must be an unsigned 32-bit integer");
      const normalized = seed >>> 0;
      this.state = normalized === 0 ? ZERO_STATE_REPLACEMENT : normalized;
    }
    nextUint32() {
      let x = this.state;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.state = x >>> 0;
      return this.state;
    }
    nextIndex(exclusiveUpperBound) {
      if (!Number.isSafeInteger(exclusiveUpperBound) || exclusiveUpperBound <= 0 || exclusiveUpperBound > UINT32_RANGE) {
        throw new Error("exclusiveUpperBound must be a positive safe integer no greater than 2^32");
      }
      const acceptanceLimit = Math.floor(UINT32_RANGE / exclusiveUpperBound) * exclusiveUpperBound;
      let value;
      do
        value = this.nextUint32();
      while (value >= acceptanceLimit);
      return value % exclusiveUpperBound;
    }
    shuffle(values) {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = this.nextIndex(index + 1);
        const value = result[index];
        result[index] = result[swapIndex];
        result[swapIndex] = value;
      }
      return result;
    }
  };
  function prngFor(seedKey, sessionSeed, batchOrdinal, waveOrdinal) {
    const material = seedMaterial(seedKey, sessionSeed, batchOrdinal, waveOrdinal);
    const seed32 = fnv1a32Utf8(material);
    return { material, seed32, prng: new XorShift32(seed32) };
  }

  // src/games/catch-light/config.ts
  var WAVE_PROFILES = deepFreezeInPlace([
    { waveProfileId: "W10N", targetsByWave: [1, 1, 2, 1, 1, 2, 1, 1], distractorsByWave: [0, 0, 0, 0, 0, 0, 0, 0] },
    { waveProfileId: "W15D4", targetsByWave: [1, 2, 2, 2, 1, 2, 2, 3], distractorsByWave: [1, 0, 1, 0, 2, 0, 1, 0] },
    { waveProfileId: "W20D10-C6", targetsByWave: [3, 2, 3, 2, 3, 2, 3, 2], distractorsByWave: [0, 2, 1, 2, 0, 2, 1, 2] },
    { waveProfileId: "W25D10-C6", targetsByWave: [3, 3, 3, 3, 4, 3, 3, 3], distractorsByWave: [0, 2, 1, 2, 0, 2, 1, 2] },
    { waveProfileId: "W25D10-C8", targetsByWave: [2, 3, 3, 4, 3, 3, 4, 3], distractorsByWave: [1, 1, 2, 1, 1, 2, 1, 1] }
  ]);
  function lifecycleFor(band) {
    switch (band) {
      case "A":
        return { stimulusLifecycleMs: 3300, activeHoldMs: 2900, interWaveBlankMs: 350, postLastBufferMs: 650 };
      case "C":
        return { stimulusLifecycleMs: 3200, activeHoldMs: 2800, interWaveBlankMs: 450, postLastBufferMs: 750 };
      case "H":
        return { stimulusLifecycleMs: 3100, activeHoldMs: 2700, interWaveBlankMs: 550, postLastBufferMs: 850 };
    }
  }
  function level(input) {
    const timing = lifecycleFor(input.timingBand);
    return deepFreezeInPlace({
      ...input,
      waveCount: WAVE_COUNT,
      roundActiveMs: OPERATION_DURATION_MS,
      firstWaveMs: FIRST_WAVE_MS,
      waveSpacingMs: WAVE_ONSET_INTERVAL_MS,
      ...timing,
      enterAnimationMs: ENTER_ANIMATION_MS,
      exitAnimationMs: EXIT_ANIMATION_MS,
      hitFeedbackMs: HIT_FEEDBACK_MS,
      scoringProfileId: input.distractorTotal === 0 ? "SC_NO_DISTRACTOR" : "SC_WITH_DISTRACTOR",
      backgroundLockRule: "HIGHEST_UNLOCKED_CHAPTER_SESSION_LOCK",
      interactionProfileId: "CL_CHILD_V1"
    });
  }
  var VERTICAL_SLICE_LEVELS = deepFreezeInPlace([
    level({
      level: 1,
      difficultyStateId: "DS01",
      stageNo: 1,
      timingBand: "A",
      repetitionIndex: 1,
      repetitionRole: "\u65B0\u6388",
      contentVariantId: "DS01-V1",
      fruitPoolId: "FP_CORE_A",
      waveRotation: 0,
      backgroundId: "BG01",
      gridId: "2x2",
      targetTotal: 10,
      distractorTotal: 0,
      sameScreenCap: 2,
      waveProfileId: "W10N",
      coexistWaveCount: 0,
      peakWaveCount: 2,
      similarDistractorCount: 0,
      targetFarEdgeCount: 0,
      distractorFarEdgeCount: 0,
      doubleTargetCount: 0,
      doubleWindowMs: 0,
      doublePatternId: "NONE",
      firstTeachingBatchWaveOneDoubleDisabled: false,
      minTargetHits: 8,
      upgradeFalseLimit: 0,
      holdFalseLimit: 0,
      layoutPoolId: "LP_S01_A_V1",
      seedKey: "CL-L001-DS01-V1",
      ruleIntroFlag: "FULL_RULE"
    }),
    level({
      level: 28,
      difficultyStateId: "DS10",
      stageNo: 4,
      timingBand: "A",
      repetitionIndex: 1,
      repetitionRole: "\u65B0\u6388",
      contentVariantId: "DS10-V1",
      fruitPoolId: "FP_CORE_A",
      waveRotation: 0,
      backgroundId: "BG02",
      gridId: "2x3",
      targetTotal: 15,
      distractorTotal: 5,
      sameScreenCap: 3,
      waveProfileId: "W15D4",
      coexistWaveCount: 4,
      peakWaveCount: 4,
      similarDistractorCount: 0,
      targetFarEdgeCount: 0,
      distractorFarEdgeCount: 0,
      doubleTargetCount: 0,
      doubleWindowMs: 0,
      doublePatternId: "NONE",
      firstTeachingBatchWaveOneDoubleDisabled: false,
      minTargetHits: 12,
      upgradeFalseLimit: 1,
      holdFalseLimit: 2,
      layoutPoolId: "LP_S04_A_V1",
      seedKey: "CL-L028-DS10-V1",
      ruleIntroFlag: "DISTRACTOR_RULE"
    }),
    level({
      level: 67,
      difficultyStateId: "DS23",
      stageNo: 9,
      timingBand: "A",
      repetitionIndex: 1,
      repetitionRole: "\u65B0\u6388",
      contentVariantId: "DS23-V1",
      fruitPoolId: "FP_CORE_A",
      waveRotation: 0,
      backgroundId: "BG05",
      gridId: "3x3",
      targetTotal: 20,
      distractorTotal: 10,
      sameScreenCap: 4,
      waveProfileId: "W20D10-C6",
      coexistWaveCount: 6,
      peakWaveCount: 6,
      similarDistractorCount: 2,
      targetFarEdgeCount: 0,
      distractorFarEdgeCount: 0,
      doubleTargetCount: 0,
      doubleWindowMs: 0,
      doublePatternId: "NONE",
      firstTeachingBatchWaveOneDoubleDisabled: false,
      minTargetHits: 16,
      upgradeFalseLimit: 2,
      holdFalseLimit: 3,
      layoutPoolId: "LP_S09_A_V1",
      seedKey: "CL-L067-DS23-V1",
      ruleIntroFlag: "NONE"
    }),
    level({
      level: 102,
      difficultyStateId: "DS38",
      stageNo: 14,
      timingBand: "A",
      repetitionIndex: 1,
      repetitionRole: "\u65B0\u6388",
      contentVariantId: "DS38-V1",
      fruitPoolId: "FP_CORE_A",
      waveRotation: 0,
      backgroundId: "BG07",
      gridId: "3x4",
      targetTotal: 25,
      distractorTotal: 10,
      sameScreenCap: 5,
      waveProfileId: "W25D10-C6",
      coexistWaveCount: 6,
      peakWaveCount: 4,
      similarDistractorCount: 2,
      targetFarEdgeCount: 10,
      distractorFarEdgeCount: 4,
      doubleTargetCount: 2,
      doubleWindowMs: 1500,
      doublePatternId: "MAX2_CONSEC",
      firstTeachingBatchWaveOneDoubleDisabled: true,
      minTargetHits: 20,
      upgradeFalseLimit: 2,
      holdFalseLimit: 3,
      layoutPoolId: "LP_S14_A_V1",
      seedKey: "CL-L102-DS38-V1",
      ruleIntroFlag: "DOUBLE_RULE"
    }),
    level({
      level: 120,
      difficultyStateId: "DS46",
      stageNo: 16,
      timingBand: "H",
      repetitionIndex: 2,
      repetitionRole: "\u5DE9\u56FA",
      contentVariantId: "DS46-V2",
      fruitPoolId: "FP_CORE_B",
      waveRotation: 1,
      backgroundId: "BG08",
      gridId: "3x4",
      targetTotal: 25,
      distractorTotal: 10,
      sameScreenCap: 5,
      waveProfileId: "W25D10-C8",
      coexistWaveCount: 8,
      peakWaveCount: 4,
      similarDistractorCount: 6,
      targetFarEdgeCount: 15,
      distractorFarEdgeCount: 6,
      doubleTargetCount: 6,
      doubleWindowMs: 1200,
      doublePatternId: "MAX3_CONSEC",
      firstTeachingBatchWaveOneDoubleDisabled: false,
      minTargetHits: 20,
      upgradeFalseLimit: 2,
      holdFalseLimit: 3,
      layoutPoolId: "LP_S16_H_V2",
      seedKey: "CL-L120-DS46-V2",
      ruleIntroFlag: "NONE"
    })
  ]);
  var LEVEL_BY_NUMBER = new Map(VERTICAL_SLICE_LEVELS.map((config) => [config.level, config]));
  var WAVE_PROFILE_BY_ID = new Map(WAVE_PROFILES.map((profile) => [profile.waveProfileId, profile]));
  var CATCH_LIGHT_VERTICAL_SLICE_CONFIG = deepFreezeInPlace({
    schemaVersion: CATCH_LIGHT_CONFIG_VERSION,
    gameCode: CATCH_LIGHT_GAME_CODE,
    gameConfigSchemaId: CATCH_LIGHT_CONFIG_SCHEMA_ID,
    generatorVersion: CATCH_LIGHT_GENERATOR_VERSION,
    scoringRuleVersion: CATCH_LIGHT_SCORING_RULE_VERSION,
    resultSchemaVersion: CATCH_LIGHT_RESULT_SCHEMA_VERSION,
    durationMs: SESSION_DURATION_MS,
    plannedBatchCount: PLANNED_BATCH_COUNT,
    designMaxLevel: DESIGN_MAX_LEVEL,
    qaSeed: CATCH_LIGHT_QA_SEED,
    configSetId: CATCH_LIGHT_CONFIG_SET_ID,
    sourceWorkbookName: CATCH_LIGHT_SOURCE_WORKBOOK_NAME,
    sourceWorkbookSha256: CATCH_LIGHT_SOURCE_WORKBOOK_SHA256,
    sourceWorkbookRole: CATCH_LIGHT_SOURCE_WORKBOOK_ROLE,
    sourceRequirementSha256: CATCH_LIGHT_REQUIREMENT_SHA256,
    publicRulesSha256: A620_PUBLIC_RULES_SHA256,
    fruitCatalogVersion: "catch-light-fruit-catalog-2",
    fruitSimilarityCatalogVersion: "catch-light-fruit-similarity-2",
    layoutCatalogVersion: "catch-light-grid-catalog-1",
    fruitCatalog: FRUIT_CATALOG,
    fruitSimilarityRelations: FRUIT_SIMILARITY_RELATIONS,
    fruitContentQualification: FRUIT_CONTENT_QUALIFICATION,
    fruitPools: FRUIT_POOLS,
    grids: GRID_CATALOG,
    waveProfiles: WAVE_PROFILES,
    levels: VERTICAL_SLICE_LEVELS
  });
  function levelConfig(levelNumber) {
    const value = LEVEL_BY_NUMBER.get(levelNumber);
    if (value === void 0) {
      throw new Error(`level ${levelNumber} is not present in the W2 vertical-slice set; no nearest-level fallback is allowed`);
    }
    return value;
  }
  function waveProfile(profileId) {
    const value = WAVE_PROFILE_BY_ID.get(profileId);
    if (value === void 0) throw new Error(`unknown waveProfileId: ${profileId}`);
    return value;
  }
  function assertInteger(value, label, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  function validateLevelConfig(config, suppliedProfile) {
    assertInteger(config.level, "level", 1);
    if (config.level > DESIGN_MAX_LEVEL) throw new Error("level exceeds design maximum");
    const profile = suppliedProfile ?? waveProfile(config.waveProfileId);
    if (profile.waveProfileId !== config.waveProfileId) throw new Error(`${config.seedKey}: wave profile identity mismatch`);
    if (profile.targetsByWave.length !== WAVE_COUNT || profile.distractorsByWave.length !== WAVE_COUNT) {
      throw new Error(`${config.waveProfileId}: wave profile must contain exactly ${WAVE_COUNT} waves`);
    }
    if (!Number.isInteger(config.waveRotation) || config.waveRotation < 0 || config.waveRotation >= WAVE_COUNT) {
      throw new Error(`${config.seedKey}: waveRotation must be in [0, ${WAVE_COUNT - 1}]`);
    }
    const targetSum = profile.targetsByWave.reduce((sum, count) => sum + count, 0);
    const distractorSum = profile.distractorsByWave.reduce((sum, count) => sum + count, 0);
    if (targetSum !== config.targetTotal) throw new Error(`${config.seedKey}: targetTotal does not match wave profile`);
    if (distractorSum !== config.distractorTotal) throw new Error(`${config.seedKey}: distractorTotal does not match wave profile`);
    let actualCoexistWaveCount = 0;
    let actualPeakWaveCount = 0;
    for (let i = 0; i < WAVE_COUNT; i += 1) {
      const targetCount = profile.targetsByWave[(i + config.waveRotation) % WAVE_COUNT];
      const distractorCount = profile.distractorsByWave[(i + config.waveRotation) % WAVE_COUNT];
      if (!Number.isInteger(targetCount) || targetCount < 1 || !Number.isInteger(distractorCount) || distractorCount < 0) {
        throw new Error(`${config.seedKey}: wave ${i + 1} has invalid object counts`);
      }
      if (distractorCount > 0) actualCoexistWaveCount += 1;
      if (targetCount + distractorCount === config.sameScreenCap) actualPeakWaveCount += 1;
      if (targetCount + distractorCount > config.sameScreenCap) {
        throw new Error(`${config.seedKey}: wave ${i + 1} exceeds sameScreenCap`);
      }
    }
    if (actualCoexistWaveCount !== config.coexistWaveCount) throw new Error(`${config.seedKey}: coexistWaveCount mismatch`);
    if (actualPeakWaveCount !== config.peakWaveCount) throw new Error(`${config.seedKey}: peakWaveCount mismatch`);
    if (config.similarDistractorCount > actualCoexistWaveCount) {
      throw new Error(`${config.seedKey}: similar distractor quota exceeds the number of coexistence waves`);
    }
    if (config.waveCount !== WAVE_COUNT || config.roundActiveMs !== OPERATION_DURATION_MS || config.firstWaveMs !== FIRST_WAVE_MS || config.waveSpacingMs !== WAVE_ONSET_INTERVAL_MS || config.enterAnimationMs !== ENTER_ANIMATION_MS || config.exitAnimationMs !== EXIT_ANIMATION_MS || config.hitFeedbackMs !== HIT_FEEDBACK_MS) {
      throw new Error(`${config.seedKey}: fixed timing constants mismatch`);
    }
    const expectedTiming = lifecycleFor(config.timingBand);
    if (config.stimulusLifecycleMs !== expectedTiming.stimulusLifecycleMs || config.activeHoldMs !== expectedTiming.activeHoldMs || config.interWaveBlankMs !== expectedTiming.interWaveBlankMs || config.postLastBufferMs !== expectedTiming.postLastBufferMs) {
      throw new Error(`${config.seedKey}: timing-band tuple mismatch`);
    }
    if (config.enterAnimationMs + config.activeHoldMs + config.exitAnimationMs !== config.stimulusLifecycleMs) {
      throw new Error(`${config.seedKey}: lifecycle components do not sum to stimulusLifecycleMs`);
    }
    if (config.waveSpacingMs - config.stimulusLifecycleMs !== config.interWaveBlankMs) {
      throw new Error(`${config.seedKey}: inter-wave blank does not match wave spacing minus lifecycle`);
    }
    if (config.interWaveBlankMs < config.hitFeedbackMs) {
      throw new Error(`${config.seedKey}: inter-wave blank is shorter than hit feedback`);
    }
    const lastDeadline = config.firstWaveMs + (WAVE_COUNT - 1) * config.waveSpacingMs + config.stimulusLifecycleMs;
    if (lastDeadline + config.postLastBufferMs !== OPERATION_DURATION_MS) {
      throw new Error(`${config.seedKey}: schedule and postLastBufferMs do not close at 30000ms`);
    }
    if (config.similarDistractorCount > config.distractorTotal) throw new Error("similar distractor quota exceeds D");
    if (config.targetFarEdgeCount > config.targetTotal) throw new Error("target far-edge quota exceeds T");
    if (config.distractorFarEdgeCount > config.distractorTotal) throw new Error("distractor far-edge quota exceeds D");
    if (config.doubleTargetCount > config.targetTotal) throw new Error("double target quota exceeds T");
    if (config.doubleTargetCount > WAVE_COUNT) throw new Error("double target quota exceeds one-per-wave limit");
    if (typeof config.firstTeachingBatchWaveOneDoubleDisabled !== "boolean") {
      throw new Error(`${config.seedKey}: teaching-batch wave-one flag must be boolean`);
    }
    if (config.doubleTargetCount === 0) {
      if (config.doubleWindowMs !== 0 || config.doublePatternId !== "NONE" || config.firstTeachingBatchWaveOneDoubleDisabled) {
        throw new Error("non-double level has double configuration");
      }
    } else {
      if (config.level < 102 || config.doubleWindowMs < 1200 || config.doubleWindowMs > 1500 || config.doubleWindowMs % 100 !== 0) {
        throw new Error("double targets are only legal from L102 with a 1200-1500ms window in 100ms steps");
      }
      if (config.doublePatternId === "NONE") throw new Error(`${config.seedKey}: double levels require MAX2_CONSEC or MAX3_CONSEC`);
      if (config.firstTeachingBatchWaveOneDoubleDisabled && (config.level !== 102 || config.ruleIntroFlag !== "DOUBLE_RULE" || config.doublePatternId !== "MAX2_CONSEC")) {
        throw new Error(`${config.seedKey}: first-batch wave-one suppression is reserved for the L102 MAX2 teaching slice`);
      }
    }
    const expectedScoring = config.distractorTotal === 0 ? { profile: "SC_NO_DISTRACTOR", upgrade: 0, hold: 0 } : config.distractorTotal === 5 ? { profile: "SC_WITH_DISTRACTOR", upgrade: 1, hold: 2 } : { profile: "SC_WITH_DISTRACTOR", upgrade: 2, hold: 3 };
    if (config.scoringProfileId !== expectedScoring.profile || config.upgradeFalseLimit !== expectedScoring.upgrade || config.holdFalseLimit !== expectedScoring.hold) {
      throw new Error(`${config.seedKey}: scoring threshold profile mismatch`);
    }
    if (config.minTargetHits !== Math.ceil(config.targetTotal * 80 / 100)) {
      throw new Error(`${config.seedKey}: minTargetHits is not the minimum integer satisfying the 80% upgrade threshold`);
    }
    const expectedBackgroundId = `BG${String(Math.ceil(config.level / 15)).padStart(2, "0")}`;
    if (config.backgroundId !== expectedBackgroundId) throw new Error(`${config.seedKey}: background chapter mapping mismatch`);
    if (config.level === 102 && (config.doublePatternId !== "MAX2_CONSEC" || !config.firstTeachingBatchWaveOneDoubleDisabled || config.doubleTargetCount !== 2 || config.doubleWindowMs !== 1500)) {
      throw new Error("L102 must implement MAX2_CONSEC with first-formal-batch wave-one suppression and a 1500ms window");
    }
    if (config.level === 120 && (config.doublePatternId !== "MAX3_CONSEC" || config.firstTeachingBatchWaveOneDoubleDisabled || config.doubleTargetCount !== 6 || config.doubleWindowMs !== 1200)) {
      throw new Error("L120 must implement six MAX3_CONSEC double targets with a 1200ms window");
    }
  }
  function validateVerticalSliceConfig(config) {
    if (config.schemaVersion !== CATCH_LIGHT_CONFIG_VERSION || config.gameCode !== CATCH_LIGHT_GAME_CODE || config.gameConfigSchemaId !== CATCH_LIGHT_CONFIG_SCHEMA_ID || config.configSetId !== CATCH_LIGHT_CONFIG_SET_ID) {
      throw new Error("config identity mismatch");
    }
    if (config.generatorVersion !== CATCH_LIGHT_GENERATOR_VERSION || config.scoringRuleVersion !== CATCH_LIGHT_SCORING_RULE_VERSION || config.resultSchemaVersion !== CATCH_LIGHT_RESULT_SCHEMA_VERSION) {
      throw new Error("version identity mismatch");
    }
    if (config.sourceWorkbookName !== CATCH_LIGHT_SOURCE_WORKBOOK_NAME || config.sourceWorkbookSha256 !== CATCH_LIGHT_SOURCE_WORKBOOK_SHA256 || config.sourceWorkbookRole !== CATCH_LIGHT_SOURCE_WORKBOOK_ROLE || config.sourceRequirementSha256 !== CATCH_LIGHT_REQUIREMENT_SHA256 || config.publicRulesSha256 !== A620_PUBLIC_RULES_SHA256) {
      throw new Error("source provenance mismatch");
    }
    if (config.durationMs !== SESSION_DURATION_MS || config.plannedBatchCount !== PLANNED_BATCH_COUNT || config.designMaxLevel !== DESIGN_MAX_LEVEL || config.qaSeed !== CATCH_LIGHT_QA_SEED) {
      throw new Error("session identity or timing mismatch");
    }
    if (config.fruitCatalogVersion !== "catch-light-fruit-catalog-2" || config.fruitSimilarityCatalogVersion !== "catch-light-fruit-similarity-2" || config.layoutCatalogVersion !== "catch-light-grid-catalog-1") {
      throw new Error("catalog version mismatch");
    }
    if (config.fruitCatalog.length !== FRUIT_CATALOG.length || config.fruitCatalog.some((fruit, index) => canonicalSha256(fruit) !== canonicalSha256(FRUIT_CATALOG[index]))) {
      throw new Error("fruit catalog differs from the frozen W2 catalog");
    }
    if (canonicalSha256(config.fruitPools) !== canonicalSha256(FRUIT_POOLS)) throw new Error("fruit pools differ from the frozen W2 pools");
    if (canonicalSha256(config.fruitSimilarityRelations) !== canonicalSha256(FRUIT_SIMILARITY_RELATIONS)) {
      throw new Error("fruit similarity relations differ from the frozen W2 relation table");
    }
    if (canonicalSha256(config.fruitContentQualification) !== canonicalSha256(FRUIT_CONTENT_QUALIFICATION)) {
      throw new Error("fruit content qualification differs from the frozen W2 status");
    }
    if (canonicalSha256(config.grids) !== canonicalSha256(GRID_CATALOG)) throw new Error("grid catalog differs from the frozen W2 catalog");
    if (canonicalSha256(config.waveProfiles) !== canonicalSha256(WAVE_PROFILES)) throw new Error("wave profiles differ from the frozen W2 profiles");
    const fruitIds = config.fruitCatalog.map((fruit) => fruit.fruitId);
    if (new Set(fruitIds).size !== fruitIds.length) throw new Error("duplicate fruitId in catalog");
    const similarityTagMembers = /* @__PURE__ */ new Map();
    for (const fruit of config.fruitCatalog) {
      if (!/^#[0-9A-F]{6}$/.test(fruit.mainColorHex)) throw new Error(`${fruit.fruitId}: invalid mainColorHex`);
      if (!/^assets\/fruits\/[a-z-]+\.png$/.test(fruit.assetPath)) throw new Error(`${fruit.fruitId}: invalid assetPath`);
      if (new Set(fruit.similarityTags).size !== fruit.similarityTags.length) throw new Error(`${fruit.fruitId}: duplicate similarity tag`);
      for (const tag of fruit.similarityTags) {
        const members = similarityTagMembers.get(tag) ?? [];
        members.push(fruit.fruitId);
        similarityTagMembers.set(tag, members);
      }
    }
    const relationTags = /* @__PURE__ */ new Set();
    for (const relation of config.fruitSimilarityRelations) {
      if (relationTags.has(relation.tag)) throw new Error(`${relation.tag}: duplicate similarity relation tag`);
      relationTags.add(relation.tag);
      if (relation.fruitA === relation.fruitB) throw new Error(`${relation.tag}: a similarity relation must connect two different fruits`);
      const members = similarityTagMembers.get(relation.tag) ?? [];
      if (members.length !== 2 || !members.includes(relation.fruitA) || !members.includes(relation.fruitB)) {
        throw new Error(`${relation.tag}: fruit tags do not match the declared relation endpoints`);
      }
    }
    for (const [tag, members] of similarityTagMembers) {
      if (members.length !== 2) throw new Error(`${tag}: similarity relation must connect exactly two fruits`);
      if (!relationTags.has(tag)) throw new Error(`${tag}: fruit catalog references an undeclared similarity relation`);
    }
    if (config.fruitContentQualification.runtimeUseStatus !== "HEADLESS_VERTICAL_SLICE_ONLY" || config.fruitContentQualification.productionActivationStatus !== "BLOCKED_PENDING_FRUIT_SPRITES_AND_CORE_B_RELATION_APPROVAL" || config.fruitContentQualification.coreA.relationStatus !== "SOURCE_WORKBOOK_CONFIRMED" || !config.fruitContentQualification.coreA.relationUseApproved || config.fruitContentQualification.coreA.productionGate !== "NONE" || config.fruitContentQualification.coreB.relationStatus !== "ENGINEERING_COMPATIBILITY_UNAPPROVED" || config.fruitContentQualification.coreB.relationUseApproved || config.fruitContentQualification.coreB.productionGate !== "BLOCK_UNTIL_PRODUCT_AND_ART_APPROVE_FINAL_SPRITES_AND_PAIR_MATRIX") {
      throw new Error("fruit content qualification does not preserve the W2 headless-only production gate");
    }
    const profilesById = /* @__PURE__ */ new Map();
    for (const profile of config.waveProfiles) {
      if (profilesById.has(profile.waveProfileId)) throw new Error(`duplicate wave profile ${profile.waveProfileId}`);
      profilesById.set(profile.waveProfileId, profile);
    }
    const seenLevels = /* @__PURE__ */ new Set();
    const seenVariants = /* @__PURE__ */ new Set();
    const seenSeeds = /* @__PURE__ */ new Set();
    for (const item of config.levels) {
      if (seenLevels.has(item.level)) throw new Error(`duplicate level ${item.level}`);
      if (seenVariants.has(item.contentVariantId)) throw new Error(`duplicate contentVariantId ${item.contentVariantId}`);
      if (seenSeeds.has(item.seedKey)) throw new Error(`duplicate seedKey ${item.seedKey}`);
      seenLevels.add(item.level);
      seenVariants.add(item.contentVariantId);
      seenSeeds.add(item.seedKey);
      const profile = profilesById.get(item.waveProfileId);
      if (profile === void 0) throw new Error(`unknown waveProfileId: ${item.waveProfileId}`);
      validateLevelConfig(item, profile);
    }
    const actualLevels = [...seenLevels].sort((a, b) => a - b);
    const requiredLevels = [1, 28, 67, 102, 120];
    if (actualLevels.length !== requiredLevels.length || actualLevels.some((value, index) => value !== requiredLevels[index])) {
      throw new Error("W2 config must contain exactly L1/L28/L67/L102/L120");
    }
    const seenGridIds = /* @__PURE__ */ new Set();
    for (const grid of config.grids) {
      if (seenGridIds.has(grid.gridId)) throw new Error(`duplicate gridId ${grid.gridId}`);
      seenGridIds.add(grid.gridId);
      if (grid.slots.length !== grid.rows * grid.cols) throw new Error(`${grid.gridId}: grid slot count mismatch`);
      const seenSlotIds = /* @__PURE__ */ new Set();
      const seenCoordinates = /* @__PURE__ */ new Set();
      for (const slot of grid.slots) {
        if (seenSlotIds.has(slot.slotId)) throw new Error(`${grid.gridId}: duplicate slotId ${slot.slotId}`);
        seenSlotIds.add(slot.slotId);
        const coordinate = `${slot.row}:${slot.col}`;
        if (seenCoordinates.has(coordinate)) throw new Error(`${grid.gridId}: duplicate row/column ${coordinate}`);
        seenCoordinates.add(coordinate);
        if (slot.row < 1 || slot.row > grid.rows || slot.col < 1 || slot.col > grid.cols || slot.slotId !== `R${slot.row}C${slot.col}`) {
          throw new Error(`${grid.gridId}/${slot.slotId}: invalid row/column identity`);
        }
        if (slot.xBasisPoints <= 0 || slot.xBasisPoints >= 1e4 || slot.yBasisPoints <= 0 || slot.yBasisPoints >= 1e4) {
          throw new Error(`${grid.gridId}/${slot.slotId}: basis-point coordinate outside training area`);
        }
        const expectedEdge = slot.col === 1 || slot.col === grid.cols;
        if (slot.edgeSlot !== expectedEdge) throw new Error(`${grid.gridId}/${slot.slotId}: edgeSlot mismatch`);
        if (slot.minHitWidthDp < 56 || slot.minHitHeightDp < 56) {
          throw new Error(`${grid.gridId}/${slot.slotId}: hit area is below the frozen 56dp minimum`);
        }
      }
    }
    if (BATCH_DURATION_MS * PLANNED_BATCH_COUNT !== SESSION_DURATION_MS) throw new Error("batch/session duration invariant failed");
  }
  var CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256 = canonicalSha256(CATCH_LIGHT_VERTICAL_SLICE_CONFIG);
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function parseStrictGameConfig(value) {
    if (!isRecord(value) || Object.keys(value).length === 0) {
      throw new Error("the Gate 0 empty gameConfig is legacy-vector-only and is rejected by the W2 runtime");
    }
    const parsed = immutableSnapshot(value);
    validateVerticalSliceConfig(parsed);
    if (canonicalSha256(parsed) !== CATCH_LIGHT_VERTICAL_SLICE_CONFIG_SHA256) {
      throw new Error("runtime gameConfig differs from the frozen W2 compiled artifact");
    }
    return parsed;
  }
  validateVerticalSliceConfig(CATCH_LIGHT_VERTICAL_SLICE_CONFIG);

  // src/games/catch-light/generator.ts
  function rotated(values, amount) {
    return values.map((_, index) => values[(index + amount) % values.length]);
  }
  function quotaFlags(total, quota, prng) {
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(quota) || quota < 0 || quota > total) {
      throw new Error(`invalid quota ${quota}/${total}`);
    }
    const selected = new Set(prng.shuffle(Array.from({ length: total }, (_, index) => index)).slice(0, quota));
    return Array.from({ length: total }, (_, index) => selected.has(index));
  }
  function similarFlagsByWave(distractorsByWave, quota, prng) {
    if (!Number.isSafeInteger(quota) || quota < 0) throw new Error("similar distractor quota must be a non-negative safe integer");
    const eligibleWaves = distractorsByWave.map((count, index) => ({ count, index })).filter((item) => item.count > 0);
    if (quota > eligibleWaves.length) {
      throw new Error(`similar distractor quota ${quota} exceeds ${eligibleWaves.length} coexistence waves`);
    }
    const selectedWaves = new Set(prng.shuffle(eligibleWaves.map((item) => item.index)).slice(0, quota));
    return distractorsByWave.map((count, waveIndex) => {
      const flags = new Array(count).fill(false);
      if (selectedWaves.has(waveIndex)) flags[prng.nextIndex(count)] = true;
      return flags;
    });
  }
  function maximumConsecutive(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    let best = 1;
    let current = 1;
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] === sorted[index - 1] + 1) current += 1;
      else current = 1;
      best = Math.max(best, current);
    }
    return best;
  }
  function enumerateWaveSelections(count, suppressWaveOne, maxConsecutive) {
    const candidates = Array.from({ length: WAVE_COUNT }, (_, index) => index + 1).filter((waveOrdinal) => !suppressWaveOne || waveOrdinal !== 1);
    const selections = [];
    const visit = (startIndex, selected) => {
      if (selected.length === count) {
        if (maximumConsecutive(selected) <= maxConsecutive) selections.push([...selected]);
        return;
      }
      const remainingNeeded = count - selected.length;
      for (let index = startIndex; index <= candidates.length - remainingNeeded; index += 1) {
        selected.push(candidates[index]);
        visit(index + 1, selected);
        selected.pop();
      }
    };
    visit(0, []);
    return selections;
  }
  function chooseDoubleWaves(config, prng, suppressWaveOne) {
    if (config.doubleTargetCount === 0) return /* @__PURE__ */ new Set();
    if (config.doublePatternId === "NONE") throw new Error(`${config.seedKey}: double target count requires a consecutive-wave pattern`);
    const maxConsecutive = config.doublePatternId === "MAX3_CONSEC" ? 3 : 2;
    const candidates = enumerateWaveSelections(config.doubleTargetCount, suppressWaveOne, maxConsecutive);
    if (candidates.length === 0) throw new Error(`${config.seedKey}: no legal double-target wave allocation`);
    return new Set(prng.shuffle(candidates)[0]);
  }
  function chooseDistractor(targetFruitId, pool, similar, usedInWave, prng) {
    const candidates = pool.filter(
      (candidate) => candidate !== targetFruitId && fruitDefinition(candidate).distractorAllowed && !usedInWave.has(candidate) && fruitsAreSimilar(targetFruitId, candidate) === similar
    );
    if (candidates.length === 0) {
      throw new Error(`fruit pool cannot satisfy ${similar ? "similar" : "clear"} distractor uniqueness for target ${targetFruitId}`);
    }
    return prng.shuffle(candidates)[0];
  }
  function assignSlots(plans, gridSlots, previousPrimaryTargetSlot, prng) {
    if (plans.length > gridSlots.length) throw new Error("wave has more instances than grid slots");
    const available = new Map(gridSlots.map((slot) => [slot.slotId, slot]));
    const assignments = /* @__PURE__ */ new Map();
    const indices = plans.map((_, index) => index);
    const allocationOrder = [
      ...indices.filter((index) => plans[index].edgeEmphasis),
      ...indices.filter((index) => !plans[index].edgeEmphasis)
    ];
    for (const index of allocationOrder) {
      const plan = plans[index];
      let candidates = [...available.values()].filter((slot2) => !plan.edgeEmphasis || slot2.edgeSlot);
      if (candidates.length === 0) throw new Error("edge-emphasis quota cannot be placed in selected grid");
      if (index === 0 && previousPrimaryTargetSlot !== null) {
        const alternatives = candidates.filter((slot2) => slot2.slotId !== previousPrimaryTargetSlot);
        if (alternatives.length === 0) throw new Error("primary target slot cannot change between adjacent waves");
        candidates = alternatives;
      }
      const slot = prng.shuffle(candidates)[0];
      assignments.set(index, slot);
      available.delete(slot.slotId);
    }
    return assignments;
  }
  function waveOneSuppressionFor(config, batchOrdinal, options) {
    if (options.firstFormalTeachingBatch !== void 0 && typeof options.firstFormalTeachingBatch !== "boolean") {
      throw new Error("firstFormalTeachingBatch must be boolean when supplied");
    }
    const firstFormalTeachingBatch = options.firstFormalTeachingBatch ?? batchOrdinal === 1;
    return config.firstTeachingBatchWaveOneDoubleDisabled && firstFormalTeachingBatch;
  }
  function buildBatchScheduleUnchecked(levelOrConfig, sessionSeed, batchOrdinal, options = {}) {
    const config = typeof levelOrConfig === "number" ? levelConfig(levelOrConfig) : immutableSnapshot(levelOrConfig);
    validateLevelConfig(config);
    if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
    if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1 || batchOrdinal > PLANNED_BATCH_COUNT) {
      throw new Error(`batchOrdinal must be in 1..${PLANNED_BATCH_COUNT}`);
    }
    const backgroundId = options.backgroundIdOverride ?? config.backgroundId;
    if (!/^BG0[1-8]$/.test(backgroundId)) throw new Error(`invalid session backgroundId: ${backgroundId}`);
    const profile = waveProfile(config.waveProfileId);
    const targetsByWave = rotated(profile.targetsByWave, config.waveRotation);
    const distractorsByWave = rotated(profile.distractorsByWave, config.waveRotation);
    const batchPlan = prngFor(config.seedKey, sessionSeed, batchOrdinal, 0);
    const waveOneDoubleSuppressed = waveOneSuppressionFor(config, batchOrdinal, options);
    const pool = FRUIT_POOLS[config.fruitPoolId];
    const targetCandidates = pool.filter((fruitId) => fruitDefinition(fruitId).targetAllowed);
    if (targetCandidates.length === 0) throw new Error(`${config.fruitPoolId}: no target-eligible fruit`);
    const targetFruitId = batchPlan.prng.shuffle(targetCandidates)[0];
    if (config.similarDistractorCount > 0 && !pool.some((candidate) => fruitsAreSimilar(targetFruitId, candidate))) {
      throw new Error(`${config.seedKey}: selected target ${targetFruitId} has no declared similar distractor`);
    }
    const similarFlags = similarFlagsByWave(distractorsByWave, config.similarDistractorCount, batchPlan.prng);
    const targetEdgeFlags = quotaFlags(config.targetTotal, config.targetFarEdgeCount, batchPlan.prng);
    const distractorEdgeFlags = quotaFlags(config.distractorTotal, config.distractorFarEdgeCount, batchPlan.prng);
    const doubleWaves = chooseDoubleWaves(config, batchPlan.prng, waveOneDoubleSuppressed);
    const grid = gridDefinition(config.gridId);
    const waves = [];
    let targetGlobalOrdinal = 0;
    let distractorGlobalOrdinal = 0;
    let previousPrimaryTargetSlot = null;
    for (let waveIndex = 0; waveIndex < WAVE_COUNT; waveIndex += 1) {
      const waveOrdinal = waveIndex + 1;
      const targetCount = targetsByWave[waveIndex];
      const distractorCount = distractorsByWave[waveIndex];
      if (targetCount + distractorCount > config.sameScreenCap) {
        throw new Error(`${config.seedKey}: generated wave ${waveOrdinal} exceeds sameScreenCap`);
      }
      const waveRandom = prngFor(config.seedKey, sessionSeed, batchOrdinal, waveOrdinal);
      const doubleTargetIndex = doubleWaves.has(waveOrdinal) ? waveRandom.prng.nextIndex(targetCount) : -1;
      const plans = [];
      for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
        plans.push({
          role: "TARGET",
          fruitId: targetFruitId,
          similarityClass: "TARGET",
          edgeEmphasis: targetEdgeFlags[targetGlobalOrdinal],
          isDouble: targetIndex === doubleTargetIndex,
          ordinalInRole: targetIndex + 1
        });
        targetGlobalOrdinal += 1;
      }
      const usedDistractors = /* @__PURE__ */ new Set();
      for (let distractorIndex = 0; distractorIndex < distractorCount; distractorIndex += 1) {
        const similar = similarFlags[waveIndex][distractorIndex];
        const fruitId = chooseDistractor(targetFruitId, pool, similar, usedDistractors, waveRandom.prng);
        usedDistractors.add(fruitId);
        plans.push({
          role: "DISTRACTOR",
          fruitId,
          similarityClass: similar ? "SIMILAR" : "CLEAR",
          edgeEmphasis: distractorEdgeFlags[distractorGlobalOrdinal],
          isDouble: false,
          ordinalInRole: distractorIndex + 1
        });
        distractorGlobalOrdinal += 1;
      }
      const slots = assignSlots(plans, grid.slots, previousPrimaryTargetSlot, waveRandom.prng);
      const onsetMs = config.firstWaveMs + waveIndex * config.waveSpacingMs;
      const instances = plans.map((plan, planIndex) => {
        const roleCode = plan.role === "TARGET" ? "T" : "D";
        const slot = slots.get(planIndex);
        if (slot === void 0) throw new Error("internal slot assignment failure");
        return {
          instanceId: `B${String(batchOrdinal).padStart(2, "0")}-W${String(waveOrdinal).padStart(2, "0")}-${roleCode}${String(plan.ordinalInRole).padStart(2, "0")}`,
          waveOrdinal,
          ordinalInWave: planIndex + 1,
          role: plan.role,
          fruitId: plan.fruitId,
          similarityClass: plan.similarityClass,
          slotId: slot.slotId,
          edgeEmphasis: plan.edgeEmphasis,
          isDouble: plan.isDouble,
          activeStartMs: onsetMs,
          activeDeadlineMs: onsetMs + config.stimulusLifecycleMs,
          enterEndMs: onsetMs + config.enterAnimationMs,
          exitStartMs: onsetMs + config.stimulusLifecycleMs - config.exitAnimationMs,
          doubleWindowMs: plan.isDouble ? config.doubleWindowMs : 0
        };
      });
      previousPrimaryTargetSlot = instances[0].slotId;
      waves.push({
        waveOrdinal,
        seedMaterial: waveRandom.material,
        seed32: waveRandom.seed32,
        onsetMs,
        targetCount,
        distractorCount,
        instances
      });
    }
    const projection = {
      generatorVersion: CATCH_LIGHT_GENERATOR_VERSION,
      configSetId: CATCH_LIGHT_CONFIG_SET_ID,
      level: config.level,
      batchOrdinal,
      sessionSeed,
      seedKey: config.seedKey,
      batchPlanSeedMaterial: batchPlan.material,
      batchPlanSeed32: batchPlan.seed32,
      targetFruitId,
      backgroundId,
      gridId: config.gridId,
      targetTotal: config.targetTotal,
      distractorTotal: config.distractorTotal,
      sameScreenCap: config.sameScreenCap,
      firstTeachingBatchWaveOneDoubleSuppressed: waveOneDoubleSuppressed,
      waves
    };
    const schedule = { ...projection, scheduleSha256: canonicalSha256(projection) };
    return schedule;
  }
  function generateBatchSchedule(levelOrConfig, sessionSeed, batchOrdinal, options = {}) {
    const config = typeof levelOrConfig === "number" ? levelConfig(levelOrConfig) : immutableSnapshot(levelOrConfig);
    const schedule = buildBatchScheduleUnchecked(config, sessionSeed, batchOrdinal, options);
    validateGeneratedSchedule(schedule, config);
    const frozen = immutableSnapshot(schedule);
    if (!isDeepFrozenJson(frozen)) throw new Error("generated schedule was not deeply frozen");
    return frozen;
  }
  function assertEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
  function validateGeneratedSchedule(schedule, config = levelConfig(schedule.level)) {
    validateLevelConfig(config);
    if (!Number.isSafeInteger(schedule.sessionSeed) || schedule.sessionSeed < 0) throw new Error("schedule sessionSeed is invalid");
    if (!Number.isSafeInteger(schedule.batchOrdinal) || schedule.batchOrdinal < 1 || schedule.batchOrdinal > PLANNED_BATCH_COUNT) {
      throw new Error("schedule batchOrdinal is invalid");
    }
    assertEqual(schedule.generatorVersion, CATCH_LIGHT_GENERATOR_VERSION, "generatorVersion");
    assertEqual(schedule.configSetId, CATCH_LIGHT_CONFIG_SET_ID, "configSetId");
    assertEqual(schedule.level, config.level, "level");
    assertEqual(schedule.seedKey, config.seedKey, "seedKey");
    assertEqual(schedule.gridId, config.gridId, "gridId");
    assertEqual(schedule.targetTotal, config.targetTotal, "targetTotal");
    assertEqual(schedule.distractorTotal, config.distractorTotal, "distractorTotal");
    assertEqual(schedule.sameScreenCap, config.sameScreenCap, "sameScreenCap");
    if (!/^BG0[1-8]$/.test(schedule.backgroundId)) throw new Error("backgroundId is invalid");
    if (typeof schedule.firstTeachingBatchWaveOneDoubleSuppressed !== "boolean") {
      throw new Error("firstTeachingBatchWaveOneDoubleSuppressed must be boolean");
    }
    if (schedule.firstTeachingBatchWaveOneDoubleSuppressed && !config.firstTeachingBatchWaveOneDoubleDisabled) {
      throw new Error("wave-one suppression is not legal for this level");
    }
    const batchSeed = prngFor(config.seedKey, schedule.sessionSeed, schedule.batchOrdinal, 0);
    assertEqual(schedule.batchPlanSeedMaterial, batchSeed.material, "batchPlanSeedMaterial");
    assertEqual(schedule.batchPlanSeed32, batchSeed.seed32, "batchPlanSeed32");
    const pool = FRUIT_POOLS[config.fruitPoolId];
    if (!pool.includes(schedule.targetFruitId) || !fruitDefinition(schedule.targetFruitId).targetAllowed) {
      throw new Error("target fruit is outside the configured target-eligible pool");
    }
    if (schedule.waves.length !== WAVE_COUNT) throw new Error("generated schedule must have eight waves");
    const profile = waveProfile(config.waveProfileId);
    const expectedTargetsByWave = rotated(profile.targetsByWave, config.waveRotation);
    const expectedDistractorsByWave = rotated(profile.distractorsByWave, config.waveRotation);
    const grid = gridDefinition(config.gridId);
    const slotById = new Map(grid.slots.map((slot) => [slot.slotId, slot]));
    const allInstances = [];
    let previousPrimaryTargetSlot = null;
    for (let waveIndex = 0; waveIndex < WAVE_COUNT; waveIndex += 1) {
      const wave = schedule.waves[waveIndex];
      const waveOrdinal = waveIndex + 1;
      const expectedTargetCount = expectedTargetsByWave[waveIndex];
      const expectedDistractorCount = expectedDistractorsByWave[waveIndex];
      const expectedSeed = prngFor(config.seedKey, schedule.sessionSeed, schedule.batchOrdinal, waveOrdinal);
      const expectedOnset = config.firstWaveMs + waveIndex * config.waveSpacingMs;
      assertEqual(wave.waveOrdinal, waveOrdinal, `wave ${waveOrdinal} ordinal`);
      assertEqual(wave.seedMaterial, expectedSeed.material, `wave ${waveOrdinal} seedMaterial`);
      assertEqual(wave.seed32, expectedSeed.seed32, `wave ${waveOrdinal} seed32`);
      assertEqual(wave.onsetMs, expectedOnset, `wave ${waveOrdinal} onsetMs`);
      assertEqual(wave.targetCount, expectedTargetCount, `wave ${waveOrdinal} targetCount`);
      assertEqual(wave.distractorCount, expectedDistractorCount, `wave ${waveOrdinal} distractorCount`);
      assertEqual(wave.instances.length, expectedTargetCount + expectedDistractorCount, `wave ${waveOrdinal} instance count`);
      if (wave.instances.length > config.sameScreenCap) throw new Error(`wave ${waveOrdinal} exceeds sameScreenCap`);
      if (new Set(wave.instances.map((instance) => instance.slotId)).size !== wave.instances.length) {
        throw new Error(`wave ${waveOrdinal} has a slot collision`);
      }
      const distractorFruitIds = /* @__PURE__ */ new Set();
      let doubleCount = 0;
      let similarCount = 0;
      for (let instanceIndex = 0; instanceIndex < wave.instances.length; instanceIndex += 1) {
        const instance = wave.instances[instanceIndex];
        const target = instanceIndex < expectedTargetCount;
        const ordinalInRole = target ? instanceIndex + 1 : instanceIndex - expectedTargetCount + 1;
        const roleCode = target ? "T" : "D";
        const expectedId = `B${String(schedule.batchOrdinal).padStart(2, "0")}-W${String(waveOrdinal).padStart(2, "0")}-${roleCode}${String(ordinalInRole).padStart(2, "0")}`;
        assertEqual(instance.instanceId, expectedId, `${expectedId} instanceId`);
        assertEqual(instance.waveOrdinal, waveOrdinal, `${expectedId} waveOrdinal`);
        assertEqual(instance.ordinalInWave, instanceIndex + 1, `${expectedId} ordinalInWave`);
        assertEqual(instance.role, target ? "TARGET" : "DISTRACTOR", `${expectedId} role`);
        assertEqual(instance.activeStartMs, expectedOnset, `${expectedId} activeStartMs`);
        assertEqual(instance.activeDeadlineMs, expectedOnset + config.stimulusLifecycleMs, `${expectedId} activeDeadlineMs`);
        assertEqual(instance.enterEndMs, expectedOnset + config.enterAnimationMs, `${expectedId} enterEndMs`);
        assertEqual(instance.exitStartMs, expectedOnset + config.stimulusLifecycleMs - config.exitAnimationMs, `${expectedId} exitStartMs`);
        const slot = slotById.get(instance.slotId);
        if (slot === void 0) throw new Error(`${expectedId} references unknown slot ${instance.slotId}`);
        if (instance.edgeEmphasis && !slot.edgeSlot) throw new Error(`${expectedId} edge emphasis is not placed on an edge slot`);
        if (target) {
          assertEqual(instance.fruitId, schedule.targetFruitId, `${expectedId} target fruit`);
          assertEqual(instance.similarityClass, "TARGET", `${expectedId} similarityClass`);
          assertEqual(instance.doubleWindowMs, instance.isDouble ? config.doubleWindowMs : 0, `${expectedId} doubleWindowMs`);
          if (instance.isDouble) doubleCount += 1;
        } else {
          if (!pool.includes(instance.fruitId) || !fruitDefinition(instance.fruitId).distractorAllowed) {
            throw new Error(`${expectedId} distractor is outside the configured distractor-eligible pool`);
          }
          if (instance.fruitId === schedule.targetFruitId) throw new Error(`${expectedId} reuses target fruit as distractor`);
          if (distractorFruitIds.has(instance.fruitId)) throw new Error(`${expectedId} duplicates a distractor fruit within the wave`);
          distractorFruitIds.add(instance.fruitId);
          const expectedSimilarity = fruitsAreSimilar(schedule.targetFruitId, instance.fruitId) ? "SIMILAR" : "CLEAR";
          assertEqual(instance.similarityClass, expectedSimilarity, `${expectedId} similarityClass`);
          if (instance.similarityClass === "SIMILAR") similarCount += 1;
          if (instance.isDouble || instance.doubleWindowMs !== 0) throw new Error(`${expectedId} distractor cannot be double`);
        }
        allInstances.push(instance);
      }
      if (doubleCount > 1) throw new Error(`wave ${waveOrdinal} has more than one double target`);
      if (similarCount > 1) throw new Error(`wave ${waveOrdinal} has more than one similar distractor`);
      const primaryTargetSlot = wave.instances[0].slotId;
      if (previousPrimaryTargetSlot === primaryTargetSlot) throw new Error("primary target slot repeated in adjacent waves");
      previousPrimaryTargetSlot = primaryTargetSlot;
    }
    if (new Set(allInstances.map((instance) => instance.instanceId)).size !== allInstances.length) throw new Error("duplicate instanceId");
    const targets = allInstances.filter((instance) => instance.role === "TARGET");
    const distractors = allInstances.filter((instance) => instance.role === "DISTRACTOR");
    assertEqual(targets.length, config.targetTotal, "generated target total");
    assertEqual(distractors.length, config.distractorTotal, "generated distractor total");
    assertEqual(distractors.filter((instance) => instance.similarityClass === "SIMILAR").length, config.similarDistractorCount, "similar distractor quota");
    assertEqual(targets.filter((instance) => instance.edgeEmphasis).length, config.targetFarEdgeCount, "target edge-emphasis quota");
    assertEqual(distractors.filter((instance) => instance.edgeEmphasis).length, config.distractorFarEdgeCount, "distractor edge-emphasis quota");
    assertEqual(targets.filter((instance) => instance.isDouble).length, config.doubleTargetCount, "double-target quota");
    const doubleWaves = schedule.waves.filter((wave) => wave.instances.some((instance) => instance.isDouble)).map((wave) => wave.waveOrdinal);
    if (schedule.firstTeachingBatchWaveOneDoubleSuppressed && doubleWaves.includes(1)) {
      throw new Error("first teaching batch wave-one suppression violated");
    }
    if (config.doublePatternId === "NONE" && doubleWaves.length !== 0) throw new Error("NONE double pattern violated");
    if (config.doublePatternId === "MAX2_CONSEC" && maximumConsecutive(doubleWaves) > 2) throw new Error("MAX2_CONSEC violated");
    if (config.doublePatternId === "MAX3_CONSEC" && maximumConsecutive(doubleWaves) > 3) throw new Error("MAX3_CONSEC violated");
    const projection = { ...schedule };
    delete projection.scheduleSha256;
    if (canonicalSha256(projection) !== schedule.scheduleSha256) throw new Error("scheduleSha256 is inconsistent");
    const regenerated = buildBatchScheduleUnchecked(config, schedule.sessionSeed, schedule.batchOrdinal, {
      backgroundIdOverride: schedule.backgroundId,
      firstFormalTeachingBatch: schedule.firstTeachingBatchWaveOneDoubleSuppressed
    });
    if (canonicalSha256(schedule) !== canonicalSha256(regenerated)) {
      throw new Error("schedule differs from deterministic generator replay");
    }
  }

  // src/games/catch-light/object-machine.ts
  var NO_CHANGE = Object.freeze({ changedStatistics: false, hitDelta: 0, falseTouchDelta: 0 });
  function assertSafeNonNegative(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  }
  function validateInstance(instance) {
    assertSafeNonNegative(instance.waveOrdinal, "waveOrdinal");
    assertSafeNonNegative(instance.ordinalInWave, "ordinalInWave");
    assertSafeNonNegative(instance.activeStartMs, "activeStartMs");
    assertSafeNonNegative(instance.enterEndMs, "enterEndMs");
    assertSafeNonNegative(instance.exitStartMs, "exitStartMs");
    assertSafeNonNegative(instance.activeDeadlineMs, "activeDeadlineMs");
    assertSafeNonNegative(instance.doubleWindowMs, "doubleWindowMs");
    if (instance.waveOrdinal < 1 || instance.ordinalInWave < 1) throw new Error("wave and instance ordinals start at 1");
    if (!(instance.activeStartMs < instance.enterEndMs && instance.enterEndMs <= instance.exitStartMs && instance.exitStartMs < instance.activeDeadlineMs)) {
      throw new Error(`${instance.instanceId}: invalid half-open lifecycle ordering`);
    }
    if (instance.role === "TARGET") {
      if (instance.similarityClass !== "TARGET") throw new Error(`${instance.instanceId}: target must use TARGET similarityClass`);
    } else {
      if (instance.similarityClass === "TARGET") throw new Error(`${instance.instanceId}: distractor cannot use TARGET similarityClass`);
      if (instance.isDouble) throw new Error(`${instance.instanceId}: distractor cannot be double`);
    }
    if (instance.isDouble) {
      if (instance.role !== "TARGET" || instance.doubleWindowMs < 1200 || instance.doubleWindowMs > 1500 || instance.doubleWindowMs % 100 !== 0) {
        throw new Error(`${instance.instanceId}: invalid double-target configuration`);
      }
    } else if (instance.doubleWindowMs !== 0) {
      throw new Error(`${instance.instanceId}: non-double instance must use doubleWindowMs=0`);
    }
  }
  var FruitObjectRuntime = class {
    instance;
    interactionState = "SCHEDULED";
    firstTouchActiveMs = null;
    secondTouchActiveMs = null;
    lastTouchActiveMs = null;
    secondDeadlineActiveMs = null;
    settledAtActiveMs = null;
    latestActiveMs = 0;
    constructor(instance) {
      validateInstance(instance);
      this.instance = immutableSnapshot(instance);
    }
    get state() {
      return this.interactionState;
    }
    get secondDeadlineMs() {
      return this.secondDeadlineActiveMs;
    }
    isTerminalResult() {
      return this.interactionState === "HIT" || this.interactionState === "COMPLETED" || this.interactionState === "FALSE_TOUCH" || this.interactionState === "TIMEOUT" || this.interactionState === "GONE";
    }
    advanceTo(activeMs) {
      assertSafeNonNegative(activeMs, "activeMs");
      if (activeMs < this.latestActiveMs) throw new Error("object active time moved backwards");
      this.latestActiveMs = activeMs;
      if (this.isTerminalResult()) {
        if (this.interactionState === "TIMEOUT") {
          if (activeMs >= this.instance.activeDeadlineMs) this.interactionState = "GONE";
        } else if (this.interactionState !== "GONE" && this.settledAtActiveMs !== null && activeMs >= this.settledAtActiveMs + HIT_FEEDBACK_MS) {
          this.interactionState = "GONE";
        }
        return;
      }
      if (activeMs < this.instance.activeStartMs) {
        this.interactionState = "SCHEDULED";
        return;
      }
      if (this.interactionState === "WAIT_SECOND" && this.secondDeadlineActiveMs !== null && activeMs >= this.secondDeadlineActiveMs) {
        this.interactionState = "TIMEOUT";
        this.settledAtActiveMs = this.secondDeadlineActiveMs;
        return;
      }
      if (activeMs >= this.instance.activeDeadlineMs) {
        this.interactionState = "TIMEOUT";
        this.settledAtActiveMs = this.instance.activeDeadlineMs;
        return;
      }
      if (this.interactionState === "WAIT_SECOND") return;
      if (this.instance.isDouble) this.interactionState = "ACTIVE_FIRST";
      else if (activeMs < this.instance.enterEndMs) this.interactionState = "ENTERING";
      else if (activeMs < this.instance.exitStartMs) this.interactionState = "ACTIVE";
      else this.interactionState = "EXITING";
    }
    touch(activeMs) {
      assertSafeNonNegative(activeMs, "activeMs");
      this.advanceTo(activeMs);
      if (activeMs < this.instance.activeStartMs) return { disposition: "IGNORED_BEFORE_WINDOW", ...NO_CHANGE };
      if (activeMs >= this.instance.activeDeadlineMs || this.interactionState === "TIMEOUT") {
        return { disposition: "IGNORED_AT_OR_AFTER_DEADLINE", ...NO_CHANGE };
      }
      if (this.lastTouchActiveMs === activeMs) return { disposition: "IGNORED_SAME_TIMESTAMP", ...NO_CHANGE };
      this.lastTouchActiveMs = activeMs;
      if (this.interactionState === "HIT" || this.interactionState === "COMPLETED" || this.interactionState === "FALSE_TOUCH" || this.interactionState === "GONE") {
        return { disposition: "IGNORED_ALREADY_SETTLED", ...NO_CHANGE };
      }
      if (this.interactionState === "WAIT_SECOND") {
        if (this.secondDeadlineActiveMs === null || activeMs >= this.secondDeadlineActiveMs) {
          return { disposition: "IGNORED_AT_OR_AFTER_DEADLINE", ...NO_CHANGE };
        }
        this.secondTouchActiveMs = activeMs;
        this.interactionState = "COMPLETED";
        this.settledAtActiveMs = activeMs;
        return { disposition: "DOUBLE_COMPLETED", changedStatistics: true, hitDelta: 1, falseTouchDelta: 0 };
      }
      if (this.instance.role === "DISTRACTOR") {
        this.firstTouchActiveMs = activeMs;
        this.interactionState = "FALSE_TOUCH";
        this.settledAtActiveMs = activeMs;
        return { disposition: "DISTRACTOR_FALSE_TOUCH", changedStatistics: true, hitDelta: 0, falseTouchDelta: 1 };
      }
      if (this.instance.isDouble) {
        this.firstTouchActiveMs = activeMs;
        this.secondDeadlineActiveMs = Math.min(activeMs + this.instance.doubleWindowMs, this.instance.activeDeadlineMs);
        this.interactionState = "WAIT_SECOND";
        return { disposition: "DOUBLE_FIRST", changedStatistics: false, hitDelta: 0, falseTouchDelta: 0 };
      }
      this.firstTouchActiveMs = activeMs;
      this.interactionState = "HIT";
      this.settledAtActiveMs = activeMs;
      return { disposition: "TARGET_HIT", changedStatistics: true, hitDelta: 1, falseTouchDelta: 0 };
    }
    visualPhaseAt(activeMs) {
      this.advanceTo(activeMs);
      if (activeMs < this.instance.activeStartMs) return "HIDDEN";
      if (this.interactionState === "TIMEOUT") {
        if (activeMs >= this.instance.activeDeadlineMs) return "GONE";
        return activeMs < this.instance.exitStartMs ? "ACTIVE" : "EXITING";
      }
      if (this.settledAtActiveMs !== null) return activeMs < this.settledAtActiveMs + HIT_FEEDBACK_MS ? "FEEDBACK" : "GONE";
      if (activeMs >= this.instance.activeDeadlineMs) return "GONE";
      if (activeMs < this.instance.enterEndMs) return "ENTERING";
      if (activeMs < this.instance.exitStartMs) return "ACTIVE";
      return "EXITING";
    }
    presentationSnapshotAt(activeMs) {
      const visualPhase = this.visualPhaseAt(activeMs);
      const clickable = activeMs >= this.instance.activeStartMs && activeMs < this.instance.activeDeadlineMs && this.interactionState !== "HIT" && this.interactionState !== "COMPLETED" && this.interactionState !== "FALSE_TOUCH" && this.interactionState !== "TIMEOUT" && this.interactionState !== "GONE";
      const doubleProgress = !this.instance.isDouble ? 0 : this.secondTouchActiveMs !== null ? 2 : this.firstTouchActiveMs !== null ? 1 : 0;
      return immutableSnapshot({
        instanceId: this.instance.instanceId,
        waveOrdinal: this.instance.waveOrdinal,
        role: this.instance.role,
        fruitId: this.instance.fruitId,
        slotId: this.instance.slotId,
        isDouble: this.instance.isDouble,
        visualPhase,
        interactionState: this.interactionState,
        clickable,
        doubleProgress,
        secondDeadlineOperationMs: this.secondDeadlineActiveMs
      });
    }
    auditAt(activeMs) {
      this.advanceTo(activeMs);
      let outcome;
      if (this.instance.role === "DISTRACTOR") {
        if (this.firstTouchActiveMs !== null) outcome = "FALSE_TOUCH";
        else if (activeMs >= this.instance.activeDeadlineMs || this.interactionState === "TIMEOUT" || this.interactionState === "GONE") outcome = "AVOIDED";
        else outcome = "UNRESOLVED";
      } else if (this.interactionState === "HIT" || this.interactionState === "COMPLETED" || this.interactionState === "GONE" && this.firstTouchActiveMs !== null && (!this.instance.isDouble || this.secondTouchActiveMs !== null)) {
        outcome = "HIT";
      } else if (activeMs >= this.instance.activeDeadlineMs || this.interactionState === "TIMEOUT" || this.interactionState === "GONE") {
        outcome = "TIMEOUT";
      } else {
        outcome = "UNRESOLVED";
      }
      return immutableSnapshot({
        instanceId: this.instance.instanceId,
        fruitId: this.instance.fruitId,
        role: this.instance.role,
        slotId: this.instance.slotId,
        isDouble: this.instance.isDouble,
        firstTouchActiveMs: this.firstTouchActiveMs,
        secondTouchActiveMs: this.secondTouchActiveMs,
        outcome
      });
    }
  };

  // src/games/catch-light/logical-clock.ts
  var ActiveLogicalClock = class {
    clockState = "IDLE";
    accumulatedActiveMs = 0;
    runningSegmentStartUptimeMs = null;
    latestObservedUptimeMs = null;
    cutoffUptimeMs = null;
    get state() {
      return this.clockState;
    }
    start(effectiveStartUptimeMs2, cutoffUptimeMs2) {
      this.assertUptime(effectiveStartUptimeMs2, "effectiveStartUptimeMs");
      this.assertUptime(cutoffUptimeMs2, "cutoffUptimeMs");
      if (this.clockState !== "IDLE") throw new Error("clock can only start once");
      if (cutoffUptimeMs2 < effectiveStartUptimeMs2) throw new Error("cutoff precedes effective start");
      if (cutoffUptimeMs2 - effectiveStartUptimeMs2 !== SESSION_DURATION_MS) {
        throw new Error("initial cutoff must be exactly 300000ms after effective start");
      }
      this.runningSegmentStartUptimeMs = effectiveStartUptimeMs2;
      this.latestObservedUptimeMs = effectiveStartUptimeMs2;
      this.cutoffUptimeMs = cutoffUptimeMs2;
      this.clockState = "RUNNING";
    }
    /**
     * Validates a PAUSE boundary and computes its active time without mutating the
     * clock. The adapter uses this preflight before advancing domain state, so a
     * rejected PAUSE cannot close batches or consume input time as a side effect.
     */
    previewPause(effectivePauseUptimeMs) {
      if (this.clockState !== "RUNNING") throw new Error("pause requires RUNNING clock");
      this.assertUptime(effectivePauseUptimeMs, "effectivePauseUptimeMs");
      this.assertMonotonicCandidate(effectivePauseUptimeMs);
      if (this.cutoffUptimeMs === null) throw new Error("running clock has no cutoff");
      if (effectivePauseUptimeMs >= this.cutoffUptimeMs) {
        throw new Error("pause boundary must be strictly before the authoritative cutoff");
      }
      return this.runningActiveAt(effectivePauseUptimeMs);
    }
    pause(effectivePauseUptimeMs) {
      const active = this.previewPause(effectivePauseUptimeMs);
      this.latestObservedUptimeMs = effectivePauseUptimeMs;
      this.accumulatedActiveMs = active;
      this.runningSegmentStartUptimeMs = null;
      this.clockState = "PAUSED";
      return active;
    }
    /** Performs the complete RESUME validation without changing clock state. */
    validateResume(resumeInputEnabledUptimeMs, cutoffUptimeMs2) {
      if (this.clockState !== "PAUSED") throw new Error("resume requires PAUSED clock");
      this.assertUptime(resumeInputEnabledUptimeMs, "resumeInputEnabledUptimeMs");
      this.assertUptime(cutoffUptimeMs2, "cutoffUptimeMs");
      this.assertMonotonicCandidate(resumeInputEnabledUptimeMs);
      if (cutoffUptimeMs2 < resumeInputEnabledUptimeMs) throw new Error("cutoff precedes resumed input enable");
      const remainingActiveMs = SESSION_DURATION_MS - this.accumulatedActiveMs;
      if (cutoffUptimeMs2 - resumeInputEnabledUptimeMs !== remainingActiveMs) {
        throw new Error("resumed cutoff does not match the remaining active duration");
      }
    }
    resume(resumeInputEnabledUptimeMs, cutoffUptimeMs2) {
      this.validateResume(resumeInputEnabledUptimeMs, cutoffUptimeMs2);
      this.runningSegmentStartUptimeMs = resumeInputEnabledUptimeMs;
      this.latestObservedUptimeMs = resumeInputEnabledUptimeMs;
      this.cutoffUptimeMs = cutoffUptimeMs2;
      this.clockState = "RUNNING";
    }
    activeElapsedAt(uptimeMs2) {
      if (this.clockState === "IDLE") throw new Error("clock has not started");
      this.assertUptime(uptimeMs2, "uptimeMs");
      if (this.clockState === "DEADLINE") return this.accumulatedActiveMs;
      this.assertMonotonic(uptimeMs2);
      if (this.clockState === "PAUSED") return this.accumulatedActiveMs;
      return this.runningActiveAt(uptimeMs2);
    }
    deadline(cutoffUptimeMs2) {
      if (this.clockState !== "RUNNING") throw new Error("deadline requires RUNNING clock; paused time cannot satisfy the active-duration cutoff");
      this.assertUptime(cutoffUptimeMs2, "cutoffUptimeMs");
      if (this.cutoffUptimeMs !== null && cutoffUptimeMs2 !== this.cutoffUptimeMs) throw new Error("deadline cutoff differs from latest controller cutoff");
      const active = this.runningActiveAt(cutoffUptimeMs2);
      this.latestObservedUptimeMs = Math.max(this.latestObservedUptimeMs ?? cutoffUptimeMs2, cutoffUptimeMs2);
      this.accumulatedActiveMs = active;
      this.runningSegmentStartUptimeMs = null;
      this.clockState = "DEADLINE";
      return active;
    }
    runningActiveAt(uptimeMs2) {
      if (this.runningSegmentStartUptimeMs === null) throw new Error("running clock has no segment start");
      const boundedUptime = this.cutoffUptimeMs === null ? uptimeMs2 : Math.min(uptimeMs2, this.cutoffUptimeMs);
      const remainingActiveMs = SESSION_DURATION_MS - this.accumulatedActiveMs;
      const segmentActiveMs = Math.min(remainingActiveMs, Math.max(0, boundedUptime - this.runningSegmentStartUptimeMs));
      return this.accumulatedActiveMs + segmentActiveMs;
    }
    assertUptime(value, label) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
    }
    assertMonotonicCandidate(value) {
      if (this.latestObservedUptimeMs !== null && value < this.latestObservedUptimeMs) throw new Error("uptime moved backwards");
    }
    assertMonotonic(value) {
      this.assertUptime(value, "uptimeMs");
      this.assertMonotonicCandidate(value);
      this.latestObservedUptimeMs = value;
    }
  };

  // src/games/catch-light/scoring.ts
  function assertBatchCounts(H, T, F, D) {
    for (const [label, value] of [["H", H], ["T", T], ["F", F], ["D", D]]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
    }
    if (T <= 0 || T > 25 || H > T) throw new Error("require 0 <= H <= T <= 25 and T > 0");
    if (D !== 0 && D !== 5 && D !== 10) throw new Error("D must be exactly 0, 5, or 10");
    if (F > D) throw new Error("F cannot exceed D");
  }
  function assertResultZone(zone) {
    if (zone !== "UPGRADE" && zone !== "HOLD" && zone !== "FAIL") throw new Error(`invalid result zone: ${zone}`);
  }
  function roundHalfUpFraction(numerator, denominator) {
    if (!Number.isSafeInteger(numerator) || numerator < 0) throw new Error("numerator must be a non-negative safe integer");
    if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error("denominator must be a positive safe integer");
    const quotient = Math.floor(numerator / denominator);
    const remainder = numerator % denominator;
    return quotient + (remainder >= Math.ceil(denominator / 2) ? 1 : 0);
  }
  function resultZone(H, T, F, D) {
    assertBatchCounts(H, T, F, D);
    const upgradeFalseLimit = D === 0 ? 0 : D === 5 ? 1 : 2;
    const holdFalseLimit = D === 0 ? 0 : D === 5 ? 2 : 3;
    if (H * 100 >= T * 80 && F <= upgradeFalseLimit) return "UPGRADE";
    if (H * 100 >= T * 70 && F <= holdFalseLimit) return "HOLD";
    return "FAIL";
  }
  function batchScore(H, T, F, D, zone = resultZone(H, T, F, D)) {
    assertBatchCounts(H, T, F, D);
    assertResultZone(zone);
    const computedZone = resultZone(H, T, F, D);
    if (zone !== computedZone) throw new Error(`supplied result zone ${zone} is inconsistent with ${computedZone}`);
    const bonus = zone === "UPGRADE" ? 10 : 0;
    if (D === 0) return roundHalfUpFraction(90 * H, T) + bonus;
    return roundHalfUpFraction(70 * H, T) + roundHalfUpFraction(20 * (D - F), D) + bonus;
  }
  function applyLevelDecision(levelBefore, zone, consecutiveFailBefore) {
    if (!Number.isSafeInteger(levelBefore) || levelBefore < 1 || levelBefore > DESIGN_MAX_LEVEL) throw new Error("levelBefore outside 1..120");
    assertResultZone(zone);
    if (consecutiveFailBefore !== 0 && consecutiveFailBefore !== 1) throw new Error("consecutiveFailBefore must be 0 or 1");
    if (zone === "UPGRADE") {
      return levelBefore === DESIGN_MAX_LEVEL ? { resultZone: zone, levelTransition: "HOLD_MAX", levelAfter: DESIGN_MAX_LEVEL, consecutiveFailAfter: 0 } : { resultZone: zone, levelTransition: "UP", levelAfter: levelBefore + 1, consecutiveFailAfter: 0 };
    }
    if (zone === "HOLD") return { resultZone: zone, levelTransition: "HOLD", levelAfter: levelBefore, consecutiveFailAfter: 0 };
    if (consecutiveFailBefore === 0) return { resultZone: zone, levelTransition: "RETRY", levelAfter: levelBefore, consecutiveFailAfter: 1 };
    return levelBefore === 1 ? { resultZone: zone, levelTransition: "HOLD_MIN", levelAfter: 1, consecutiveFailAfter: 0 } : { resultZone: zone, levelTransition: "DOWN", levelAfter: levelBefore - 1, consecutiveFailAfter: 0 };
  }

  // src/games/catch-light/batch-engine.ts
  var IGNORED_PHASE = Object.freeze({
    disposition: "IGNORED_WRONG_INSTANCE_PHASE",
    changedStatistics: false,
    hitDelta: 0,
    falseTouchDelta: 0
  });
  var CatchLightBatchRuntime = class {
    batchOrdinal;
    batchStartActiveMs;
    operationStartActiveMs;
    operationEndActiveMs;
    closeAtActiveMs;
    levelBefore;
    consecutiveFailBefore;
    levelConfig;
    schedule;
    objects;
    H = 0;
    F = 0;
    totalObjectTouches = 0;
    blankTouches = 0;
    duplicateTouches = 0;
    latestSessionActiveMs;
    closedBatch = null;
    sealedAtActiveMs = null;
    constructor(args) {
      if (!Number.isSafeInteger(args.batchOrdinal) || args.batchOrdinal < 1 || args.batchOrdinal > 8) {
        throw new Error("batchOrdinal must be in 1..8");
      }
      if (!Number.isSafeInteger(args.batchStartActiveMs) || args.batchStartActiveMs < 0) {
        throw new Error("batchStartActiveMs must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(args.levelBefore) || args.levelBefore < 1 || args.levelBefore > 120) {
        throw new Error("levelBefore must be in 1..120");
      }
      if (args.consecutiveFailBefore !== 0 && args.consecutiveFailBefore !== 1) {
        throw new Error("consecutiveFailBefore must be 0 or 1");
      }
      this.batchOrdinal = args.batchOrdinal;
      this.batchStartActiveMs = args.batchStartActiveMs;
      this.operationStartActiveMs = args.batchStartActiveMs + PROMPT_DURATION_MS;
      this.operationEndActiveMs = this.operationStartActiveMs + OPERATION_DURATION_MS;
      this.closeAtActiveMs = args.batchStartActiveMs + BATCH_DURATION_MS;
      this.levelBefore = args.levelBefore;
      this.consecutiveFailBefore = args.consecutiveFailBefore;
      this.levelConfig = immutableSnapshot(args.levelConfig);
      this.schedule = immutableSnapshot(args.schedule);
      if (this.levelConfig.level !== this.levelBefore) throw new Error("levelBefore differs from levelConfig.level");
      if (this.schedule.batchOrdinal !== this.batchOrdinal) throw new Error("schedule batchOrdinal mismatch");
      validateGeneratedSchedule(this.schedule, this.levelConfig);
      this.latestSessionActiveMs = args.batchStartActiveMs;
      this.objects = new Map(
        this.schedule.waves.flatMap((wave) => wave.instances).map((instance) => [instance.instanceId, new FruitObjectRuntime(instance)])
      );
    }
    get hitCount() {
      return this.H;
    }
    get falseTouchCount() {
      return this.F;
    }
    get objectTouchCount() {
      return this.totalObjectTouches;
    }
    get blankTouchCount() {
      return this.blankTouches;
    }
    get duplicateTouchCount() {
      return this.duplicateTouches;
    }
    get isClosed() {
      return this.closedBatch !== null;
    }
    advanceToSessionActive(activeMs) {
      this.assertActiveMs(activeMs);
      if (activeMs < this.latestSessionActiveMs) throw new Error("batch active time moved backwards");
      if (this.sealedAtActiveMs !== null && activeMs > this.sealedAtActiveMs) throw new Error("batch cannot advance beyond its authoritative cutoff");
      this.latestSessionActiveMs = activeMs;
      const operationMs = Math.max(0, Math.min(OPERATION_DURATION_MS, activeMs - this.operationStartActiveMs));
      for (const object of this.objects.values()) object.advanceTo(operationMs);
    }
    snapshotAt(activeMs) {
      this.advanceToSessionActive(activeMs);
      const phase = this.phaseAt(activeMs);
      const operationElapsedMs = Math.max(0, Math.min(OPERATION_DURATION_MS, activeMs - this.operationStartActiveMs));
      const currentWaveOrdinal = operationElapsedMs < this.levelConfig.firstWaveMs ? 0 : Math.min(this.levelConfig.waveCount, Math.floor((operationElapsedMs - this.levelConfig.firstWaveMs) / this.levelConfig.waveSpacingMs) + 1);
      const visibleObjects = [...this.objects.values()].map((object) => object.presentationSnapshotAt(operationElapsedMs)).filter((snapshot) => snapshot.visualPhase !== "HIDDEN" && snapshot.visualPhase !== "GONE");
      return immutableSnapshot({
        batchOrdinal: this.batchOrdinal,
        levelBefore: this.levelBefore,
        batchStartActiveMs: this.batchStartActiveMs,
        phase,
        operationElapsedMs,
        currentWaveOrdinal,
        targetFruitId: this.schedule.targetFruitId,
        backgroundId: this.schedule.backgroundId,
        gridId: this.schedule.gridId,
        H: this.H,
        F: this.F,
        visibleObjects
      });
    }
    phaseAt(activeMs) {
      this.assertActiveMs(activeMs);
      if (this.closedBatch !== null || activeMs >= this.closeAtActiveMs) return "CLOSED";
      const relativeMs = activeMs - this.batchStartActiveMs;
      if (relativeMs < PROMPT_DURATION_MS) return "PROMPT";
      if (relativeMs < PROMPT_DURATION_MS + OPERATION_DURATION_MS) return "OPERATION";
      if (relativeMs < PROMPT_DURATION_MS + OPERATION_DURATION_MS + FEEDBACK_DURATION_MS) return "FEEDBACK";
      return "TRANSITION";
    }
    touchInstance(instanceId, activeMs) {
      if (this.closedBatch !== null || this.sealedAtActiveMs !== null) return IGNORED_PHASE;
      this.advanceToSessionActive(activeMs);
      if (activeMs < this.operationStartActiveMs || activeMs >= this.operationEndActiveMs) return IGNORED_PHASE;
      const object = this.objects.get(instanceId);
      if (object === void 0) return IGNORED_PHASE;
      this.totalObjectTouches += 1;
      const operationMs = activeMs - this.operationStartActiveMs;
      const result = object.touch(operationMs);
      this.H += result.hitDelta;
      this.F += result.falseTouchDelta;
      if (result.disposition === "IGNORED_SAME_TIMESTAMP" || result.disposition === "IGNORED_ALREADY_SETTLED") {
        this.duplicateTouches += 1;
      }
      return result;
    }
    touchBlank(activeMs) {
      if (this.closedBatch !== null || this.sealedAtActiveMs !== null) return;
      this.advanceToSessionActive(activeMs);
      if (activeMs >= this.operationStartActiveMs && activeMs < this.operationEndActiveMs) this.blankTouches += 1;
    }
    close(activeMs) {
      if (this.closedBatch !== null) return this.closedBatch;
      if (this.sealedAtActiveMs !== null) throw new Error("incomplete batch cannot be closed after authoritative cutoff sealing");
      if (activeMs !== this.closeAtActiveMs) throw new Error(`batch must close exactly at ${this.closeAtActiveMs}`);
      if (activeMs > SESSION_DURATION_MS) throw new Error("batch closed after the session deadline");
      this.advanceToSessionActive(activeMs);
      const audits = this.instanceAuditsAtOperationMs(OPERATION_DURATION_MS);
      const zone = resultZone(this.H, this.levelConfig.targetTotal, this.F, this.levelConfig.distractorTotal);
      const decision = applyLevelDecision(this.levelBefore, zone, this.consecutiveFailBefore);
      const metrics = {
        metricsVersion: "catch-light-batch-metrics-2",
        H: this.H,
        T: this.levelConfig.targetTotal,
        F: this.F,
        D: this.levelConfig.distractorTotal,
        targetFruitId: this.schedule.targetFruitId,
        backgroundId: this.schedule.backgroundId,
        configSetId: this.schedule.configSetId,
        generatorVersion: this.schedule.generatorVersion,
        difficultyStateId: this.levelConfig.difficultyStateId,
        timingProfile: this.levelConfig.timingBand,
        contentVariantId: this.levelConfig.contentVariantId,
        waveProfileId: this.levelConfig.waveProfileId,
        seedKey: this.levelConfig.seedKey,
        scheduleSha256: this.schedule.scheduleSha256,
        firstTeachingBatchWaveOneDoubleSuppressed: this.schedule.firstTeachingBatchWaveOneDoubleSuppressed,
        instanceAuditSha256: canonicalSha256(audits),
        targetTimeouts: audits.filter((audit) => audit.role === "TARGET" && audit.outcome === "TIMEOUT").length,
        distractorAvoided: audits.filter((audit) => audit.role === "DISTRACTOR" && audit.outcome === "AVOIDED").length,
        doubleTargets: audits.filter((audit) => audit.role === "TARGET" && audit.isDouble).length,
        doubleCompleted: audits.filter((audit) => audit.role === "TARGET" && audit.isDouble && audit.outcome === "HIT").length,
        doubleFirstOnly: audits.filter((audit) => audit.role === "TARGET" && audit.isDouble && audit.firstTouchActiveMs !== null && audit.secondTouchActiveMs === null).length,
        totalObjectTouches: this.totalObjectTouches,
        blankTouches: this.blankTouches,
        duplicateTouches: this.duplicateTouches,
        consecutiveFailBefore: this.consecutiveFailBefore,
        consecutiveFailAfter: decision.consecutiveFailAfter
      };
      const projection = {
        batchOrdinal: this.batchOrdinal,
        closed: true,
        decisionEligible: true,
        levelBefore: this.levelBefore,
        resultZone: decision.resultZone,
        levelTransition: decision.levelTransition,
        levelAfter: decision.levelAfter,
        batchScore: batchScore(this.H, this.levelConfig.targetTotal, this.F, this.levelConfig.distractorTotal, zone),
        closedAtActiveMs: activeMs,
        gameBatchMetrics: metrics
      };
      const closed = immutableSnapshot({ ...projection, batchPayloadSha256: canonicalSha256(projection) });
      this.closedBatch = closed;
      return closed;
    }
    sealIncompleteAt(cutoffActiveMs) {
      if (this.closedBatch !== null) throw new Error("closed batch cannot be sealed as incomplete");
      if (cutoffActiveMs >= this.closeAtActiveMs) throw new Error("an incomplete cutoff must precede the formal batch close time");
      if (this.sealedAtActiveMs !== null) {
        if (cutoffActiveMs !== this.sealedAtActiveMs) throw new Error("incomplete batch cutoff cannot change after sealing");
        return this.partialMetricsAt(cutoffActiveMs);
      }
      this.advanceToSessionActive(cutoffActiveMs);
      this.sealedAtActiveMs = cutoffActiveMs;
      return this.partialMetricsAt(cutoffActiveMs);
    }
    partialMetricsAt(cutoffActiveMs) {
      if (this.closedBatch !== null) throw new Error("closed batch cannot emit partial metrics");
      this.assertActiveMs(cutoffActiveMs);
      this.advanceToSessionActive(cutoffActiveMs);
      const relative = cutoffActiveMs - this.batchStartActiveMs;
      const phase = relative < PROMPT_DURATION_MS ? "PROMPT" : relative < PROMPT_DURATION_MS + OPERATION_DURATION_MS ? "OPERATION" : relative < PROMPT_DURATION_MS + OPERATION_DURATION_MS + FEEDBACK_DURATION_MS ? "FEEDBACK" : "TRANSITION";
      const operationMs = Math.max(0, Math.min(OPERATION_DURATION_MS, cutoffActiveMs - this.operationStartActiveMs));
      const audits = this.instanceAuditsAtOperationMs(operationMs);
      const presented = this.schedule.waves.flatMap((wave) => wave.instances).filter((instance) => instance.activeStartMs <= operationMs);
      const presentedIds = new Set(presented.map((instance) => instance.instanceId));
      const presentedAudits = audits.filter((audit) => presentedIds.has(audit.instanceId));
      const waveOrdinal = operationMs < this.levelConfig.firstWaveMs ? 0 : Math.min(this.levelConfig.waveCount, Math.floor((operationMs - this.levelConfig.firstWaveMs) / this.levelConfig.waveSpacingMs) + 1);
      const partial = {
        metricsVersion: "catch-light-partial-metrics-2",
        phase,
        waveOrdinal,
        presentedTargetCount: presented.filter((instance) => instance.role === "TARGET").length,
        presentedDistractorCount: presented.filter((instance) => instance.role === "DISTRACTOR").length,
        H: this.H,
        F: this.F,
        unresolvedTargetCount: presentedAudits.filter((audit) => audit.role === "TARGET" && audit.outcome === "UNRESOLVED").length,
        totalObjectTouches: this.totalObjectTouches,
        blankTouches: this.blankTouches,
        duplicateTouches: this.duplicateTouches,
        scheduleSha256: this.schedule.scheduleSha256,
        firstTeachingBatchWaveOneDoubleSuppressed: this.schedule.firstTeachingBatchWaveOneDoubleSuppressed,
        instanceAuditSha256: canonicalSha256(presentedAudits)
      };
      return immutableSnapshot(partial);
    }
    instanceAuditsAtOperationMs(operationMs) {
      return [...this.objects.values()].map((object) => object.auditAt(operationMs)).sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    }
    assertActiveMs(value) {
      if (!Number.isSafeInteger(value) || value < this.batchStartActiveMs) throw new Error("activeMs is before this batch or is not a safe integer");
    }
  };
  if (PROMPT_DURATION_MS + OPERATION_DURATION_MS + FEEDBACK_DURATION_MS + TRANSITION_DURATION_MS !== BATCH_DURATION_MS) {
    throw new Error("catch-light batch phase durations do not sum to 37500ms");
  }

  // src/games/catch-light/session-engine.ts
  var UnsupportedSliceTransitionError = class extends Error {
    fromLevel;
    toLevel;
    batchOrdinal;
    constructor(fromLevel, toLevel, batchOrdinal) {
      super(`W2 released slices cannot start B${batchOrdinal} after L${fromLevel}->L${toLevel}; implicit nearest-level fallback is forbidden`);
      this.name = "UnsupportedSliceTransitionError";
      this.fromLevel = fromLevel;
      this.toLevel = toLevel;
      this.batchOrdinal = batchOrdinal;
    }
  };
  var IGNORED_INPUT = Object.freeze({
    disposition: "IGNORED_WRONG_INSTANCE_PHASE",
    changedStatistics: false,
    hitDelta: 0,
    falseTouchDelta: 0
  });
  var CatchLightSession = class {
    gameConfig;
    configByLevel;
    runtimeConfigHash;
    sessionSeed;
    sessionStartLevel;
    sessionBackgroundId;
    batchStartDelaysMs;
    onBatchClosed;
    eligibleBatches = [];
    pendingBatchNotifications = [];
    introducedLevels;
    flushingBatchNotifications = false;
    currentBatch = null;
    nextBatchOrdinal = 1;
    nextBatchStartActiveMs;
    currentLevel;
    consecutiveFail = 0;
    latestActiveMs = 0;
    pauseCount = 0;
    totalPausedDurationMs = 0;
    deadlineReached = false;
    incompleteAudit = Object.freeze([]);
    constructor(options) {
      const detachedConfig = immutableSnapshot(options.gameConfig);
      validateVerticalSliceConfig(detachedConfig);
      if (!/^[0-9a-f]{64}$/.test(options.runtimeConfigHash)) throw new Error("runtimeConfigHash must be lowercase SHA-256");
      if (!Number.isSafeInteger(options.sessionSeed) || options.sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
      if (!CATCH_LIGHT_RUNTIME_SLICE_LEVELS.includes(options.sessionStartLevel)) {
        throw new Error(`sessionStartLevel ${options.sessionStartLevel} is not one of the released W2 runtime slices`);
      }
      this.gameConfig = detachedConfig;
      this.configByLevel = new Map(detachedConfig.levels.map((config) => [config.level, config]));
      this.runtimeConfigHash = options.runtimeConfigHash;
      this.sessionSeed = options.sessionSeed;
      this.sessionStartLevel = options.sessionStartLevel;
      this.currentLevel = options.sessionStartLevel;
      this.sessionBackgroundId = this.requireLevelConfig(options.sessionStartLevel).backgroundId;
      this.batchStartDelaysMs = immutableSnapshot([...options.batchStartDelaysMs ?? []]);
      if (this.batchStartDelaysMs.length > PLANNED_BATCH_COUNT) throw new Error("too many batch start delays");
      for (const delay of this.batchStartDelaysMs) {
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > SESSION_DURATION_MS) {
          throw new Error("batch start delays must be safe integers in 0..300000");
        }
      }
      this.nextBatchStartActiveMs = this.delayForOrdinal(1);
      const previouslyIntroducedLevels = [...options.previouslyIntroducedLevels ?? []];
      const uniqueIntroducedLevels = /* @__PURE__ */ new Set();
      for (const introducedLevel of previouslyIntroducedLevels) {
        if (!Number.isSafeInteger(introducedLevel) || introducedLevel < 1 || introducedLevel > DESIGN_MAX_LEVEL) {
          throw new Error(`previouslyIntroducedLevels contains invalid level ${String(introducedLevel)}`);
        }
        if (uniqueIntroducedLevels.has(introducedLevel)) {
          throw new Error(`previouslyIntroducedLevels contains duplicate level ${introducedLevel}`);
        }
        uniqueIntroducedLevels.add(introducedLevel);
      }
      this.introducedLevels = uniqueIntroducedLevels;
      this.onBatchClosed = options.onBatchClosed;
    }
    get currentBatchView() {
      const batch2 = this.currentBatch;
      if (batch2 === null) return null;
      return immutableSnapshot({
        batchOrdinal: batch2.batchOrdinal,
        levelBefore: batch2.levelBefore,
        batchStartActiveMs: batch2.batchStartActiveMs,
        operationStartActiveMs: batch2.operationStartActiveMs,
        operationEndActiveMs: batch2.operationEndActiveMs,
        closeAtActiveMs: batch2.closeAtActiveMs,
        levelConfig: batch2.levelConfig,
        schedule: batch2.schedule
      });
    }
    get closedBatches() {
      return immutableSnapshot(this.eligibleBatches);
    }
    get activeElapsedMs() {
      return this.latestActiveMs;
    }
    get isDeadlineReached() {
      return this.deadlineReached;
    }
    get pendingBatchNotificationCount() {
      return this.pendingBatchNotifications.length;
    }
    get isCurrentAdvanceSettled() {
      if (this.pendingBatchNotifications.length !== 0) return false;
      if (this.currentBatch !== null) {
        return this.latestActiveMs < this.currentBatch.closeAtActiveMs || this.currentBatch.closeAtActiveMs > SESSION_DURATION_MS;
      }
      return this.nextBatchOrdinal > PLANNED_BATCH_COUNT || this.nextBatchStartActiveMs >= SESSION_DURATION_MS || this.latestActiveMs < this.nextBatchStartActiveMs;
    }
    retryPendingBatchNotifications() {
      this.assertNotInBatchNotification();
      this.flushPendingBatchNotifications();
    }
    validatePauseInterval(pausedDurationMs) {
      this.assertNotInBatchNotification();
      if (this.deadlineReached) throw new Error("cannot record pause after deadline");
      if (!Number.isSafeInteger(pausedDurationMs) || pausedDurationMs < 0) {
        throw new Error("pausedDurationMs must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(this.totalPausedDurationMs + pausedDurationMs)) {
        throw new Error("total paused duration exceeds safe integer range");
      }
      if (!Number.isSafeInteger(this.pauseCount + 1)) throw new Error("pause count exceeds safe integer range");
    }
    recordPauseInterval(pausedDurationMs) {
      this.validatePauseInterval(pausedDurationMs);
      this.pauseCount += 1;
      this.totalPausedDurationMs += pausedDurationMs;
    }
    advanceToActive(activeMs) {
      this.assertNotInBatchNotification();
      if (!Number.isSafeInteger(activeMs) || activeMs < 0 || activeMs > SESSION_DURATION_MS) throw new Error("activeMs outside 0..300000");
      if (activeMs < this.latestActiveMs) throw new Error("session active time moved backwards");
      if (this.deadlineReached && activeMs !== SESSION_DURATION_MS) throw new Error("cannot advance after deadline");
      this.flushPendingBatchNotifications();
      this.latestActiveMs = activeMs;
      while (true) {
        if (this.currentBatch === null) {
          if (this.nextBatchOrdinal > PLANNED_BATCH_COUNT || this.nextBatchStartActiveMs >= SESSION_DURATION_MS || activeMs < this.nextBatchStartActiveMs) break;
          const level2 = this.requireLevelConfig(this.currentLevel);
          const firstFormalTeachingBatch = !this.introducedLevels.has(level2.level);
          const schedule = generateBatchSchedule(level2, this.sessionSeed, this.nextBatchOrdinal, {
            backgroundIdOverride: this.sessionBackgroundId,
            firstFormalTeachingBatch
          });
          this.currentBatch = new CatchLightBatchRuntime({
            batchOrdinal: this.nextBatchOrdinal,
            batchStartActiveMs: this.nextBatchStartActiveMs,
            levelBefore: this.currentLevel,
            consecutiveFailBefore: this.consecutiveFail,
            levelConfig: level2,
            schedule
          });
          this.introducedLevels.add(level2.level);
        }
        const batch2 = this.currentBatch;
        if (activeMs >= batch2.closeAtActiveMs && batch2.closeAtActiveMs <= SESSION_DURATION_MS) {
          const closed = immutableSnapshot(batch2.close(batch2.closeAtActiveMs));
          this.eligibleBatches.push(closed);
          this.currentLevel = closed.levelAfter;
          this.consecutiveFail = closed.gameBatchMetrics.consecutiveFailAfter;
          this.currentBatch = null;
          this.nextBatchOrdinal += 1;
          this.nextBatchStartActiveMs = closed.closedAtActiveMs + this.delayForOrdinal(this.nextBatchOrdinal);
          if (this.onBatchClosed !== void 0) this.pendingBatchNotifications.push(closed);
          this.flushPendingBatchNotifications();
          continue;
        }
        batch2.advanceToSessionActive(activeMs);
        break;
      }
    }
    touchInstance(instanceId, activeMs) {
      this.advanceToActive(activeMs);
      if (activeMs >= SESSION_DURATION_MS || this.deadlineReached || this.currentBatch === null) return IGNORED_INPUT;
      return this.currentBatch.touchInstance(instanceId, activeMs);
    }
    touchBlank(activeMs) {
      this.advanceToActive(activeMs);
      if (activeMs < SESSION_DURATION_MS && !this.deadlineReached && this.currentBatch !== null) this.currentBatch.touchBlank(activeMs);
    }
    deadline() {
      this.assertNotInBatchNotification();
      if (this.deadlineReached) return;
      this.advanceToActive(SESSION_DURATION_MS);
      if (this.currentBatch !== null && !this.currentBatch.isClosed) {
        const partialMetrics = this.currentBatch.sealIncompleteAt(SESSION_DURATION_MS);
        this.incompleteAudit = immutableSnapshot([{
          batchOrdinal: this.currentBatch.batchOrdinal,
          levelBefore: this.currentBatch.levelBefore,
          cutoffReason: "DEADLINE",
          startedAtActiveMs: this.currentBatch.batchStartActiveMs,
          cutoffAtActiveMs: SESSION_DURATION_MS,
          partialMetrics
        }]);
      }
      this.deadlineReached = true;
    }
    snapshotAtActive(activeMs) {
      this.advanceToActive(activeMs);
      return this.snapshot();
    }
    snapshot() {
      this.assertNotInBatchNotification();
      const currentBatch = this.currentBatch === null ? null : this.currentBatch.snapshotAt(this.latestActiveMs);
      const snapshot = {
        activeElapsedMs: this.latestActiveMs,
        sessionStartLevel: this.sessionStartLevel,
        currentLevel: this.currentLevel,
        backgroundId: this.sessionBackgroundId,
        deadlineReached: this.deadlineReached,
        eligibleBatchCount: this.eligibleBatches.length,
        sessionRawScore: this.eligibleBatches.reduce((sum, batch2) => sum + batch2.batchScore, 0),
        nextBatchOrdinal: this.nextBatchOrdinal,
        consecutiveFail: this.consecutiveFail,
        pendingBatchNotificationCount: this.pendingBatchNotifications.length,
        pendingBatchNotificationHashes: this.pendingBatchNotifications.map((batch2) => batch2.batchPayloadSha256),
        currentBatch
      };
      return immutableSnapshot(snapshot);
    }
    buildResultDraft() {
      this.assertNotInBatchNotification();
      if (!this.deadlineReached) throw new Error("result draft is unavailable before the 300000ms deadline");
      if (this.pendingBatchNotifications.length > 0) throw new Error("result draft is unavailable while batch-close notifications are pending");
      const eligible = immutableSnapshot(this.eligibleBatches);
      const incomplete = immutableSnapshot([...this.incompleteAudit]);
      const presentedLevels = [this.sessionStartLevel, ...eligible.map((batch2) => batch2.levelBefore), ...incomplete.map((audit) => audit.levelBefore)];
      const passedLevels = eligible.filter((batch2) => batch2.resultZone === "UPGRADE").map((batch2) => batch2.levelBefore);
      const eligibleMetrics = eligible.map((batch2) => batch2.gameBatchMetrics);
      const currentPartial = incomplete[0]?.partialMetrics ?? null;
      const totalObjectTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.totalObjectTouches, 0) + (currentPartial?.totalObjectTouches ?? 0);
      const blankTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.blankTouches, 0) + (currentPartial?.blankTouches ?? 0);
      const duplicateTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.duplicateTouches, 0) + (currentPartial?.duplicateTouches ?? 0);
      const targetInstances = eligibleMetrics.reduce((sum, metrics) => sum + metrics.T, 0);
      const targetHits = eligibleMetrics.reduce((sum, metrics) => sum + metrics.H, 0);
      const distractorInstances = eligibleMetrics.reduce((sum, metrics) => sum + metrics.D, 0);
      const falseTouches = eligibleMetrics.reduce((sum, metrics) => sum + metrics.F, 0);
      const sessionMetrics = {
        metricsVersion: "catch-light-session-metrics-1",
        passEngineType: "PE-EVENT",
        configSetId: this.gameConfig.configSetId,
        generatorVersion: this.gameConfig.generatorVersion,
        scoringRuleVersion: CATCH_LIGHT_SCORING_RULE_VERSION,
        resultSchemaVersion: CATCH_LIGHT_RESULT_SCHEMA_VERSION,
        sessionSeed: this.sessionSeed,
        backgroundId: this.sessionBackgroundId,
        pauseCount: this.pauseCount,
        totalPausedDurationMs: this.totalPausedDurationMs,
        eligibleBatchCount: eligible.length,
        incompleteBatchCount: incomplete.length,
        H: targetHits,
        T: targetInstances,
        F: falseTouches,
        D: distractorInstances,
        eligibleTargetInstances: targetInstances,
        eligibleTargetHits: targetHits,
        eligibleDistractorInstances: distractorInstances,
        eligibleDistractorFalseTouches: falseTouches,
        eligibleDoubleTargets: eligibleMetrics.reduce((sum, metrics) => sum + metrics.doubleTargets, 0),
        eligibleDoubleCompleted: eligibleMetrics.reduce((sum, metrics) => sum + metrics.doubleCompleted, 0),
        totalObjectTouches,
        blankTouches,
        duplicateTouches,
        hitRateBasisPoints: targetInstances === 0 ? null : Math.floor(targetHits * 1e4 / targetInstances),
        distractorAvoidanceBasisPoints: distractorInstances === 0 ? null : Math.floor((distractorInstances - falseTouches) * 1e4 / distractorInstances),
        scheduleAuditSha256: canonicalSha256({
          eligible: eligibleMetrics.map((metrics) => metrics.scheduleSha256),
          incomplete: incomplete.map((audit) => audit.partialMetrics.scheduleSha256)
        })
      };
      const result = {
        gameCode: "CATCH_LIGHT",
        gamePayloadVersion: "A620-GP-1.1",
        runtimeConfigHash: this.runtimeConfigHash,
        designMaxLevel: DESIGN_MAX_LEVEL,
        plannedBatchCount: PLANNED_BATCH_COUNT,
        eligibleBatchCount: eligible.length,
        eligibleBatches: eligible,
        incompleteBatchAudit: incomplete,
        sessionStartLevel: this.sessionStartLevel,
        sessionEndLevel: this.currentLevel,
        sessionHighestPresentedLevel: Math.max(...presentedLevels),
        sessionHighestPassedLevel: passedLevels.length === 0 ? null : Math.max(...passedLevels),
        nextStartLevel: this.currentLevel,
        sessionRawScore: eligible.reduce((sum, batch2) => sum + batch2.batchScore, 0),
        sessionRawScoreMax: PLANNED_BATCH_COUNT * 100,
        actualTrainingMs: SESSION_DURATION_MS,
        gameMetrics: sessionMetrics
      };
      return immutableSnapshot(result);
    }
    flushPendingBatchNotifications() {
      if (this.pendingBatchNotifications.length === 0) return;
      if (this.onBatchClosed === void 0) {
        this.pendingBatchNotifications.length = 0;
        return;
      }
      if (this.flushingBatchNotifications) throw new Error("onBatchClosed callback must not re-enter the Catch Light session");
      this.flushingBatchNotifications = true;
      try {
        while (this.pendingBatchNotifications.length > 0) {
          const next = this.pendingBatchNotifications[0];
          this.onBatchClosed(immutableSnapshot(next));
          this.pendingBatchNotifications.shift();
        }
      } finally {
        this.flushingBatchNotifications = false;
      }
    }
    assertNotInBatchNotification() {
      if (this.flushingBatchNotifications) throw new Error("onBatchClosed callback must not re-enter the Catch Light session");
    }
    delayForOrdinal(ordinal) {
      if (ordinal < 1 || ordinal > PLANNED_BATCH_COUNT) return 0;
      return this.batchStartDelaysMs[ordinal - 1] ?? 0;
    }
    requireLevelConfig(level2) {
      const config = this.configByLevel.get(level2);
      if (config !== void 0) return config;
      const lastClosed = this.eligibleBatches.at(-1);
      if (lastClosed !== void 0 && lastClosed.levelAfter === level2) {
        throw new UnsupportedSliceTransitionError(lastClosed.levelBefore, level2, this.nextBatchOrdinal);
      }
      throw new Error(`level ${level2} is absent from W2 vertical slices; refusing implicit fallback`);
    }
  };

  // src/game-plugin.ts
  var TrainingPointerEventGate = class {
    processedEventIds = /* @__PURE__ */ new Set();
    activePointerIds = /* @__PURE__ */ new Set();
    accept(event) {
      if (typeof event.pointerEventId !== "string" || event.pointerEventId.length === 0) {
        throw new Error("pointerEventId must not be empty");
      }
      if (typeof event.pointerId !== "string" || event.pointerId.length === 0) {
        throw new Error("pointerId must not be empty");
      }
      if (!Number.isSafeInteger(event.sourceUptimeMs) || event.sourceUptimeMs < 0) {
        throw new Error("sourceUptimeMs must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(event.xPx) || !Number.isSafeInteger(event.yPx)) {
        throw new Error("pointer coordinates must be safe integers");
      }
      if (event.hitToken !== null && (typeof event.hitToken !== "string" || event.hitToken.length === 0)) {
        throw new Error("hitToken must be null or a non-empty string");
      }
      if (event.phase !== "DOWN" && event.phase !== "MOVE" && event.phase !== "UP" && event.phase !== "CANCEL") {
        throw new Error(`unsupported pointer phase ${String(event.phase)}`);
      }
      if (this.processedEventIds.has(event.pointerEventId)) return "IGNORE";
      this.processedEventIds.add(event.pointerEventId);
      if (event.phase === "DOWN") {
        if (this.activePointerIds.has(event.pointerId)) return "IGNORE";
        this.activePointerIds.add(event.pointerId);
        return "DOWN";
      }
      if (event.phase === "UP" || event.phase === "CANCEL") this.activePointerIds.delete(event.pointerId);
      return "IGNORE";
    }
    cancelAll(reason) {
      if (reason !== "PAUSE" && reason !== "DEADLINE" && reason !== "TERMINATE") {
        throw new Error(`unsupported input cancellation reason ${String(reason)}`);
      }
      this.activePointerIds.clear();
    }
    rollbackDown(event) {
      this.processedEventIds.delete(event.pointerEventId);
      this.activePointerIds.delete(event.pointerId);
    }
    reset() {
      this.processedEventIds.clear();
      this.activePointerIds.clear();
    }
  };

  // src/games/catch-light/adapter.ts
  var IGNORED_INPUT2 = Object.freeze({
    disposition: "IGNORED_WRONG_INSTANCE_PHASE",
    changedStatistics: false,
    hitDelta: 0,
    falseTouchDelta: 0
  });
  var CatchLightGameModule = class {
    gameCode = "CATCH_LIGHT";
    onBatchClosed;
    previouslyIntroducedLevels;
    inputGate = new TrainingPointerEventGate();
    preparedExecution = null;
    session = null;
    clock = null;
    pauseStartedUptimeMs = null;
    localState = "UNPREPARED";
    deliveringBatchClosed = false;
    constructor(hooks = {}) {
      this.onBatchClosed = hooks.onBatchClosed;
      this.previouslyIntroducedLevels = Object.freeze([...hooks.previouslyIntroducedLevels ?? []]);
    }
    get moduleState() {
      return this.localState;
    }
    setEvidenceSink(sink) {
      this.assertNotInBatchClosedHook("setEvidenceSink");
      if (typeof sink !== "function") throw new Error("evidence sink must be a function");
      if (this.onBatchClosed === void 0 && this.localState !== "UNPREPARED" && this.localState !== "READY" && this.localState !== "DISPOSED") {
        throw new Error("the initial evidence sink must be installed before START");
      }
      this.onBatchClosed = sink;
    }
    async prepare(context) {
      this.assertNotInBatchClosedHook("prepare");
      if (this.localState !== "UNPREPARED" && this.localState !== "DISPOSED") {
        throw new Error(`prepare is illegal while module state is ${this.localState}`);
      }
      if (context.gameCode !== this.gameCode) throw new Error(`CatchLightGameModule cannot prepare ${context.gameCode}`);
      if (context.durationMs !== SESSION_DURATION_MS) throw new Error("Catch Light requires durationMs=300000");
      if (!Number.isSafeInteger(context.sessionSeed) || context.sessionSeed < 0) {
        throw new Error("sessionSeed must be a non-negative safe integer");
      }
      if (!CATCH_LIGHT_RUNTIME_SLICE_LEVELS.includes(context.sessionStartLevel)) {
        throw new Error(`sessionStartLevel ${context.sessionStartLevel} is not one of the released W2 runtime slices`);
      }
      if (!/^[0-9a-f]{64}$/.test(context.runtimeConfigHash)) {
        throw new Error("runtimeConfigHash must be lowercase SHA-256");
      }
      const gameConfig = parseStrictGameConfig(context.gameConfig);
      this.preparedExecution = immutableSnapshot({
        sessionSeed: context.sessionSeed,
        sessionStartLevel: context.sessionStartLevel,
        runtimeConfigHash: context.runtimeConfigHash,
        gameConfig
      });
      this.session = null;
      this.clock = null;
      this.pauseStartedUptimeMs = null;
      this.inputGate.reset();
      this.localState = "READY";
    }
    onStart(effectiveStartUptimeMs2, cutoffUptimeMs2) {
      this.assertNotInBatchClosedHook("START");
      this.requireState("START", "READY");
      const prepared = this.requirePreparedExecution();
      const clock = new ActiveLogicalClock();
      clock.start(effectiveStartUptimeMs2, cutoffUptimeMs2);
      const sessionOptions = {
        gameConfig: prepared.gameConfig,
        runtimeConfigHash: prepared.runtimeConfigHash,
        sessionSeed: prepared.sessionSeed,
        sessionStartLevel: prepared.sessionStartLevel,
        previouslyIntroducedLevels: this.previouslyIntroducedLevels
      };
      const session = this.onBatchClosed === void 0 ? new CatchLightSession(sessionOptions) : new CatchLightSession({ ...sessionOptions, onBatchClosed: (batch2) => this.deliverBatchClosed(batch2) });
      session.advanceToActive(0);
      this.clock = clock;
      this.session = session;
      this.pauseStartedUptimeMs = null;
      this.localState = "RUNNING";
    }
    onPause(effectivePauseUptimeMs) {
      this.assertNotInBatchClosedHook("PAUSE");
      this.requireState("PAUSE", "RUNNING");
      const clock = this.requireClock();
      const active = clock.previewPause(effectivePauseUptimeMs);
      this.requireSession().advanceToActive(active);
      clock.pause(effectivePauseUptimeMs);
      this.pauseStartedUptimeMs = effectivePauseUptimeMs;
      this.localState = "PAUSED";
    }
    onResume(resumeInputEnabledUptimeMs, cutoffUptimeMs2) {
      this.assertNotInBatchClosedHook("RESUME");
      this.requireState("RESUME", "PAUSED");
      const pauseStartedUptimeMs2 = this.pauseStartedUptimeMs;
      if (pauseStartedUptimeMs2 === null) throw new Error("PAUSED module has no recorded pause boundary");
      if (!Number.isSafeInteger(resumeInputEnabledUptimeMs) || resumeInputEnabledUptimeMs < pauseStartedUptimeMs2) {
        throw new Error("resumeInputEnabledUptimeMs must not precede the pause");
      }
      const pausedDurationMs = resumeInputEnabledUptimeMs - pauseStartedUptimeMs2;
      const clock = this.requireClock();
      const session = this.requireSession();
      clock.validateResume(resumeInputEnabledUptimeMs, cutoffUptimeMs2);
      session.validatePauseInterval(pausedDurationMs);
      clock.resume(resumeInputEnabledUptimeMs, cutoffUptimeMs2);
      session.recordPauseInterval(pausedDurationMs);
      this.pauseStartedUptimeMs = null;
      this.localState = "RUNNING";
    }
    onDeadline(cutoffUptimeMs2) {
      this.assertNotInBatchClosedHook("DEADLINE");
      if (this.localState === "TERMINATED") return;
      const session = this.requireSession();
      if (this.onBatchClosed !== void 0 && (session.activeElapsedMs !== SESSION_DURATION_MS || session.pendingBatchNotificationCount !== 0 || !session.isCurrentAdvanceSettled)) {
        throw new Error("interactive host must advance and persist BATCH_CLOSED before DEADLINE");
      }
      if (this.localState === "DEADLINE") {
        if (this.onBatchClosed === void 0) session.retryPendingBatchNotifications();
        session.deadline();
        return;
      }
      this.requireState("DEADLINE", "RUNNING");
      const active = this.requireClock().deadline(cutoffUptimeMs2);
      this.localState = "DEADLINE";
      if (active !== SESSION_DURATION_MS) {
        throw new Error(`controller deadline produced ${active} active ms instead of 300000`);
      }
      session.deadline();
    }
    onTerminate(_) {
      this.assertNotInBatchClosedHook("TERMINATE");
      if (this.localState === "DISPOSED" || this.localState === "UNPREPARED" || this.localState === "TERMINATED") return;
      this.localState = "TERMINATED";
      this.pauseStartedUptimeMs = null;
    }
    advanceToUptime(uptimeMs2) {
      this.assertNotInBatchClosedHook("advance");
      this.requireState("advance", "RUNNING");
      const active = this.requireClock().activeElapsedAt(uptimeMs2);
      this.requireSession().advanceToActive(active);
      return active;
    }
    /**
     * Returns the last committed domain snapshot without advancing the logical
     * clock or closing a batch. Public v1.3 defines QUERY_STATE as non-mutating;
     * explicit frame/input paths must call advanceToUptime/touch instead.
     *
     * uptimeMs is validated only as request metadata. It deliberately does not
     * participate in monotonic-clock ownership, so a diagnostic query cannot
     * make a later PAUSE/RESUME boundary look like a rollback.
     */
    snapshotAtUptime(uptimeMs2) {
      this.assertNotInBatchClosedHook("snapshot");
      if (this.localState !== "RUNNING" && this.localState !== "PAUSED" && this.localState !== "DEADLINE") {
        throw new Error(`snapshot is illegal while module state is ${this.localState}`);
      }
      if (!Number.isSafeInteger(uptimeMs2) || uptimeMs2 < 0) {
        throw new Error("snapshot uptimeMs must be a non-negative safe integer");
      }
      return this.requireSession().snapshot();
    }
    retryPendingBatchNotifications() {
      this.assertNotInBatchClosedHook("batch notification retry");
      if (this.localState === "UNPREPARED" || this.localState === "READY" || this.localState === "DISPOSED") {
        throw new Error(`batch notification retry is illegal while module state is ${this.localState}`);
      }
      this.requireSession().retryPendingBatchNotifications();
    }
    retryPendingBatchEvidence() {
      this.retryPendingBatchNotifications();
    }
    onPointerEvent(event) {
      this.assertNotInBatchClosedHook("pointer event");
      if (this.inputGate.accept(event) !== "DOWN") return;
      try {
        if (event.hitToken === null) this.touchBlankAtUptime(event.sourceUptimeMs);
        else this.touchInstanceAtUptime(event.hitToken, event.sourceUptimeMs);
      } catch (error) {
        this.inputGate.rollbackDown(event);
        throw error;
      }
    }
    onInputStreamsCancelled(reason) {
      this.assertNotInBatchClosedHook("input stream cancellation");
      this.inputGate.cancelAll(reason);
    }
    touchInstanceAtUptime(instanceId, uptimeMs2) {
      this.assertNotInBatchClosedHook("touch");
      if (this.localState === "PAUSED" || this.localState === "DEADLINE" || this.localState === "TERMINATED") return IGNORED_INPUT2;
      this.requireState("touch", "RUNNING");
      const active = this.requireClock().activeElapsedAt(uptimeMs2);
      return this.requireSession().touchInstance(instanceId, active);
    }
    touchBlankAtUptime(uptimeMs2) {
      this.assertNotInBatchClosedHook("blank touch");
      if (this.localState === "PAUSED" || this.localState === "DEADLINE" || this.localState === "TERMINATED") return;
      this.requireState("blank touch", "RUNNING");
      const active = this.requireClock().activeElapsedAt(uptimeMs2);
      this.requireSession().touchBlank(active);
    }
    buildResultDraft() {
      this.assertNotInBatchClosedHook("buildResultDraft");
      this.requireState("buildResultDraft", "DEADLINE");
      const session = this.requireSession();
      if (this.onBatchClosed === void 0) session.retryPendingBatchNotifications();
      else if (session.pendingBatchNotificationCount !== 0) {
        throw new Error("interactive host must persist BATCH_CLOSED before RESULT_READY");
      }
      session.deadline();
      return session.buildResultDraft();
    }
    async dispose() {
      this.assertNotInBatchClosedHook("dispose");
      this.preparedExecution = null;
      this.session = null;
      this.clock = null;
      this.pauseStartedUptimeMs = null;
      this.inputGate.reset();
      this.localState = "DISPOSED";
    }
    deliverBatchClosed(batch2) {
      if (this.onBatchClosed === void 0) throw new Error("internal BATCH_CLOSED hook wiring error");
      if (this.deliveringBatchClosed) throw new Error("BATCH_CLOSED hook must not re-enter the Catch Light module");
      this.deliveringBatchClosed = true;
      try {
        this.onBatchClosed(batch2);
      } finally {
        this.deliveringBatchClosed = false;
      }
    }
    assertNotInBatchClosedHook(operation) {
      if (this.deliveringBatchClosed) {
        throw new Error(`${operation} is forbidden during BATCH_CLOSED delivery`);
      }
    }
    requireState(operation, expected) {
      if (this.localState !== expected) {
        throw new Error(`${operation} requires module state ${expected}; current state is ${this.localState}`);
      }
    }
    requirePreparedExecution() {
      if (this.preparedExecution === null) throw new Error("module has no prepared execution");
      return this.preparedExecution;
    }
    requireClock() {
      if (this.clock === null) throw new Error("module clock is not running");
      return this.clock;
    }
    requireSession() {
      if (this.session === null) throw new Error("module session is not running");
      return this.session;
    }
  };

  // src/games/signal-station/constants.ts
  var SIGNAL_STATION_GAME_CODE = "SIGNAL_STATION";
  var SIGNAL_STATION_REQUIREMENT_VERSION = "1.2.1";
  var SIGNAL_STATION_CONFIG_VERSION = "A620-SS-CONFIG-1.2.1";
  var SIGNAL_STATION_GENERATOR_VERSION = "signal-station-gen-1.2.1-r2";
  var SIGNAL_STATION_SCORING_RULE_VERSION = "signal-station-score-1.2.1";
  var SIGNAL_STATION_CONTENT_VERSION = "signal-station-six-slice-1.2.1-r2";
  var SESSION_DURATION_MS2 = 3e5;
  var PLANNED_BATCH_COUNT2 = 8;
  var BATCH_DURATION_MS2 = 37500;
  var CUE_DURATION_MS = 3e3;
  var OPERATION_DURATION_MS2 = 3e4;
  var FEEDBACK_DURATION_MS2 = 2e3;
  var TRANSITION_DURATION_MS2 = 2500;
  var WAVE_START_OFFSETS_MS = Object.freeze([
    500,
    4e3,
    7500,
    11e3,
    14500,
    18e3,
    21500,
    25e3
  ]);
  var TIMING_PROFILES = Object.freeze({
    A: Object.freeze({
      id: "A",
      enteringMs: 200,
      activeMs: 2500,
      exitingMs: 200,
      lifecycleMs: 2900,
      gapMs: 600,
      tailBufferMs: 2100,
      doubleWindowMs: 1200
    }),
    C: Object.freeze({
      id: "C",
      enteringMs: 180,
      activeMs: 2240,
      exitingMs: 180,
      lifecycleMs: 2600,
      gapMs: 900,
      tailBufferMs: 2400,
      doubleWindowMs: 1100
    }),
    H: Object.freeze({
      id: "H",
      enteringMs: 160,
      activeMs: 1980,
      exitingMs: 160,
      lifecycleMs: 2300,
      gapMs: 1200,
      tailBufferMs: 2700,
      doubleWindowMs: 1e3
    })
  });
  var WAVE_TEMPLATES = Object.freeze({
    P10_D0: Object.freeze({
      id: "P10_D0",
      targetCounts: Object.freeze([1, 1, 1, 1, 1, 1, 2, 2]),
      distractorCounts: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]),
      targetTotal: 10,
      distractorTotal: 0
    }),
    P15_D5: Object.freeze({
      id: "P15_D5",
      targetCounts: Object.freeze([2, 2, 2, 2, 2, 2, 2, 1]),
      distractorCounts: Object.freeze([0, 1, 0, 1, 0, 1, 1, 1]),
      targetTotal: 15,
      distractorTotal: 5
    }),
    P20_D5: Object.freeze({
      id: "P20_D5",
      targetCounts: Object.freeze([2, 3, 2, 3, 2, 3, 2, 3]),
      distractorCounts: Object.freeze([0, 1, 1, 0, 1, 0, 1, 1]),
      targetTotal: 20,
      distractorTotal: 5
    }),
    P20_D10: Object.freeze({
      id: "P20_D10",
      targetCounts: Object.freeze([2, 3, 2, 3, 2, 3, 2, 3]),
      distractorCounts: Object.freeze([1, 1, 1, 1, 1, 1, 2, 2]),
      targetTotal: 20,
      distractorTotal: 10
    })
  });
  var DUAL_TARGET_A_COUNTS = Object.freeze([1, 2, 1, 1, 1, 2, 1, 1]);
  var DUAL_TARGET_B_COUNTS = Object.freeze([1, 1, 1, 2, 1, 1, 1, 2]);
  var IMPLEMENTED_VERTICAL_SLICE_LEVELS = Object.freeze([1, 7, 67, 79, 90, 96]);

  // src/games/signal-station/config/vertical-slices.ts
  var SOURCE_WORKBOOK_SHA256 = "b16fbcef60fa63214338af8f436e42e0080fe254fe89a9fa42a5256abde81620";
  var REQUIREMENT_DOCUMENT_SHA256 = "c9823a24ee41d536a1401a0c233d7ed8be81e4fb7076716fafed09df3f6ac898";
  var PUBLIC_RULES_DOCUMENT_SHA256 = "c1a4f3f2e309cdf92fc15d5f51e6e99bc90025c3ddc4ed8ea99077398a987794";
  var LEVEL_CONFIG_KEYS = Object.freeze([
    "level",
    "stageId",
    "gridRows",
    "gridColumns",
    "timingProfile",
    "waveTemplate",
    "targetClassCount",
    "targetClassSplit",
    "similarityTier",
    "directionCount",
    "doubleCount",
    "doubleWaveOrdinals",
    "maxWaveObjects"
  ]);
  var TIMING_PROFILE_KEYS = Object.freeze([
    "id",
    "enteringMs",
    "activeMs",
    "exitingMs",
    "lifecycleMs",
    "gapMs",
    "tailBufferMs",
    "doubleWindowMs"
  ]);
  var RUNTIME_CONFIG_KEYS = Object.freeze([
    "schemaVersion",
    "requirementVersion",
    "generatorVersion",
    "scoringRuleVersion",
    "contentVersion",
    "sourceWorkbookSha256",
    "requirementDocumentSha256",
    "publicRulesDocumentSha256",
    "durationMs",
    "plannedBatchCount",
    "batchDurationMs",
    "cueDurationMs",
    "operationDurationMs",
    "feedbackDurationMs",
    "transitionDurationMs",
    "waveStartOffsetsMs",
    "timingProfiles",
    "levelConfigs",
    "fullLevelSetStatus"
  ]);
  var LEVEL_CONFIGS = Object.freeze({
    "1": Object.freeze({
      level: 1,
      stageId: "S01",
      gridRows: 2,
      gridColumns: 2,
      timingProfile: "A",
      waveTemplate: "P10_D0",
      targetClassCount: 1,
      targetClassSplit: Object.freeze([10]),
      similarityTier: 0,
      directionCount: 1,
      doubleCount: 0,
      doubleWaveOrdinals: Object.freeze([]),
      maxWaveObjects: 2
    }),
    "7": Object.freeze({
      level: 7,
      stageId: "S02",
      gridRows: 2,
      gridColumns: 2,
      timingProfile: "A",
      waveTemplate: "P15_D5",
      targetClassCount: 1,
      targetClassSplit: Object.freeze([15]),
      similarityTier: 1,
      directionCount: 1,
      doubleCount: 0,
      doubleWaveOrdinals: Object.freeze([]),
      maxWaveObjects: 3
    }),
    "67": Object.freeze({
      level: 67,
      stageId: "S12",
      gridRows: 3,
      gridColumns: 4,
      timingProfile: "A",
      waveTemplate: "P20_D10",
      targetClassCount: 2,
      targetClassSplit: Object.freeze([10, 10]),
      similarityTier: 1,
      directionCount: 2,
      doubleCount: 0,
      doubleWaveOrdinals: Object.freeze([]),
      maxWaveObjects: 5
    }),
    "79": Object.freeze({
      level: 79,
      stageId: "S14",
      gridRows: 3,
      gridColumns: 4,
      timingProfile: "A",
      waveTemplate: "P20_D10",
      targetClassCount: 1,
      targetClassSplit: Object.freeze([20]),
      similarityTier: 1,
      directionCount: 2,
      doubleCount: 2,
      doubleWaveOrdinals: Object.freeze([3, 7]),
      maxWaveObjects: 5
    }),
    "90": Object.freeze({
      level: 90,
      stageId: "S15",
      gridRows: 3,
      gridColumns: 4,
      timingProfile: "H",
      waveTemplate: "P20_D10",
      targetClassCount: 2,
      targetClassSplit: Object.freeze([10, 10]),
      similarityTier: 2,
      directionCount: 4,
      doubleCount: 4,
      doubleWaveOrdinals: Object.freeze([2, 4, 6, 8]),
      maxWaveObjects: 5
    }),
    "96": Object.freeze({
      level: 96,
      stageId: "S16",
      gridRows: 3,
      gridColumns: 4,
      timingProfile: "H",
      waveTemplate: "P20_D10",
      targetClassCount: 2,
      targetClassSplit: Object.freeze([10, 10]),
      similarityTier: 3,
      directionCount: 4,
      doubleCount: 5,
      doubleWaveOrdinals: Object.freeze([1, 2, 4, 6, 8]),
      maxWaveObjects: 5
    })
  });
  var VERTICAL_SLICE_RUNTIME_CONFIG = Object.freeze({
    schemaVersion: SIGNAL_STATION_CONFIG_VERSION,
    requirementVersion: SIGNAL_STATION_REQUIREMENT_VERSION,
    generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
    scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
    contentVersion: SIGNAL_STATION_CONTENT_VERSION,
    sourceWorkbookSha256: SOURCE_WORKBOOK_SHA256,
    requirementDocumentSha256: REQUIREMENT_DOCUMENT_SHA256,
    publicRulesDocumentSha256: PUBLIC_RULES_DOCUMENT_SHA256,
    durationMs: SESSION_DURATION_MS2,
    plannedBatchCount: PLANNED_BATCH_COUNT2,
    batchDurationMs: BATCH_DURATION_MS2,
    cueDurationMs: CUE_DURATION_MS,
    operationDurationMs: OPERATION_DURATION_MS2,
    feedbackDurationMs: FEEDBACK_DURATION_MS2,
    transitionDurationMs: TRANSITION_DURATION_MS2,
    waveStartOffsetsMs: WAVE_START_OFFSETS_MS,
    timingProfiles: TIMING_PROFILES,
    levelConfigs: LEVEL_CONFIGS,
    fullLevelSetStatus: "HOLD"
  });
  function requireRecord(value, name) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  }
  function requireInteger(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be a safe integer in [${min}, ${max}]`);
    }
  }
  function requireExactKeys(value, expected, name) {
    const actual = Object.keys(value).sort();
    const frozen = [...expected].sort();
    if (actual.length !== frozen.length || actual.some((key, index) => key !== frozen[index])) {
      throw new Error(`${name} keys do not match the frozen contract`);
    }
  }
  function requireSha256(value, expected, name) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase SHA-256`);
    if (value !== expected) throw new Error(`${name} does not match the frozen source`);
  }
  function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  function requireNumberArray(value, name) {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
    for (const item of value) requireInteger(item, `${name} item`, 0, Number.MAX_SAFE_INTEGER);
  }
  function assertTimingProfileMatches(actual, expected, timingId) {
    requireExactKeys(actual, TIMING_PROFILE_KEYS, `timingProfiles.${timingId}`);
    for (const key of TIMING_PROFILE_KEYS) {
      if (actual[key] !== expected[key]) throw new Error(`timingProfiles.${timingId}.${key} mismatch`);
    }
  }
  function assertLevelConfigMatches(actual, expected) {
    for (const key of LEVEL_CONFIG_KEYS) {
      const left = actual[key];
      const right = expected[key];
      if (Array.isArray(left) && Array.isArray(right)) {
        if (!arraysEqual(left, right)) throw new Error(`level ${expected.level} ${key} mismatch`);
      } else if (left !== right) {
        throw new Error(`level ${expected.level} ${key} mismatch`);
      }
    }
  }
  function isVerticalSliceLevelImplemented(level2) {
    return Number.isSafeInteger(level2) && level2 >= 1 && level2 <= 96 && Object.prototype.hasOwnProperty.call(LEVEL_CONFIGS, String(level2));
  }
  function getVerticalSliceLevelConfig(level2) {
    requireInteger(level2, "level", 1, 96);
    const config = LEVEL_CONFIGS[String(level2)];
    if (config === void 0) throw new Error(`level ${level2} is not implemented in the six-level vertical slice`);
    return config;
  }
  function validateLevelConfig2(config) {
    requireRecord(config, "levelConfig");
    requireExactKeys(config, LEVEL_CONFIG_KEYS, "levelConfig");
    requireInteger(config["level"], "level", 1, 96);
    if (!["S01", "S02", "S12", "S14", "S15", "S16"].includes(String(config["stageId"]))) {
      throw new Error("unsupported stageId");
    }
    requireInteger(config["gridRows"], "gridRows", 2, 3);
    requireInteger(config["gridColumns"], "gridColumns", 2, 4);
    requireInteger(config["maxWaveObjects"], "maxWaveObjects", 1, 5);
    requireInteger(config["doubleCount"], "doubleCount", 0, 8);
    requireInteger(config["similarityTier"], "similarityTier", 0, 3);
    requireInteger(config["directionCount"], "directionCount", 1, 4);
    requireInteger(config["targetClassCount"], "targetClassCount", 1, 2);
    if (!["A", "C", "H"].includes(String(config["timingProfile"]))) throw new Error("unsupported timingProfile");
    if (![1, 2, 4].includes(config["directionCount"])) throw new Error("directionCount must be 1, 2, or 4");
    if (!["P10_D0", "P15_D5", "P20_D5", "P20_D10"].includes(String(config["waveTemplate"]))) {
      throw new Error("unsupported waveTemplate");
    }
    requireNumberArray(config["targetClassSplit"], "targetClassSplit");
    requireNumberArray(config["doubleWaveOrdinals"], "doubleWaveOrdinals");
    const typed = config;
    if (typed.gridRows * typed.gridColumns < typed.maxWaveObjects) throw new Error("grid cannot hold maxWaveObjects");
    const template = WAVE_TEMPLATES[typed.waveTemplate];
    if (template.targetCounts.length !== 8 || template.distractorCounts.length !== 8) throw new Error("wave template must contain 8 waves");
    const targetTotal = template.targetCounts.reduce((sum, value) => sum + value, 0);
    const distractorTotal = template.distractorCounts.reduce((sum, value) => sum + value, 0);
    if (targetTotal !== template.targetTotal || distractorTotal !== template.distractorTotal) throw new Error("wave template totals mismatch");
    if (typed.targetClassSplit.length !== typed.targetClassCount) throw new Error("targetClassSplit length mismatch");
    if (typed.targetClassSplit.some((value) => value <= 0)) throw new Error("each target class must contain at least one target");
    if (typed.targetClassSplit.reduce((sum, value) => sum + value, 0) !== template.targetTotal) throw new Error("targetClassSplit total mismatch");
    if (typed.targetClassCount === 2 && typed.waveTemplate !== "P20_D10") throw new Error("dual-target slice requires P20_D10");
    if (typed.similarityTier === 0 && template.distractorTotal !== 0) throw new Error("similarity tier 0 cannot contain distractors");
    if (typed.similarityTier > 0 && template.distractorTotal === 0) throw new Error("distractor tiers require distractors");
    for (let index = 0; index < 8; index += 1) {
      const targetCount = template.targetCounts[index];
      const distractorCount = template.distractorCounts[index];
      if (targetCount > 3) throw new Error(`wave ${index + 1} exceeds target cap`);
      if (distractorCount > 2) throw new Error(`wave ${index + 1} exceeds distractor cap`);
      if (targetCount + distractorCount > typed.maxWaveObjects || targetCount + distractorCount > 5) {
        throw new Error(`wave ${index + 1} exceeds object cap`);
      }
    }
    if (typed.doubleWaveOrdinals.length !== typed.doubleCount) throw new Error("doubleCount mismatch");
    let previousWave = 0;
    for (const waveOrdinal of typed.doubleWaveOrdinals) {
      requireInteger(waveOrdinal, "doubleWaveOrdinal", 1, 8);
      if (waveOrdinal <= previousWave) throw new Error("doubleWaveOrdinals must be unique and strictly increasing");
      if (template.targetCounts[waveOrdinal - 1] === 0) throw new Error("double wave must contain a target");
      previousWave = waveOrdinal;
    }
  }
  function validateRuntimeConfig(config) {
    requireRecord(config, "runtimeConfig");
    requireExactKeys(config, RUNTIME_CONFIG_KEYS, "runtimeConfig");
    if (config["schemaVersion"] !== SIGNAL_STATION_CONFIG_VERSION) throw new Error("config schemaVersion mismatch");
    if (config["requirementVersion"] !== SIGNAL_STATION_REQUIREMENT_VERSION) throw new Error("requirementVersion mismatch");
    if (config["generatorVersion"] !== SIGNAL_STATION_GENERATOR_VERSION) throw new Error("generatorVersion mismatch");
    if (config["scoringRuleVersion"] !== SIGNAL_STATION_SCORING_RULE_VERSION) throw new Error("scoringRuleVersion mismatch");
    if (config["contentVersion"] !== SIGNAL_STATION_CONTENT_VERSION) throw new Error("contentVersion mismatch");
    requireSha256(config["sourceWorkbookSha256"], SOURCE_WORKBOOK_SHA256, "sourceWorkbookSha256");
    requireSha256(config["requirementDocumentSha256"], REQUIREMENT_DOCUMENT_SHA256, "requirementDocumentSha256");
    requireSha256(config["publicRulesDocumentSha256"], PUBLIC_RULES_DOCUMENT_SHA256, "publicRulesDocumentSha256");
    if (config["durationMs"] !== SESSION_DURATION_MS2 || config["plannedBatchCount"] !== PLANNED_BATCH_COUNT2) {
      throw new Error("session constants mismatch");
    }
    if (config["batchDurationMs"] !== BATCH_DURATION_MS2 || config["cueDurationMs"] !== CUE_DURATION_MS || config["operationDurationMs"] !== OPERATION_DURATION_MS2 || config["feedbackDurationMs"] !== FEEDBACK_DURATION_MS2 || config["transitionDurationMs"] !== TRANSITION_DURATION_MS2) {
      throw new Error("batch phase constants mismatch");
    }
    requireNumberArray(config["waveStartOffsetsMs"], "waveStartOffsetsMs");
    if (!arraysEqual(config["waveStartOffsetsMs"], WAVE_START_OFFSETS_MS)) throw new Error("wave start offsets mismatch");
    if (config["fullLevelSetStatus"] !== "HOLD") throw new Error("full 96-level set must remain HOLD");
    requireRecord(config["timingProfiles"], "timingProfiles");
    requireExactKeys(config["timingProfiles"], ["A", "C", "H"], "timingProfiles");
    for (const timingId of ["A", "C", "H"]) {
      const profileValue = config["timingProfiles"][timingId];
      requireRecord(profileValue, `timingProfiles.${timingId}`);
      const profile = profileValue;
      assertTimingProfileMatches(profile, TIMING_PROFILES[timingId], timingId);
      if (profile.enteringMs + profile.activeMs + profile.exitingMs !== profile.lifecycleMs) throw new Error(`${timingId} lifecycle mismatch`);
      if (profile.lifecycleMs + profile.gapMs !== 3500) throw new Error(`${timingId} lifecycle+gap mismatch`);
      if (WAVE_START_OFFSETS_MS[7] + profile.lifecycleMs + profile.tailBufferMs !== OPERATION_DURATION_MS2) {
        throw new Error(`${timingId} final wave does not close at operation end`);
      }
      if (profile.doubleWindowMs < 1e3) throw new Error(`${timingId} double window below minimum`);
    }
    requireRecord(config["levelConfigs"], "levelConfigs");
    const expectedLevelKeys = IMPLEMENTED_VERTICAL_SLICE_LEVELS.map(String);
    requireExactKeys(config["levelConfigs"], expectedLevelKeys, "levelConfigs");
    for (const level2 of IMPLEMENTED_VERTICAL_SLICE_LEVELS) {
      const levelConfigValue = config["levelConfigs"][String(level2)];
      validateLevelConfig2(levelConfigValue);
      const expected = LEVEL_CONFIGS[String(level2)];
      if (expected === void 0) throw new Error(`internal representative level ${level2} is missing`);
      assertLevelConfigMatches(levelConfigValue, expected);
    }
  }
  validateRuntimeConfig(VERTICAL_SLICE_RUNTIME_CONFIG);

  // src/games/signal-station/generator/prng.ts
  function fnv1a32(value) {
    const bytes = new TextEncoder().encode(value);
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash === 0 ? 1831565813 : hash;
  }
  function assertKeyInteger(value, name, min) {
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`);
  }
  var DeterministicRng = class {
    state;
    constructor(seed) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error("PRNG seed must be uint32");
      this.state = seed === 0 ? 1831565813 : seed >>> 0;
    }
    nextUint32() {
      let value = this.state;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      this.state = value >>> 0;
      return this.state;
    }
    nextInt(maxExclusive) {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 4294967296) {
        throw new Error("maxExclusive must be a positive integer <= 2^32");
      }
      const range = 4294967296;
      const limit = range - range % maxExclusive;
      let value = this.nextUint32();
      while (value >= limit) value = this.nextUint32();
      return value % maxExclusive;
    }
    choose(values) {
      if (values.length === 0) throw new Error("cannot choose from an empty collection");
      return values[this.nextInt(values.length)];
    }
    shuffled(values) {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = this.nextInt(index + 1);
        const hold = result[index];
        result[index] = result[swapIndex];
        result[swapIndex] = hold;
      }
      return result;
    }
  };
  function createGeneratorRng(key) {
    assertKeyInteger(key.sessionSeed, "sessionSeed", 0);
    assertKeyInteger(key.level, "level", 1);
    assertKeyInteger(key.batchOrdinal, "batchOrdinal", 1);
    assertKeyInteger(key.waveOrdinal, "waveOrdinal", 0);
    if (typeof key.scope !== "string" || key.scope.length === 0) throw new Error("scope must not be empty");
    const version = key.generatorVersion ?? SIGNAL_STATION_GENERATOR_VERSION;
    if (typeof version !== "string" || version.length === 0) throw new Error("generatorVersion must not be empty");
    const material = `${version}|${key.sessionSeed}|${key.level}|${key.batchOrdinal}|${key.waveOrdinal}|${key.scope}`;
    return new DeterministicRng(fnv1a32(material));
  }

  // src/games/signal-station/generator/symbols.ts
  var CONTOUR_POOL = Object.freeze([
    "CIRCLE",
    "ROUNDED_SQUARE",
    "TRIANGLE",
    "DIAMOND",
    "HEXAGON",
    "SHIELD"
  ]);
  var INNER_MARK_POOL = Object.freeze([
    "DOT",
    "BAR",
    "DOUBLE_BAR",
    "CROSS",
    "CHEVRON",
    "ARC"
  ]);
  var DIRECTION_POOL = Object.freeze([0, 90, 180, 270]);
  var COLOR_POOL = Object.freeze(["BLUE", "TEAL", "AMBER", "VIOLET"]);
  var ATTRIBUTE_KEYS = Object.freeze(["contour", "innerMark", "directionDeg", "colorFamily"]);
  function differentValue(pool, current, rng) {
    const alternatives = pool.filter((value) => value !== current);
    if (alternatives.length === 0) throw new Error("symbol constraint requires an unavailable alternative");
    return rng.choose(alternatives);
  }
  function randomSymbol(directionCount, rng) {
    return Object.freeze({
      contour: rng.choose(CONTOUR_POOL),
      innerMark: rng.choose(INNER_MARK_POOL),
      directionDeg: rng.choose(DIRECTION_POOL.slice(0, directionCount)),
      colorFamily: rng.choose(COLOR_POOL)
    });
  }
  function symbolsEqual(left, right) {
    return ATTRIBUTE_KEYS.every((key) => left[key] === right[key]);
  }
  function sharedAttributeCount(left, right) {
    return ATTRIBUTE_KEYS.reduce((sum, key) => sum + (left[key] === right[key] ? 1 : 0), 0);
  }
  function hasNonColorDifference(left, right) {
    return left.contour !== right.contour || left.innerMark !== right.innerMark || left.directionDeg !== right.directionDeg;
  }
  function generateTargetCards(targetClassCount, directionCount, rng) {
    const targetA = randomSymbol(directionCount, rng);
    if (targetClassCount === 1) return Object.freeze({ A: targetA, B: null });
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const targetB = randomSymbol(directionCount, rng);
      if (!symbolsEqual(targetA, targetB) && hasNonColorDifference(targetA, targetB)) {
        return Object.freeze({ A: targetA, B: targetB });
      }
    }
    throw new Error("unable to generate two distinguishable target cards");
  }
  function buildTierOne(reference, directionCount, rng) {
    const directions = DIRECTION_POOL.slice(0, directionCount);
    return Object.freeze({
      contour: differentValue(CONTOUR_POOL, reference.contour, rng),
      innerMark: differentValue(INNER_MARK_POOL, reference.innerMark, rng),
      directionDeg: directions.length === 1 ? reference.directionDeg : differentValue(directions, reference.directionDeg, rng),
      colorFamily: differentValue(COLOR_POOL, reference.colorFamily, rng)
    });
  }
  function buildExactSharedCount(reference, desiredSharedCount, directionCount, rng) {
    const directions = DIRECTION_POOL.slice(0, directionCount);
    const immutableKeys = directions.length === 1 ? ["directionDeg"] : [];
    if (immutableKeys.length > desiredSharedCount) throw new Error("similarity tier cannot be represented by the active pools");
    const selectable = ATTRIBUTE_KEYS.filter((key) => !immutableKeys.includes(key));
    const extraShared = rng.shuffled(selectable).slice(0, desiredSharedCount - immutableKeys.length);
    const shared = /* @__PURE__ */ new Set([...immutableKeys, ...extraShared]);
    const candidate = Object.freeze({
      contour: shared.has("contour") ? reference.contour : differentValue(CONTOUR_POOL, reference.contour, rng),
      innerMark: shared.has("innerMark") ? reference.innerMark : differentValue(INNER_MARK_POOL, reference.innerMark, rng),
      directionDeg: shared.has("directionDeg") ? reference.directionDeg : differentValue(directions, reference.directionDeg, rng),
      colorFamily: shared.has("colorFamily") ? reference.colorFamily : differentValue(COLOR_POOL, reference.colorFamily, rng)
    });
    if (sharedAttributeCount(reference, candidate) !== desiredSharedCount) throw new Error("similarity construction drifted");
    if (!hasNonColorDifference(reference, candidate)) throw new Error("color cannot be the sole distinguishing cue");
    return candidate;
  }
  function generateDistractorSymbol(reference, allTargets, similarityTier, directionCount, rng) {
    if (similarityTier === 0) throw new Error("tier 0 does not generate distractors");
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const candidate = similarityTier === 1 ? buildTierOne(reference, directionCount, rng) : buildExactSharedCount(reference, similarityTier === 2 ? 1 : 2, directionCount, rng);
      if (allTargets.every((target) => !symbolsEqual(candidate, target) && hasNonColorDifference(candidate, target))) {
        return candidate;
      }
    }
    throw new Error("unable to generate a globally distinguishable distractor under the requested similarity constraints");
  }

  // src/games/signal-station/generator/wave-generator.ts
  function half(index, size, crossIndex) {
    const middle = Math.floor(size / 2);
    if (size % 2 === 0) return index < middle ? "LOW" : "HIGH";
    if (index < middle) return "LOW";
    if (index > middle) return "HIGH";
    return crossIndex % 2 === 0 ? "LOW" : "HIGH";
  }
  function quadrantFor(row, column, rows, columns) {
    const vertical = half(row, rows, column) === "LOW" ? "TOP" : "BOTTOM";
    const horizontal = half(column, columns, row) === "LOW" ? "LEFT" : "RIGHT";
    return `${vertical}_${horizontal}`;
  }
  function allSlots(config) {
    const result = [];
    for (let row = 0; row < config.gridRows; row += 1) {
      for (let column = 0; column < config.gridColumns; column += 1) {
        result.push(Object.freeze({
          slotIndex: row * config.gridColumns + column,
          row,
          column,
          quadrant: quadrantFor(row, column, config.gridRows, config.gridColumns)
        }));
      }
    }
    return result;
  }
  function targetCategoryCounts(config, waveIndex) {
    const template = WAVE_TEMPLATES[config.waveTemplate];
    const total = template.targetCounts[waveIndex];
    if (config.targetClassCount === 1) return Object.freeze({ A: total, B: 0 });
    if (config.waveTemplate !== "P20_D10") throw new Error("dual-target generation requires P20_D10");
    return Object.freeze({ A: DUAL_TARGET_A_COUNTS[waveIndex], B: DUAL_TARGET_B_COUNTS[waveIndex] });
  }
  function balanceCounts(targetSlotsByWave) {
    const counts = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const wave of targetSlotsByWave) {
      for (const slot of wave) {
        if (slot.quadrant.endsWith("LEFT")) counts.left += 1;
        else counts.right += 1;
        if (slot.quadrant.startsWith("TOP")) counts.top += 1;
        else counts.bottom += 1;
      }
    }
    return counts;
  }
  function quadrantSpread(targetSlotsByWave) {
    const counts = {
      TOP_LEFT: 0,
      TOP_RIGHT: 0,
      BOTTOM_LEFT: 0,
      BOTTOM_RIGHT: 0
    };
    for (const wave of targetSlotsByWave) for (const slot of wave) counts[slot.quadrant] += 1;
    const values = Object.values(counts);
    return Math.max(...values) - Math.min(...values);
  }
  function hasTripleTargetCellRepeat(targetSlotsByWave) {
    for (let waveIndex = 2; waveIndex < targetSlotsByWave.length; waveIndex += 1) {
      const current = new Set(targetSlotsByWave[waveIndex].map((slot) => slot.slotIndex));
      const previous = new Set(targetSlotsByWave[waveIndex - 1].map((slot) => slot.slotIndex));
      const earlier = new Set(targetSlotsByWave[waveIndex - 2].map((slot) => slot.slotIndex));
      for (const slotIndex of current) if (previous.has(slotIndex) && earlier.has(slotIndex)) return true;
    }
    return false;
  }
  function chooseTargetSlots(config, sessionSeed, batchOrdinal, slots) {
    const template = WAVE_TEMPLATES[config.waveTemplate];
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const targetSlotsByWave = [];
      const quadrantCounts = {
        TOP_LEFT: 0,
        TOP_RIGHT: 0,
        BOTTOM_LEFT: 0,
        BOTTOM_RIGHT: 0
      };
      const slotCounts = new Array(slots.length).fill(0);
      let failed = false;
      for (let waveIndex = 0; waveIndex < 8 && !failed; waveIndex += 1) {
        const rng = createGeneratorRng({
          sessionSeed,
          level: config.level,
          batchOrdinal,
          waveOrdinal: waveIndex + 1,
          scope: `layout-${attempt}`
        });
        const selected = [];
        const randomizedRank = /* @__PURE__ */ new Map();
        rng.shuffled(slots).forEach((slot, index) => randomizedRank.set(slot.slotIndex, index));
        const forbiddenByTriple = /* @__PURE__ */ new Set();
        if (waveIndex >= 2) {
          const previous = new Set(targetSlotsByWave[waveIndex - 1].map((slot) => slot.slotIndex));
          for (const earlier of targetSlotsByWave[waveIndex - 2]) if (previous.has(earlier.slotIndex)) forbiddenByTriple.add(earlier.slotIndex);
        }
        for (let targetIndex = 0; targetIndex < template.targetCounts[waveIndex]; targetIndex += 1) {
          const candidates = slots.filter((slot) => !selected.some((value) => value.slotIndex === slot.slotIndex) && !forbiddenByTriple.has(slot.slotIndex)).sort((left, right) => {
            const quadrantDifference = quadrantCounts[left.quadrant] - quadrantCounts[right.quadrant];
            if (quadrantDifference !== 0) return quadrantDifference;
            const slotDifference = slotCounts[left.slotIndex] - slotCounts[right.slotIndex];
            if (slotDifference !== 0) return slotDifference;
            const randomDifference = randomizedRank.get(left.slotIndex) - randomizedRank.get(right.slotIndex);
            if (randomDifference !== 0) return randomDifference;
            return left.slotIndex - right.slotIndex;
          });
          const chosen = candidates[0];
          if (chosen === void 0) {
            failed = true;
            break;
          }
          selected.push(chosen);
          quadrantCounts[chosen.quadrant] += 1;
          slotCounts[chosen.slotIndex] = slotCounts[chosen.slotIndex] + 1;
        }
        targetSlotsByWave.push(selected);
      }
      if (!failed) {
        const balance = balanceCounts(targetSlotsByWave);
        if (Math.abs(balance.left - balance.right) <= 2 && Math.abs(balance.top - balance.bottom) <= 2 && quadrantSpread(targetSlotsByWave) <= 2 && !hasTripleTargetCellRepeat(targetSlotsByWave)) {
          return targetSlotsByWave.map((wave) => Object.freeze([...wave]));
        }
      }
    }
    throw new Error("unable to satisfy target quadrant/cell-repeat constraints after 256 deterministic attempts");
  }
  function targetSymbolsList(cards) {
    if (cards.A === null) throw new Error("target card A is required");
    const result = [cards.A];
    if (cards.B !== null) result.push(cards.B);
    return result;
  }
  function chooseDistractorReference(config, distractorIndex, rng) {
    if (config.targetClassCount === 1) return "A";
    if (distractorIndex % 2 === 0) return rng.nextInt(2) === 0 ? "A" : "B";
    return rng.nextInt(2) === 0 ? "B" : "A";
  }
  function validateGeneratedBatchPlan(plan, config) {
    validateLevelConfig2(config);
    if (plan.generatorVersion !== SIGNAL_STATION_GENERATOR_VERSION) throw new Error("generated plan version mismatch");
    if (plan.level !== config.level) throw new Error("generated plan level mismatch");
    if (!Number.isSafeInteger(plan.sessionSeed) || plan.sessionSeed < 0) throw new Error("generated plan sessionSeed is invalid");
    if (!Number.isSafeInteger(plan.batchOrdinal) || plan.batchOrdinal < 1 || plan.batchOrdinal > 8) throw new Error("generated plan batchOrdinal is invalid");
    if (plan.waves.length !== 8) throw new Error("generated plan must contain 8 waves");
    const template = WAVE_TEMPLATES[config.waveTemplate];
    const profile = TIMING_PROFILES[config.timingProfile];
    const targetA = plan.targetCards.A;
    const targetB = plan.targetCards.B;
    if (targetA === null) throw new Error("generated plan lacks target card A");
    if (config.targetClassCount === 1 && targetB !== null) throw new Error("single-target plan unexpectedly contains target card B");
    if (config.targetClassCount === 2) {
      if (targetB === null) throw new Error("dual-target plan lacks target card B");
      if (symbolsEqual(targetA, targetB) || !hasNonColorDifference(targetA, targetB)) throw new Error("target cards are not distinctly identifiable");
    }
    const targetCards = [targetA, ...targetB === null ? [] : [targetB]];
    const allowedDirections = new Set(DIRECTION_POOL.slice(0, config.directionCount));
    const expectedDoubleWaves = new Set(config.doubleWaveOrdinals);
    const instanceIds = /* @__PURE__ */ new Set();
    const targetCategoryTotals = { A: 0, B: 0 };
    let targets = 0;
    let distractors = 0;
    let doubles = 0;
    const targetSlotsByWave = [];
    for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
      const wave = plan.waves[waveIndex];
      const expectedWaveOrdinal = waveIndex + 1;
      if (wave.waveOrdinal !== expectedWaveOrdinal) throw new Error("generated wave ordinal mismatch");
      if (wave.startOffsetInOperationMs !== WAVE_START_OFFSETS_MS[waveIndex]) throw new Error("generated wave start offset mismatch");
      if (wave.instances.length > 5 || wave.instances.length > config.maxWaveObjects) throw new Error("generated wave exceeds object cap");
      const waveTargets = wave.instances.filter((instance) => instance.role === "TARGET");
      const waveDistractors = wave.instances.filter((instance) => instance.role === "DISTRACTOR");
      if (waveTargets.length !== template.targetCounts[waveIndex]) throw new Error("generated wave target count mismatch");
      if (waveDistractors.length !== template.distractorCounts[waveIndex]) throw new Error("generated wave distractor count mismatch");
      if (waveTargets.length > 3 || waveDistractors.length > 2) throw new Error("generated wave role cap exceeded");
      const waveDoubleCount = wave.instances.filter((instance) => instance.requiresDouble).length;
      if (waveDoubleCount > 1) throw new Error("generated wave has more than one double target");
      if (waveDoubleCount !== (expectedDoubleWaves.has(expectedWaveOrdinal) ? 1 : 0)) throw new Error("generated wave double-target placement mismatch");
      if (new Set(wave.instances.map((instance) => instance.slotIndex)).size !== wave.instances.length) throw new Error("generated wave reuses a slot");
      const expectedCategories = targetCategoryCounts(config, waveIndex);
      if (waveTargets.filter((instance) => instance.targetCategoryId === "A").length !== expectedCategories.A || waveTargets.filter((instance) => instance.targetCategoryId === "B").length !== expectedCategories.B) {
        throw new Error("generated wave target-category pattern mismatch");
      }
      const expectedEnterStart = CUE_DURATION_MS + WAVE_START_OFFSETS_MS[waveIndex];
      const expectedNaturalEnd = expectedEnterStart + profile.lifecycleMs;
      for (const instance of wave.instances) {
        if (instanceIds.has(instance.instanceId)) throw new Error("generated plan contains duplicate instanceId");
        instanceIds.add(instance.instanceId);
        if (instance.batchOrdinal !== plan.batchOrdinal || instance.waveOrdinal !== expectedWaveOrdinal) throw new Error("generated instance identity mismatch");
        if (instance.instanceId !== `b${plan.batchOrdinal}-w${expectedWaveOrdinal}-s${instance.slotIndex}`) throw new Error("generated instanceId is not canonical");
        if (instance.enterStartInBatchMs !== expectedEnterStart || instance.naturalExitEndInBatchMs !== expectedNaturalEnd) {
          throw new Error("generated instance timing mismatch");
        }
        if (!Number.isSafeInteger(instance.slotIndex) || instance.slotIndex < 0 || instance.slotIndex >= config.gridRows * config.gridColumns) {
          throw new Error("generated instance slot is outside the grid");
        }
        const expectedRow = Math.floor(instance.slotIndex / config.gridColumns);
        const expectedColumn = instance.slotIndex % config.gridColumns;
        if (instance.row !== expectedRow || instance.column !== expectedColumn || instance.quadrant !== quadrantFor(expectedRow, expectedColumn, config.gridRows, config.gridColumns)) {
          throw new Error("generated instance grid coordinates mismatch");
        }
        if (!allowedDirections.has(instance.symbol.directionDeg)) throw new Error("generated symbol uses a disabled direction");
        if (instance.role === "TARGET") {
          if (instance.targetCategoryId === null || instance.similarityReferenceTargetCategoryId !== null) throw new Error("generated target category fields are invalid");
          const targetCard = plan.targetCards[instance.targetCategoryId];
          if (targetCard === null || !symbolsEqual(instance.symbol, targetCard)) throw new Error("generated target does not match its target card");
          targetCategoryTotals[instance.targetCategoryId] += 1;
        } else {
          if (instance.targetCategoryId !== null || instance.similarityReferenceTargetCategoryId === null || instance.requiresDouble) {
            throw new Error("generated distractor role fields are invalid");
          }
          const reference = plan.targetCards[instance.similarityReferenceTargetCategoryId];
          if (reference === null) throw new Error("generated distractor reference target is absent");
          if (targetCards.some((target) => symbolsEqual(instance.symbol, target))) throw new Error("generated distractor duplicates a target card");
          if (targetCards.some((target) => !hasNonColorDifference(instance.symbol, target))) {
            throw new Error("color is the sole distractor difference from at least one target card");
          }
          const shared = sharedAttributeCount(instance.symbol, reference);
          if (config.similarityTier === 1) {
            if (instance.symbol.contour === reference.contour || instance.symbol.innerMark === reference.innerMark || instance.symbol.colorFamily === reference.colorFamily || config.directionCount > 1 && instance.symbol.directionDeg === reference.directionDeg) {
              throw new Error("tier-1 distractor is not markedly different");
            }
          } else if (config.similarityTier === 2 && shared !== 1) {
            throw new Error("tier-2 distractor must share exactly one attribute");
          } else if (config.similarityTier === 3 && shared !== 2) {
            throw new Error("tier-3 distractor must share exactly two attributes");
          }
        }
      }
      targets += waveTargets.length;
      distractors += waveDistractors.length;
      doubles += waveTargets.filter((instance) => instance.requiresDouble).length;
      targetSlotsByWave.push(waveTargets.map((instance) => ({
        slotIndex: instance.slotIndex,
        row: instance.row,
        column: instance.column,
        quadrant: instance.quadrant
      })));
    }
    if (plan.targetTotal !== template.targetTotal || plan.distractorTotal !== template.distractorTotal || plan.doubleTotal !== config.doubleCount) {
      throw new Error("generated plan declared totals mismatch");
    }
    if (targets !== plan.targetTotal || distractors !== plan.distractorTotal || doubles !== plan.doubleTotal) throw new Error("generated plan totals mismatch");
    if (targetCategoryTotals.A !== config.targetClassSplit[0] || targetCategoryTotals.B !== (config.targetClassSplit[1] ?? 0)) throw new Error("generated target-class split mismatch");
    const balance = balanceCounts(targetSlotsByWave);
    if (Math.abs(balance.left - balance.right) > 2 || Math.abs(balance.top - balance.bottom) > 2 || quadrantSpread(targetSlotsByWave) > 2) throw new Error("generated target layout is unbalanced");
    if (hasTripleTargetCellRepeat(targetSlotsByWave)) throw new Error("generated target slot repeats for three consecutive waves");
  }
  function generateBatchPlan(config, sessionSeed, batchOrdinal) {
    validateLevelConfig2(config);
    if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
    if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1 || batchOrdinal > 8) throw new Error("batchOrdinal must be in [1,8]");
    const slots = allSlots(config);
    const targetSlotsByWave = chooseTargetSlots(config, sessionSeed, batchOrdinal, slots);
    const cardRng = createGeneratorRng({ sessionSeed, level: config.level, batchOrdinal, waveOrdinal: 0, scope: "target-cards" });
    const targetCards = generateTargetCards(config.targetClassCount, config.directionCount, cardRng);
    const allTargets = targetSymbolsList(targetCards);
    const template = WAVE_TEMPLATES[config.waveTemplate];
    const profile = TIMING_PROFILES[config.timingProfile];
    const waves = [];
    for (let waveIndex = 0; waveIndex < 8; waveIndex += 1) {
      const waveOrdinal = waveIndex + 1;
      const rng = createGeneratorRng({ sessionSeed, level: config.level, batchOrdinal, waveOrdinal, scope: "wave-content" });
      const targetSlots = targetSlotsByWave[waveIndex];
      const usedSlots = new Set(targetSlots.map((slot) => slot.slotIndex));
      const freeSlots = rng.shuffled(slots.filter((slot) => !usedSlots.has(slot.slotIndex)));
      const categoryCounts = targetCategoryCounts(config, waveIndex);
      const categories = rng.shuffled([
        ...new Array(categoryCounts.A).fill("A"),
        ...new Array(categoryCounts.B).fill("B")
      ]);
      if (categories.length !== targetSlots.length) throw new Error("target category pattern does not match target count");
      const doubleTargetIndex = config.doubleWaveOrdinals.includes(waveOrdinal) ? rng.nextInt(targetSlots.length) : -1;
      const instances = [];
      const enterStartInBatchMs = CUE_DURATION_MS + WAVE_START_OFFSETS_MS[waveIndex];
      const naturalExitEndInBatchMs = enterStartInBatchMs + profile.lifecycleMs;
      for (let targetIndex = 0; targetIndex < targetSlots.length; targetIndex += 1) {
        const slot = targetSlots[targetIndex];
        const targetCategoryId = categories[targetIndex];
        const symbol = targetCards[targetCategoryId];
        if (symbol === null) throw new Error("generated target category lacks a target card");
        instances.push(Object.freeze({
          instanceId: `b${batchOrdinal}-w${waveOrdinal}-s${slot.slotIndex}`,
          batchOrdinal,
          waveOrdinal,
          role: "TARGET",
          targetCategoryId,
          similarityReferenceTargetCategoryId: null,
          requiresDouble: targetIndex === doubleTargetIndex,
          slotIndex: slot.slotIndex,
          row: slot.row,
          column: slot.column,
          quadrant: slot.quadrant,
          symbol,
          enterStartInBatchMs,
          naturalExitEndInBatchMs
        }));
      }
      for (let distractorIndex = 0; distractorIndex < template.distractorCounts[waveIndex]; distractorIndex += 1) {
        const slot = freeSlots[distractorIndex];
        if (slot === void 0) throw new Error("not enough free grid slots for distractors");
        const referenceCategory = chooseDistractorReference(config, distractorIndex, rng);
        const reference = targetCards[referenceCategory];
        if (reference === null) throw new Error("distractor reference category is unavailable");
        const symbol = generateDistractorSymbol(reference, allTargets, config.similarityTier, config.directionCount, rng);
        instances.push(Object.freeze({
          instanceId: `b${batchOrdinal}-w${waveOrdinal}-s${slot.slotIndex}`,
          batchOrdinal,
          waveOrdinal,
          role: "DISTRACTOR",
          targetCategoryId: null,
          similarityReferenceTargetCategoryId: referenceCategory,
          requiresDouble: false,
          slotIndex: slot.slotIndex,
          row: slot.row,
          column: slot.column,
          quadrant: slot.quadrant,
          symbol,
          enterStartInBatchMs,
          naturalExitEndInBatchMs
        }));
      }
      instances.sort((left, right) => left.slotIndex - right.slotIndex);
      waves.push(Object.freeze({
        waveOrdinal,
        startOffsetInOperationMs: WAVE_START_OFFSETS_MS[waveIndex],
        instances: Object.freeze(instances)
      }));
    }
    const plan = Object.freeze({
      generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
      sessionSeed,
      level: config.level,
      batchOrdinal,
      targetCards,
      waves: Object.freeze(waves),
      targetTotal: template.targetTotal,
      distractorTotal: template.distractorTotal,
      doubleTotal: config.doubleCount
    });
    validateGeneratedBatchPlan(plan, config);
    return plan;
  }

  // src/games/signal-station/scoring/scoring.ts
  function assertCount(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  function roundHalfUpRatio(numerator, denominator) {
    assertCount(numerator, "numerator");
    if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error("denominator must be a positive safe integer");
    const quotient = Math.floor(numerator / denominator);
    const remainder = numerator % denominator;
    return quotient + (remainder >= Math.ceil(denominator / 2) ? 1 : 0);
  }
  function decideResultZone(template, H, T, F, D) {
    for (const [name, value] of [["H", H], ["T", T], ["F", F], ["D", D]]) assertCount(value, name);
    if (H > T) throw new Error("H cannot exceed T");
    if (F > D) throw new Error("F cannot exceed D");
    const expected = {
      P10_D0: [10, 0],
      P15_D5: [15, 5],
      P20_D5: [20, 5],
      P20_D10: [20, 10]
    };
    const expectedCounts = expected[template];
    if (expectedCounts === void 0) throw new Error(`unsupported wave template ${String(template)}`);
    if (T !== expectedCounts[0] || D !== expectedCounts[1]) throw new Error(`${template} requires T/D=${expectedCounts.join("/")}`);
    switch (template) {
      case "P10_D0":
        if (H >= 8) return "UPGRADE";
        if (H >= 7) return "HOLD";
        return "FAIL";
      case "P15_D5":
        if (H >= 12 && F <= 1) return "UPGRADE";
        if (H >= 11 && F <= 1) return "HOLD";
        return "FAIL";
      case "P20_D5":
        if (H >= 16 && F <= 1) return "UPGRADE";
        if (H >= 14 && F <= 1) return "HOLD";
        return "FAIL";
      case "P20_D10":
        if (H >= 16 && F <= 2) return "UPGRADE";
        if (H >= 14 && F <= 3) return "HOLD";
        return "FAIL";
    }
  }
  function scoreBatch(template, H, T, F, D) {
    const resultZone2 = decideResultZone(template, H, T, F, D);
    const hitScore = roundHalfUpRatio((D === 0 ? 90 : 70) * H, T);
    const inhibitionScore = D === 0 ? 0 : roundHalfUpRatio(20 * (D - F), D);
    const upgradeBonus = resultZone2 === "UPGRADE" ? 10 : 0;
    const batchScore2 = hitScore + inhibitionScore + upgradeBonus;
    if (batchScore2 < 0 || batchScore2 > 100) throw new Error("batchScore outside [0,100]");
    return Object.freeze({ resultZone: resultZone2, batchScore: batchScore2 });
  }
  function decideLevelTransition(levelBefore, resultZone2, consecutiveFailCountBefore) {
    if (!Number.isSafeInteger(levelBefore) || levelBefore < 1 || levelBefore > 96) throw new Error("levelBefore must be in [1,96]");
    if (resultZone2 !== "UPGRADE" && resultZone2 !== "HOLD" && resultZone2 !== "FAIL") throw new Error("unsupported resultZone");
    if (consecutiveFailCountBefore !== 0 && consecutiveFailCountBefore !== 1) throw new Error("consecutiveFailCountBefore must be 0 or 1");
    let levelTransition;
    let levelAfter = levelBefore;
    let consecutiveFailCountAfter = 0;
    if (resultZone2 === "UPGRADE") {
      levelTransition = levelBefore === 96 ? "HOLD_MAX" : "UP";
      levelAfter = Math.min(levelBefore + 1, 96);
    } else if (resultZone2 === "HOLD") {
      levelTransition = "HOLD";
    } else if (consecutiveFailCountBefore === 0) {
      levelTransition = "RETRY";
      consecutiveFailCountAfter = 1;
    } else {
      levelTransition = levelBefore === 1 ? "HOLD_MIN" : "DOWN";
      levelAfter = Math.max(levelBefore - 1, 1);
    }
    return Object.freeze({ levelTransition, levelAfter, consecutiveFailCountAfter });
  }

  // src/games/signal-station/domain/logical-clock.ts
  function requireUptime(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  function checkedAdd(left, right, name) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} exceeded the safe-integer range`);
    return result;
  }
  var DeterministicActiveClock = class {
    stateValue = "IDLE";
    sourceUptimeValue = 0;
    activeElapsedValue = 0;
    cutoffUptimeValue = null;
    pauseStartedUptimeValue = null;
    pauseCountValue = 0;
    totalPausedUptimeValue = 0;
    get state() {
      return this.stateValue;
    }
    get sourceUptimeMs() {
      return this.sourceUptimeValue;
    }
    get activeElapsedMs() {
      return this.activeElapsedValue;
    }
    get cutoffUptimeMs() {
      return this.cutoffUptimeValue;
    }
    get pauseCount() {
      return this.pauseCountValue;
    }
    get totalPausedUptimeMs() {
      return this.totalPausedUptimeValue;
    }
    startAt(effectiveStartUptimeMs2, cutoffUptimeMs2) {
      requireUptime(effectiveStartUptimeMs2, "effectiveStartUptimeMs");
      requireUptime(cutoffUptimeMs2, "cutoffUptimeMs");
      if (this.stateValue !== "IDLE") throw new Error("clock can only start from IDLE");
      if (cutoffUptimeMs2 - effectiveStartUptimeMs2 !== SESSION_DURATION_MS2) {
        throw new Error("initial cutoff must be exactly 300000ms after effective start");
      }
      this.sourceUptimeValue = effectiveStartUptimeMs2;
      this.cutoffUptimeValue = cutoffUptimeMs2;
      this.activeElapsedValue = 0;
      this.stateValue = "RUNNING";
    }
    advanceTo(sourceUptimeMs) {
      requireUptime(sourceUptimeMs, "sourceUptimeMs");
      if (sourceUptimeMs < this.sourceUptimeValue) {
        const isEffectiveDeadlineReplay = this.stateValue === "DEADLINE_REACHED" && this.cutoffUptimeValue === sourceUptimeMs;
        if (!isEffectiveDeadlineReplay) throw new Error("source uptime cannot move backwards");
      }
      if (this.stateValue === "IDLE") throw new Error("clock has not started");
      if (this.stateValue === "TERMINATED" || this.stateValue === "DEADLINE_REACHED") {
        this.sourceUptimeValue = Math.max(this.sourceUptimeValue, sourceUptimeMs);
        return this.activeElapsedValue;
      }
      if (this.stateValue === "PAUSED") {
        this.sourceUptimeValue = sourceUptimeMs;
        return this.activeElapsedValue;
      }
      const cutoff = this.cutoffUptimeValue;
      if (cutoff === null) throw new Error("running clock has no cutoff");
      const effectiveSource = Math.min(sourceUptimeMs, cutoff);
      this.activeElapsedValue += effectiveSource - this.sourceUptimeValue;
      this.sourceUptimeValue = sourceUptimeMs;
      if (this.activeElapsedValue >= SESSION_DURATION_MS2 || sourceUptimeMs >= cutoff) {
        this.activeElapsedValue = SESSION_DURATION_MS2;
        this.stateValue = "DEADLINE_REACHED";
      }
      return this.activeElapsedValue;
    }
    pauseAt(effectivePauseUptimeMs) {
      if (this.stateValue !== "RUNNING") throw new Error("pause requires RUNNING clock");
      this.advanceTo(effectivePauseUptimeMs);
      if (this.stateValue !== "RUNNING") throw new Error("pause boundary must precede deadline");
      this.stateValue = "PAUSED";
      this.pauseStartedUptimeValue = effectivePauseUptimeMs;
      this.pauseCountValue += 1;
    }
    resumeAt(resumeInputEnabledUptimeMs, cutoffUptimeMs2) {
      requireUptime(resumeInputEnabledUptimeMs, "resumeInputEnabledUptimeMs");
      requireUptime(cutoffUptimeMs2, "cutoffUptimeMs");
      if (this.stateValue !== "PAUSED") throw new Error("resume requires PAUSED clock");
      if (resumeInputEnabledUptimeMs < this.sourceUptimeValue) throw new Error("resume uptime cannot move backwards");
      const pauseStarted = this.pauseStartedUptimeValue;
      if (pauseStarted === null) throw new Error("paused clock lacks pause boundary");
      const pausedDuration = resumeInputEnabledUptimeMs - pauseStarted;
      const remainingActive = SESSION_DURATION_MS2 - this.activeElapsedValue;
      if (cutoffUptimeMs2 - resumeInputEnabledUptimeMs !== remainingActive) {
        throw new Error("resume cutoff does not preserve remaining active duration");
      }
      this.sourceUptimeValue = resumeInputEnabledUptimeMs;
      this.cutoffUptimeValue = cutoffUptimeMs2;
      this.pauseStartedUptimeValue = null;
      this.totalPausedUptimeValue = checkedAdd(this.totalPausedUptimeValue, pausedDuration, "totalPausedUptimeMs");
      this.stateValue = "RUNNING";
      return pausedDuration;
    }
    reachDeadlineAt(cutoffUptimeMs2) {
      requireUptime(cutoffUptimeMs2, "cutoffUptimeMs");
      if (this.stateValue === "PAUSED") throw new Error("active-time deadline cannot be reached while paused");
      if (this.cutoffUptimeValue !== cutoffUptimeMs2) throw new Error("deadline does not match the current cutoff");
      this.advanceTo(cutoffUptimeMs2);
      if (this.activeElapsedValue !== SESSION_DURATION_MS2) throw new Error("deadline did not reach 300000 active ms");
      this.stateValue = "DEADLINE_REACHED";
    }
    canAcceptInputAt(sourceUptimeMs) {
      requireUptime(sourceUptimeMs, "sourceUptimeMs");
      if (sourceUptimeMs < this.sourceUptimeValue) throw new Error("source uptime cannot move backwards");
      if (this.stateValue !== "RUNNING") return false;
      const cutoff = this.cutoffUptimeValue;
      if (cutoff === null || sourceUptimeMs >= cutoff) {
        this.advanceTo(sourceUptimeMs);
        return false;
      }
      this.advanceTo(sourceUptimeMs);
      return this.stateValue === "RUNNING" && this.activeElapsedValue < SESSION_DURATION_MS2;
    }
    terminate() {
      if (this.stateValue === "TERMINATED") throw new Error("clock is already terminated");
      this.stateValue = "TERMINATED";
      this.pauseStartedUptimeValue = null;
    }
  };

  // src/games/signal-station/domain/signal-instance.ts
  function ignored(disposition, instanceId, stateAfter) {
    return Object.freeze({ disposition, instanceId, stateAfter, hitDelta: 0, falseTouchDelta: 0 });
  }
  function requireSafeInteger(value, name, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  function checkedAdd2(left, right, name) {
    const result = left + right;
    if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeded the safe-integer range`);
    return result;
  }
  var SignalInstanceRuntime = class {
    definition;
    enterStartActiveMs;
    naturalExitEndActiveMs;
    enteringEndActiveMs;
    activeEndActiveMs;
    doubleWindowMs;
    outcomeValue = "PENDING";
    waitingSecond = false;
    firstTouchValue = null;
    completionTouchValue = null;
    secondDeadlineValue = null;
    latestActiveMs;
    processedEventIds = /* @__PURE__ */ new Set();
    constructor(definition, batchStartActiveMs, enteringMs, activeMs, doubleWindowMs) {
      if (!Number.isSafeInteger(batchStartActiveMs)) throw new Error("batchStartActiveMs must be a safe integer");
      requireSafeInteger(definition.enterStartInBatchMs, "enterStartInBatchMs");
      requireSafeInteger(definition.naturalExitEndInBatchMs, "naturalExitEndInBatchMs");
      requireSafeInteger(enteringMs, "enteringMs");
      requireSafeInteger(activeMs, "activeMs", 1);
      requireSafeInteger(doubleWindowMs, "doubleWindowMs", 1);
      if (definition.naturalExitEndInBatchMs <= definition.enterStartInBatchMs) throw new Error("instance lifecycle must be positive");
      this.definition = definition;
      this.enterStartActiveMs = checkedAdd2(batchStartActiveMs, definition.enterStartInBatchMs, "enterStartActiveMs");
      this.naturalExitEndActiveMs = checkedAdd2(batchStartActiveMs, definition.naturalExitEndInBatchMs, "naturalExitEndActiveMs");
      this.enteringEndActiveMs = checkedAdd2(this.enterStartActiveMs, enteringMs, "enteringEndActiveMs");
      this.activeEndActiveMs = checkedAdd2(this.enteringEndActiveMs, activeMs, "activeEndActiveMs");
      if (this.activeEndActiveMs > this.naturalExitEndActiveMs) throw new Error("entering+active exceeds the natural lifecycle");
      this.doubleWindowMs = doubleWindowMs;
      this.latestActiveMs = batchStartActiveMs;
    }
    get outcome() {
      return this.outcomeValue;
    }
    get firstTouchActiveMs() {
      return this.firstTouchValue;
    }
    get completionTouchActiveMs() {
      return this.completionTouchValue;
    }
    get secondDeadlineActiveMs() {
      return this.secondDeadlineValue;
    }
    advanceTo(activeMs) {
      if (!Number.isSafeInteger(activeMs) || activeMs < this.latestActiveMs) throw new Error("instance active time cannot move backwards");
      this.latestActiveMs = activeMs;
      if (this.outcomeValue !== "PENDING") return;
      if (this.waitingSecond && this.secondDeadlineValue !== null && activeMs >= this.secondDeadlineValue) {
        this.waitingSecond = false;
        this.outcomeValue = "MISS";
        return;
      }
      if (this.definition.role === "TARGET" && activeMs >= this.naturalExitEndActiveMs) {
        this.waitingSecond = false;
        this.outcomeValue = "MISS";
      }
    }
    stateAt(activeMs) {
      this.advanceTo(activeMs);
      if (activeMs >= this.naturalExitEndActiveMs) return "GONE";
      if (this.outcomeValue === "HIT") return "HIT";
      if (this.outcomeValue === "FALSE_TOUCH") return "FALSE_TOUCH";
      if (this.outcomeValue === "MISS") return "TIMEOUT";
      if (this.waitingSecond) return "WAIT_SECOND";
      if (activeMs < this.enterStartActiveMs) return "SCHEDULED";
      if (activeMs < this.enteringEndActiveMs) return "ENTERING";
      if (activeMs < this.activeEndActiveMs) return "ACTIVE";
      return "EXITING";
    }
    touch(activeMs, eventId) {
      if (typeof eventId !== "string" || eventId.length === 0) throw new Error("eventId must not be empty");
      if (this.processedEventIds.has(eventId)) {
        return ignored("IGNORED_DUPLICATE_EVENT", this.definition.instanceId, this.stateAt(Math.max(activeMs, this.latestActiveMs)));
      }
      this.processedEventIds.add(eventId);
      const stateBefore = this.stateAt(activeMs);
      if (activeMs < this.enterStartActiveMs || activeMs >= this.naturalExitEndActiveMs) {
        return ignored("IGNORED_OUTSIDE_WINDOW", this.definition.instanceId, stateBefore);
      }
      if (this.definition.requiresDouble && this.firstTouchValue !== null && this.secondDeadlineValue !== null && activeMs >= this.secondDeadlineValue) {
        return ignored("IGNORED_OUTSIDE_WINDOW", this.definition.instanceId, stateBefore);
      }
      if (this.outcomeValue !== "PENDING") return ignored("IGNORED_LOCKED", this.definition.instanceId, stateBefore);
      if (this.definition.role === "DISTRACTOR") {
        this.firstTouchValue = activeMs;
        this.completionTouchValue = activeMs;
        this.outcomeValue = "FALSE_TOUCH";
        return Object.freeze({
          disposition: "DISTRACTOR_FALSE_TOUCH",
          instanceId: this.definition.instanceId,
          stateAfter: "FALSE_TOUCH",
          hitDelta: 0,
          falseTouchDelta: 1
        });
      }
      if (!this.definition.requiresDouble) {
        this.firstTouchValue = activeMs;
        this.completionTouchValue = activeMs;
        this.outcomeValue = "HIT";
        return Object.freeze({
          disposition: "TARGET_HIT",
          instanceId: this.definition.instanceId,
          stateAfter: "HIT",
          hitDelta: 1,
          falseTouchDelta: 0
        });
      }
      if (!this.waitingSecond) {
        this.waitingSecond = true;
        this.firstTouchValue = activeMs;
        this.secondDeadlineValue = Math.min(activeMs + this.doubleWindowMs, this.naturalExitEndActiveMs);
        return Object.freeze({
          disposition: "DOUBLE_FIRST",
          instanceId: this.definition.instanceId,
          stateAfter: "WAIT_SECOND",
          hitDelta: 0,
          falseTouchDelta: 0
        });
      }
      const deadline2 = this.secondDeadlineValue;
      if (deadline2 === null || activeMs >= deadline2) {
        this.advanceTo(activeMs);
        return ignored("IGNORED_OUTSIDE_WINDOW", this.definition.instanceId, this.stateAt(activeMs));
      }
      this.waitingSecond = false;
      this.completionTouchValue = activeMs;
      this.outcomeValue = "HIT";
      return Object.freeze({
        disposition: "DOUBLE_COMPLETED",
        instanceId: this.definition.instanceId,
        stateAfter: "HIT",
        hitDelta: 1,
        falseTouchDelta: 0
      });
    }
    isPresentedBefore(activeMsExclusive) {
      return this.enterStartActiveMs < activeMsExclusive;
    }
    firstReactionMs() {
      return this.firstTouchValue === null ? null : this.firstTouchValue - this.enterStartActiveMs;
    }
    doubleIntervalMs() {
      if (!this.definition.requiresDouble || this.firstTouchValue === null || this.completionTouchValue === null) return null;
      return this.completionTouchValue - this.firstTouchValue;
    }
    audit() {
      return Object.freeze({
        instanceId: this.definition.instanceId,
        role: this.definition.role,
        requiresDouble: this.definition.requiresDouble,
        outcome: this.outcomeValue,
        firstTouchActiveMs: this.firstTouchValue,
        completionTouchActiveMs: this.completionTouchValue,
        firstReactionMs: this.firstReactionMs(),
        doubleIntervalMs: this.doubleIntervalMs(),
        secondDeadlineActiveMs: this.secondDeadlineValue
      });
    }
  };
  function summarizeIntegerDurations(values) {
    if (values.length === 0) return Object.freeze({ count: 0, totalMs: 0, minMs: null, maxMs: null });
    for (const value of values) if (!Number.isSafeInteger(value) || value < 0) throw new Error("duration summary contains an invalid value");
    const totalMs = values.reduce((sum, value) => checkedAdd2(sum, value, "duration total"), 0);
    return Object.freeze({
      count: values.length,
      totalMs,
      minMs: Math.min(...values),
      maxMs: Math.max(...values)
    });
  }

  // src/games/signal-station/domain/batch-runtime.ts
  function batchMetricsRecord(metrics) {
    return Object.freeze({
      H: metrics.H,
      T: metrics.T,
      F: metrics.F,
      D: metrics.D,
      timingProfile: metrics.timingProfile,
      targetClassCount: metrics.targetClassCount,
      similarityTier: metrics.similarityTier,
      directionCount: metrics.directionCount,
      doubleCount: metrics.doubleCount,
      completedDoubleCount: metrics.completedDoubleCount,
      timedOutDoubleCount: metrics.timedOutDoubleCount,
      presentedWaveCount: metrics.presentedWaveCount,
      reactionTimeCount: metrics.reactionTimeCount,
      reactionTimeTotalMs: metrics.reactionTimeTotalMs,
      reactionTimeMinMs: metrics.reactionTimeMinMs,
      reactionTimeMaxMs: metrics.reactionTimeMaxMs,
      doubleIntervalCount: metrics.doubleIntervalCount,
      doubleIntervalTotalMs: metrics.doubleIntervalTotalMs
    });
  }
  function partialMetricsRecord(metrics) {
    return Object.freeze({
      waveOrdinal: metrics.waveOrdinal,
      presentedTargetCount: metrics.presentedTargetCount,
      presentedDistractorCount: metrics.presentedDistractorCount,
      H: metrics.H,
      F: metrics.F,
      waitingDoubleCount: metrics.waitingDoubleCount,
      completedDoubleCount: metrics.completedDoubleCount,
      timedOutTargetCount: metrics.timedOutTargetCount,
      activeElapsedInBatchMs: metrics.activeElapsedInBatchMs
    });
  }
  var SignalStationBatchRuntime = class {
    config;
    plan;
    batchOrdinal;
    batchStartActiveMs;
    batchEndActiveMs;
    instances;
    instanceById = /* @__PURE__ */ new Map();
    processedEventIds = /* @__PURE__ */ new Set();
    latestActiveMs;
    closed = false;
    constructor(config, sessionSeed, batchOrdinal, batchStartActiveMs) {
      if (!Number.isSafeInteger(batchStartActiveMs) || batchStartActiveMs < 0) throw new Error("batchStartActiveMs must be non-negative");
      if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1 || batchOrdinal > 8) throw new Error("batchOrdinal must be in [1,8]");
      this.config = config;
      this.batchOrdinal = batchOrdinal;
      this.batchStartActiveMs = batchStartActiveMs;
      this.batchEndActiveMs = batchStartActiveMs + BATCH_DURATION_MS2;
      if (!Number.isSafeInteger(this.batchEndActiveMs)) throw new Error("batch end exceeded the safe-integer range");
      this.latestActiveMs = batchStartActiveMs;
      this.plan = generateBatchPlan(config, sessionSeed, batchOrdinal);
      const profile = TIMING_PROFILES[config.timingProfile];
      this.instances = this.plan.waves.flatMap((wave) => wave.instances).map((definition) => new SignalInstanceRuntime(definition, batchStartActiveMs, profile.enteringMs, profile.activeMs, profile.doubleWindowMs));
      for (const instance of this.instances) {
        if (this.instanceById.has(instance.definition.instanceId)) throw new Error("duplicate generated instanceId");
        this.instanceById.set(instance.definition.instanceId, instance);
      }
    }
    get isClosed() {
      return this.closed;
    }
    get currentActiveMs() {
      return this.latestActiveMs;
    }
    advanceTo(activeMs) {
      if (!Number.isSafeInteger(activeMs) || activeMs < this.latestActiveMs) throw new Error("batch active time cannot move backwards");
      this.latestActiveMs = activeMs;
      for (const instance of this.instances) instance.advanceTo(activeMs);
    }
    touch(instanceId, activeMs, eventId) {
      if (this.closed) throw new Error("closed batch cannot receive input");
      if (typeof eventId !== "string" || eventId.length === 0) throw new Error("eventId must not be empty");
      if (this.processedEventIds.has(eventId)) {
        return Object.freeze({
          disposition: "IGNORED_DUPLICATE_EVENT",
          instanceId,
          stateAfter: instanceId === null ? null : this.instanceById.get(instanceId)?.stateAt(this.latestActiveMs) ?? null,
          hitDelta: 0,
          falseTouchDelta: 0
        });
      }
      this.advanceTo(activeMs);
      this.processedEventIds.add(eventId);
      if (instanceId === null) {
        return Object.freeze({ disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0 });
      }
      const instance = this.instanceById.get(instanceId);
      if (instance === void 0) {
        return Object.freeze({ disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0 });
      }
      return instance.touch(activeMs, eventId);
    }
    metrics() {
      const hits = this.instances.filter((instance) => instance.definition.role === "TARGET" && instance.outcome === "HIT").length;
      const falseTouches = this.instances.filter((instance) => instance.definition.role === "DISTRACTOR" && instance.outcome === "FALSE_TOUCH").length;
      const completedDouble = this.instances.filter((instance) => instance.definition.requiresDouble && instance.outcome === "HIT").length;
      const timedOutDouble = this.instances.filter((instance) => instance.definition.requiresDouble && instance.outcome === "MISS").length;
      const reactionTimes = this.instances.filter((instance) => instance.definition.role === "TARGET").map((instance) => instance.firstReactionMs()).filter((value) => value !== null);
      const doubleIntervals = this.instances.map((instance) => instance.doubleIntervalMs()).filter((value) => value !== null);
      const reactions = summarizeIntegerDurations(reactionTimes);
      const intervals = summarizeIntegerDurations(doubleIntervals);
      return Object.freeze({
        H: hits,
        T: this.plan.targetTotal,
        F: falseTouches,
        D: this.plan.distractorTotal,
        timingProfile: this.config.timingProfile,
        targetClassCount: this.config.targetClassCount,
        similarityTier: this.config.similarityTier,
        directionCount: this.config.directionCount,
        doubleCount: this.config.doubleCount,
        completedDoubleCount: completedDouble,
        timedOutDoubleCount: timedOutDouble,
        presentedWaveCount: 8,
        reactionTimeCount: reactions.count,
        reactionTimeTotalMs: reactions.totalMs,
        reactionTimeMinMs: reactions.minMs,
        reactionTimeMaxMs: reactions.maxMs,
        doubleIntervalCount: intervals.count,
        doubleIntervalTotalMs: intervals.totalMs
      });
    }
    closeAt(activeMs, consecutiveFailCountBefore) {
      if (this.closed) throw new Error("batch already closed");
      if (!Number.isSafeInteger(activeMs)) throw new Error("close active time must be a safe integer");
      if (consecutiveFailCountBefore !== 0 && consecutiveFailCountBefore !== 1) throw new Error("consecutiveFailCountBefore must be 0 or 1");
      if (activeMs < this.batchEndActiveMs) throw new Error("batch cannot close before its 37500ms boundary");
      if (this.latestActiveMs < this.batchEndActiveMs) this.advanceTo(this.batchEndActiveMs);
      const metrics = this.metrics();
      const score = scoreBatch(this.config.waveTemplate, metrics.H, metrics.T, metrics.F, metrics.D);
      const level2 = decideLevelTransition(this.config.level, score.resultZone, consecutiveFailCountBefore);
      const projection = {
        batchOrdinal: this.batchOrdinal,
        closed: true,
        decisionEligible: true,
        levelBefore: this.config.level,
        resultZone: score.resultZone,
        levelTransition: level2.levelTransition,
        levelAfter: level2.levelAfter,
        batchScore: score.batchScore,
        closedAtActiveMs: this.batchEndActiveMs,
        gameBatchMetrics: batchMetricsRecord(metrics)
      };
      const eligibleBatch = Object.freeze({
        ...projection,
        batchPayloadSha256: canonicalSha256(projection)
      });
      this.closed = true;
      return Object.freeze({
        eligibleBatch,
        consecutiveFailCountAfter: level2.consecutiveFailCountAfter,
        plan: this.plan,
        audits: Object.freeze(this.instances.map((instance) => instance.audit()))
      });
    }
    partialAudit(cutoffAtActiveMs) {
      if (this.closed) throw new Error("closed batch has no partial audit");
      if (cutoffAtActiveMs !== 3e5) throw new Error("partial audit cutoff must be 300000ms");
      if (this.batchStartActiveMs >= cutoffAtActiveMs || this.batchEndActiveMs <= cutoffAtActiveMs) {
        throw new Error("partial audit requires a batch that crosses the deadline");
      }
      this.advanceTo(cutoffAtActiveMs);
      const presented = this.instances.filter((instance) => instance.isPresentedBefore(cutoffAtActiveMs));
      const waveOrdinal = presented.reduce((maximum, instance) => Math.max(maximum, instance.definition.waveOrdinal), 0);
      const partial = Object.freeze({
        waveOrdinal,
        presentedTargetCount: presented.filter((instance) => instance.definition.role === "TARGET").length,
        presentedDistractorCount: presented.filter((instance) => instance.definition.role === "DISTRACTOR").length,
        H: presented.filter((instance) => instance.definition.role === "TARGET" && instance.outcome === "HIT").length,
        F: presented.filter((instance) => instance.definition.role === "DISTRACTOR" && instance.outcome === "FALSE_TOUCH").length,
        waitingDoubleCount: presented.filter((instance) => instance.definition.requiresDouble && instance.outcome === "PENDING" && instance.firstTouchActiveMs !== null).length,
        completedDoubleCount: presented.filter((instance) => instance.definition.requiresDouble && instance.outcome === "HIT").length,
        timedOutTargetCount: presented.filter((instance) => instance.definition.role === "TARGET" && instance.outcome === "MISS").length,
        activeElapsedInBatchMs: Math.min(BATCH_DURATION_MS2, Math.max(0, cutoffAtActiveMs - this.batchStartActiveMs))
      });
      return Object.freeze({
        batchOrdinal: this.batchOrdinal,
        levelBefore: this.config.level,
        cutoffReason: "DEADLINE",
        startedAtActiveMs: this.batchStartActiveMs,
        cutoffAtActiveMs,
        partialMetrics: partialMetricsRecord(partial)
      });
    }
    instanceAudits() {
      return Object.freeze(this.instances.map((instance) => instance.audit()));
    }
  };

  // src/games/signal-station/domain/session.ts
  function requireActiveMs(value, name) {
    if (!Number.isSafeInteger(value) || value < 0 || value > SESSION_DURATION_MS2) {
      throw new Error(`${name} must be a safe integer in [0,300000]`);
    }
  }
  function checkedAdd3(left, right, name) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} exceeded the safe-integer range`);
    return result;
  }
  function ignoredOutside(instanceId) {
    return Object.freeze({
      disposition: "IGNORED_OUTSIDE_WINDOW",
      instanceId,
      stateAfter: null,
      hitDelta: 0,
      falseTouchDelta: 0
    });
  }
  function immutableEligibleBatch(batch2) {
    return Object.freeze({
      ...batch2,
      gameBatchMetrics: Object.freeze({ ...batch2.gameBatchMetrics })
    });
  }
  function immutableIncompleteAudit(audit) {
    return Object.freeze({
      ...audit,
      partialMetrics: Object.freeze({ ...audit.partialMetrics })
    });
  }
  function immutableEligibleBatchArray(batches) {
    return Object.freeze(batches.map(immutableEligibleBatch));
  }
  function immutableIncompleteAuditArray(audits) {
    return Object.freeze(audits.map(immutableIncompleteAudit));
  }
  var SignalStationSession = class {
    sessionSeed;
    sessionStartLevel;
    runtimeConfigHash;
    currentLevelValue;
    consecutiveFailCount = 0;
    currentBatchValue = null;
    eligible = [];
    closedResults = [];
    processedEventIds = /* @__PURE__ */ new Set();
    incomplete = [];
    latestActiveMs = 0;
    highestPresentedValue;
    finalized = false;
    terminated = false;
    pauseCountValue = 0;
    totalPausedUptimeValue = 0;
    generatedWaveCountValue = 0;
    acknowledgedClosedCount = 0;
    coverageBlockValue = null;
    constructor(options) {
      if (!Number.isSafeInteger(options.sessionSeed) || options.sessionSeed < 0) {
        throw new Error("sessionSeed must be a non-negative safe integer");
      }
      getVerticalSliceLevelConfig(options.sessionStartLevel);
      if (!/^[0-9a-f]{64}$/.test(options.runtimeConfigHash)) throw new Error("runtimeConfigHash must be lowercase SHA-256");
      this.sessionSeed = options.sessionSeed;
      this.sessionStartLevel = options.sessionStartLevel;
      this.currentLevelValue = options.sessionStartLevel;
      this.highestPresentedValue = options.sessionStartLevel;
      this.runtimeConfigHash = options.runtimeConfigHash;
    }
    get currentLevel() {
      return this.currentLevelValue;
    }
    get currentBatch() {
      return this.currentBatchValue;
    }
    get eligibleBatchCount() {
      return this.eligible.length;
    }
    get isFinalized() {
      return this.finalized;
    }
    get currentActiveMs() {
      return this.latestActiveMs;
    }
    get coverageBlock() {
      return this.coverageBlockValue;
    }
    startBatch(startedAtActiveMs) {
      if (this.finalized || this.terminated) throw new Error("session is no longer accepting batches");
      if (this.coverageBlockValue !== null) {
        throw new Error(`vertical slice is blocked at unimplemented level ${this.coverageBlockValue.blockedLevel}`);
      }
      if (this.currentBatchValue !== null) throw new Error("a batch is already active");
      if (this.eligible.length >= PLANNED_BATCH_COUNT2) throw new Error("planned batch count already reached");
      requireActiveMs(startedAtActiveMs, "startedAtActiveMs");
      const previousClose = this.eligible[this.eligible.length - 1]?.closedAtActiveMs ?? 0;
      if (startedAtActiveMs < previousClose || startedAtActiveMs < this.latestActiveMs || startedAtActiveMs >= SESSION_DURATION_MS2) {
        throw new Error("batch start cannot precede the prior close/current active time or reach the deadline");
      }
      const ordinal = this.eligible.length + 1;
      const config = getVerticalSliceLevelConfig(this.currentLevelValue);
      this.currentBatchValue = new SignalStationBatchRuntime(config, this.sessionSeed, ordinal, startedAtActiveMs);
      this.latestActiveMs = startedAtActiveMs;
      this.highestPresentedValue = Math.max(this.highestPresentedValue, this.currentLevelValue);
      this.generatedWaveCountValue = checkedAdd3(this.generatedWaveCountValue, 8, "generatedWaveCount");
      return this.currentBatchValue.plan;
    }
    markVerticalSliceCoverageBlocked() {
      if (this.finalized || this.terminated) throw new Error("cannot mark coverage after session closure");
      if (this.currentBatchValue !== null) throw new Error("coverage can be blocked only between batches");
      if (isVerticalSliceLevelImplemented(this.currentLevelValue)) {
        throw new Error(`level ${this.currentLevelValue} is implemented and must not be marked blocked`);
      }
      const last = this.eligible[this.eligible.length - 1];
      if (last === void 0 || last.levelAfter !== this.currentLevelValue) {
        throw new Error("coverage block must follow the batch transition that selected the unimplemented level");
      }
      if (this.coverageBlockValue !== null) {
        if (this.coverageBlockValue.blockedLevel !== this.currentLevelValue || this.coverageBlockValue.afterBatchOrdinal !== last.batchOrdinal) {
          throw new Error("conflicting vertical-slice coverage block");
        }
        return this.coverageBlockValue;
      }
      this.coverageBlockValue = Object.freeze({
        reason: "LEVEL_NOT_IMPLEMENTED",
        blockedLevel: this.currentLevelValue,
        afterBatchOrdinal: last.batchOrdinal
      });
      return this.coverageBlockValue;
    }
    touch(instanceId, activeMs, eventId) {
      requireActiveMs(activeMs, "activeMs");
      if (typeof eventId !== "string" || eventId.length === 0) throw new Error("eventId must not be empty");
      if (this.processedEventIds.has(eventId)) {
        return Object.freeze({
          disposition: "IGNORED_DUPLICATE_EVENT",
          instanceId,
          stateAfter: null,
          hitDelta: 0,
          falseTouchDelta: 0
        });
      }
      if (activeMs < this.latestActiveMs) throw new Error("session active time cannot move backwards");
      if (this.finalized || this.terminated || activeMs >= SESSION_DURATION_MS2) return ignoredOutside(instanceId);
      this.processedEventIds.add(eventId);
      this.latestActiveMs = activeMs;
      const batch2 = this.currentBatchValue;
      if (batch2 === null) {
        return Object.freeze({ disposition: "IGNORED_BLANK", instanceId: null, stateAfter: null, hitDelta: 0, falseTouchDelta: 0 });
      }
      return batch2.touch(instanceId, activeMs, eventId);
    }
    advanceTo(activeMs) {
      requireActiveMs(activeMs, "activeMs");
      if (activeMs < this.latestActiveMs) throw new Error("session active time cannot move backwards");
      if (this.terminated) throw new Error("terminated session cannot advance");
      if (this.finalized) {
        if (activeMs !== this.latestActiveMs) throw new Error("finalized session cannot advance");
        return null;
      }
      this.latestActiveMs = activeMs;
      const batch2 = this.currentBatchValue;
      if (batch2 === null) return null;
      batch2.advanceTo(activeMs);
      if (activeMs < batch2.batchEndActiveMs) return null;
      const closed = batch2.closeAt(activeMs, this.consecutiveFailCount);
      this.eligible.push(closed.eligibleBatch);
      this.closedResults.push(closed);
      this.currentLevelValue = closed.eligibleBatch.levelAfter;
      this.consecutiveFailCount = closed.consecutiveFailCountAfter;
      this.currentBatchValue = null;
      return closed.eligibleBatch;
    }
    recordPause(pausedUptimeMs) {
      if (this.finalized || this.terminated) throw new Error("closed session cannot record a pause");
      if (!Number.isSafeInteger(pausedUptimeMs) || pausedUptimeMs < 0) throw new Error("pausedUptimeMs must be non-negative");
      this.pauseCountValue = checkedAdd3(this.pauseCountValue, 1, "pauseCount");
      this.totalPausedUptimeValue = checkedAdd3(this.totalPausedUptimeValue, pausedUptimeMs, "totalPausedUptimeMs");
    }
    deadline() {
      if (this.terminated) throw new Error("terminated session cannot form a result draft");
      if (this.finalized) return;
      this.advanceTo(SESSION_DURATION_MS2);
      if (this.currentBatchValue !== null) {
        this.incomplete = [this.currentBatchValue.partialAudit(SESSION_DURATION_MS2)];
        this.currentBatchValue = null;
      }
      this.finalized = true;
    }
    terminate() {
      if (this.terminated) throw new Error("session is already terminated");
      this.terminated = true;
      this.currentBatchValue = null;
      this.incomplete = [];
    }
    /**
     * Returns immutable evidence that the host has not durably acknowledged yet.
     * Reading is intentionally non-destructive so a failed host transaction can
     * retry the same ordinal/hash without replaying game-domain mutations.
     */
    drainClosedBatchDrafts() {
      if (this.terminated) throw new Error("terminated session cannot emit BATCH_CLOSED drafts");
      return immutableEligibleBatchArray(this.eligible.slice(this.acknowledgedClosedCount));
    }
    acknowledgeClosedBatchDraft(batchPayloadSha256) {
      if (this.terminated) throw new Error("terminated session cannot acknowledge BATCH_CLOSED drafts");
      const pending = this.eligible[this.acknowledgedClosedCount];
      if (pending === void 0) throw new Error("there is no pending BATCH_CLOSED draft to acknowledge");
      if (pending.batchPayloadSha256 !== batchPayloadSha256) {
        throw new Error("BATCH_CLOSED acknowledgement must match the first pending batch hash");
      }
      this.acknowledgedClosedCount += 1;
    }
    closedPlans() {
      return Object.freeze(this.closedResults.map((result) => result.plan));
    }
    buildResultDraft() {
      if (!this.finalized || this.terminated) throw new Error("result draft is available only after normal deadline finalization");
      const last = this.eligible[this.eligible.length - 1];
      const sessionEndLevel = last?.levelAfter ?? this.sessionStartLevel;
      const passedLevels = this.eligible.filter((batch2) => batch2.resultZone === "UPGRADE").map((batch2) => batch2.levelBefore);
      const batchMetrics = this.eligible.map((batch2) => batch2.gameBatchMetrics);
      const reactionMins = batchMetrics.map((metrics) => metrics["reactionTimeMinMs"]).filter((value) => typeof value === "number");
      const reactionMaxes = batchMetrics.map((metrics) => metrics["reactionTimeMaxMs"]).filter((value) => typeof value === "number");
      const gameMetrics = Object.freeze({
        totalH: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["H"]), 0),
        totalT: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["T"]), 0),
        totalF: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["F"]), 0),
        totalD: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["D"]), 0),
        reactionTimeCount: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["reactionTimeCount"]), 0),
        reactionTimeTotalMs: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["reactionTimeTotalMs"]), 0),
        reactionTimeMinMs: reactionMins.length === 0 ? null : Math.min(...reactionMins),
        reactionTimeMaxMs: reactionMaxes.length === 0 ? null : Math.max(...reactionMaxes),
        doubleIntervalCount: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["doubleIntervalCount"]), 0),
        doubleIntervalTotalMs: batchMetrics.reduce((sum, metrics) => sum + Number(metrics["doubleIntervalTotalMs"]), 0),
        pauseCount: this.pauseCountValue,
        totalPausedUptimeMs: this.totalPausedUptimeValue,
        generatedBatchCount: this.eligible.length + this.incomplete.length,
        generatedWaveCount: this.generatedWaveCountValue,
        eligibleBatchCount: this.eligible.length,
        incompleteBatchCount: this.incomplete.length,
        verticalSliceCoverageBlocked: this.coverageBlockValue !== null,
        verticalSliceCoverageBlockReason: this.coverageBlockValue?.reason ?? null,
        verticalSliceBlockedLevel: this.coverageBlockValue?.blockedLevel ?? null,
        verticalSliceBlockedAfterBatchOrdinal: this.coverageBlockValue?.afterBatchOrdinal ?? null,
        generatorVersion: SIGNAL_STATION_GENERATOR_VERSION,
        configVersion: SIGNAL_STATION_CONFIG_VERSION,
        scoringRuleVersion: SIGNAL_STATION_SCORING_RULE_VERSION,
        requirementVersion: SIGNAL_STATION_REQUIREMENT_VERSION,
        contentVersion: SIGNAL_STATION_CONTENT_VERSION,
        fullLevelSetStatus: "HOLD",
        implementedLevels: Object.freeze([...IMPLEMENTED_VERTICAL_SLICE_LEVELS])
      });
      const eligibleBatches = immutableEligibleBatchArray(this.eligible);
      const incompleteBatchAudit = immutableIncompleteAuditArray(this.incomplete);
      return Object.freeze({
        gameCode: SIGNAL_STATION_GAME_CODE,
        gamePayloadVersion: "A620-GP-1.1",
        runtimeConfigHash: this.runtimeConfigHash,
        designMaxLevel: 96,
        plannedBatchCount: PLANNED_BATCH_COUNT2,
        eligibleBatchCount: this.eligible.length,
        eligibleBatches,
        incompleteBatchAudit,
        sessionStartLevel: this.sessionStartLevel,
        sessionEndLevel,
        sessionHighestPresentedLevel: this.highestPresentedValue,
        sessionHighestPassedLevel: passedLevels.length === 0 ? null : Math.max(...passedLevels),
        nextStartLevel: sessionEndLevel,
        sessionRawScore: this.eligible.reduce((sum, batch2) => sum + batch2.batchScore, 0),
        sessionRawScoreMax: 800,
        actualTrainingMs: SESSION_DURATION_MS2,
        gameMetrics
      });
    }
  };

  // src/games/signal-station/adapter/training-game-module.ts
  function asRuntimeConfig(value) {
    validateRuntimeConfig(value);
    return value;
  }
  var SignalStationTrainingGameModule = class {
    gameCode = SIGNAL_STATION_GAME_CODE;
    context = null;
    session = null;
    clock = null;
    evidenceSink;
    inputGate = new TrainingPointerEventGate();
    deliveringBatchEvidence = false;
    terminated = false;
    setEvidenceSink(sink) {
      this.assertNotDeliveringBatchEvidence("setEvidenceSink");
      if (typeof sink !== "function") throw new Error("evidence sink must be a function");
      this.evidenceSink = sink;
    }
    async prepare(context) {
      this.assertNotDeliveringBatchEvidence("prepare");
      if (this.context !== null || this.session !== null || this.clock !== null) {
        throw new Error("module is already prepared; dispose it before preparing another execution");
      }
      if (context.gameCode !== SIGNAL_STATION_GAME_CODE) throw new Error("PREPARE gameCode mismatch");
      if (context.durationMs !== SESSION_DURATION_MS2) throw new Error("Signal Station duration must be 300000ms");
      const config = asRuntimeConfig(context.gameConfig);
      const calculatedHash = canonicalSha256(config);
      if (context.runtimeConfigHash !== calculatedHash) throw new Error("runtimeConfigHash does not match canonical gameConfig");
      const frozenVerticalSliceHash = canonicalSha256(VERTICAL_SLICE_RUNTIME_CONFIG);
      if (calculatedHash !== frozenVerticalSliceHash) throw new Error("gameConfig is not the frozen six-slice runtime config");
      const session = new SignalStationSession({
        sessionSeed: context.sessionSeed,
        sessionStartLevel: context.sessionStartLevel,
        runtimeConfigHash: context.runtimeConfigHash
      });
      this.context = context;
      this.session = session;
      this.clock = new DeterministicActiveClock();
      this.inputGate.reset();
      this.terminated = false;
    }
    onStart(effectiveStartUptimeMs2, cutoffUptimeMs2) {
      this.assertNotDeliveringBatchEvidence("START");
      const clock = this.requireClock();
      const session = this.requireSession();
      clock.startAt(effectiveStartUptimeMs2, cutoffUptimeMs2);
      session.startBatch(0);
    }
    onPause(effectivePauseUptimeMs) {
      this.assertNotDeliveringBatchEvidence("PAUSE");
      const clock = this.requireClock();
      this.advanceToUptimeMs(effectivePauseUptimeMs);
      this.flushPendingBatchEvidence();
      clock.pauseAt(effectivePauseUptimeMs);
    }
    onResume(resumeInputEnabledUptimeMs, cutoffUptimeMs2) {
      this.assertNotDeliveringBatchEvidence("RESUME");
      const clock = this.requireClock();
      const pausedDuration = clock.resumeAt(resumeInputEnabledUptimeMs, cutoffUptimeMs2);
      this.requireSession().recordPause(pausedDuration);
    }
    onDeadline(cutoffUptimeMs2) {
      this.assertNotDeliveringBatchEvidence("DEADLINE");
      const clock = this.requireClock();
      const session = this.requireSession();
      if (this.evidenceSink !== void 0 && (session.currentActiveMs !== SESSION_DURATION_MS2 || session.drainClosedBatchDrafts().length !== 0)) {
        throw new Error("interactive host must advance and persist BATCH_CLOSED before DEADLINE");
      }
      this.advanceToUptimeMs(cutoffUptimeMs2);
      clock.reachDeadlineAt(cutoffUptimeMs2);
      session.deadline();
    }
    onTerminate(_) {
      this.assertNotDeliveringBatchEvidence("TERMINATE");
      if (this.terminated) throw new Error("execution is already terminated");
      const session = this.requireSession();
      const clock = this.requireClock();
      session.terminate();
      clock.terminate();
      this.terminated = true;
    }
    buildResultDraft() {
      this.assertNotDeliveringBatchEvidence("buildResultDraft");
      if (this.terminated) throw new Error("terminated execution has no GameResultDraft");
      const session = this.requireSession();
      if (this.evidenceSink !== void 0 && session.drainClosedBatchDrafts().length !== 0) {
        throw new Error("interactive host must persist BATCH_CLOSED before RESULT_READY");
      }
      return session.buildResultDraft();
    }
    async dispose() {
      this.assertNotDeliveringBatchEvidence("dispose");
      this.context = null;
      this.session = null;
      this.clock = null;
      this.inputGate.reset();
      this.terminated = false;
    }
    advanceToUptimeMs(sourceUptimeMs) {
      this.assertNotDeliveringBatchEvidence("advance");
      const clock = this.requireClock();
      const session = this.requireSession();
      const targetActiveMs = clock.advanceTo(sourceUptimeMs);
      while (true) {
        const batch2 = session.currentBatch;
        if (batch2 === null || targetActiveMs < batch2.batchEndActiveMs) {
          session.advanceTo(targetActiveMs);
          return;
        }
        const closed = session.advanceTo(batch2.batchEndActiveMs);
        if (closed === null) throw new Error("batch boundary was reached without closing the active batch");
        if (!isVerticalSliceLevelImplemented(session.currentLevel)) {
          session.markVerticalSliceCoverageBlocked();
          if (session.currentActiveMs < targetActiveMs) session.advanceTo(targetActiveMs);
          return;
        }
        if (session.eligibleBatchCount >= 8 || closed.closedAtActiveMs >= SESSION_DURATION_MS2) {
          if (session.currentActiveMs < targetActiveMs) session.advanceTo(targetActiveMs);
          return;
        }
        session.startBatch(closed.closedAtActiveMs);
      }
    }
    advanceToUptime(sourceUptimeMs) {
      this.advanceToUptimeMs(sourceUptimeMs);
      this.flushPendingBatchEvidence();
      return this.requireClock().activeElapsedMs;
    }
    onPointerDown(instanceId, pointerEventId, sourceUptimeMs) {
      this.assertNotDeliveringBatchEvidence("pointer input");
      if (typeof pointerEventId !== "string" || pointerEventId.length === 0) {
        throw new Error("pointerEventId must not be empty");
      }
      const clock = this.requireClock();
      if (!clock.canAcceptInputAt(sourceUptimeMs)) {
        return Object.freeze({
          disposition: "IGNORED_OUTSIDE_WINDOW",
          instanceId,
          stateAfter: null,
          hitDelta: 0,
          falseTouchDelta: 0
        });
      }
      const activeMs = clock.activeElapsedMs;
      this.advanceToUptimeMs(sourceUptimeMs);
      this.flushPendingBatchEvidence();
      return this.requireSession().touch(instanceId, activeMs, pointerEventId);
    }
    onPointerEvent(event) {
      this.assertNotDeliveringBatchEvidence("pointer event");
      if (this.inputGate.accept(event) !== "DOWN") return;
      try {
        this.onPointerDown(event.hitToken, event.pointerEventId, event.sourceUptimeMs);
      } catch (error) {
        this.inputGate.rollbackDown(event);
        throw error;
      }
    }
    onInputStreamsCancelled(reason) {
      this.assertNotDeliveringBatchEvidence("input stream cancellation");
      this.inputGate.cancelAll(reason);
    }
    retryPendingBatchEvidence() {
      this.assertNotDeliveringBatchEvidence("batch evidence retry");
      this.flushPendingBatchEvidence();
    }
    drainBatchClosedDrafts() {
      this.assertNotDeliveringBatchEvidence("batch evidence read");
      return this.requireSession().drainClosedBatchDrafts();
    }
    acknowledgeBatchClosedDraft(batchPayloadSha256) {
      this.assertNotDeliveringBatchEvidence("batch evidence acknowledgement");
      this.requireSession().acknowledgeClosedBatchDraft(batchPayloadSha256);
    }
    currentPlan() {
      return this.requireSession().currentBatch?.plan ?? null;
    }
    coverageBlock() {
      return this.requireSession().coverageBlock;
    }
    flushPendingBatchEvidence() {
      const sink = this.evidenceSink;
      if (sink === void 0) return;
      if (this.deliveringBatchEvidence) throw new Error("BATCH_CLOSED sink must not re-enter Signal Station");
      while (true) {
        const batch2 = this.requireSession().drainClosedBatchDrafts()[0];
        if (batch2 === void 0) return;
        this.deliveringBatchEvidence = true;
        try {
          sink(batch2);
        } finally {
          this.deliveringBatchEvidence = false;
        }
        this.requireSession().acknowledgeClosedBatchDraft(batch2.batchPayloadSha256);
      }
    }
    assertNotDeliveringBatchEvidence(operation) {
      if (this.deliveringBatchEvidence) throw new Error(`${operation} is forbidden during BATCH_CLOSED delivery`);
    }
    requireSession() {
      if (this.session === null) throw new Error("module has not been prepared");
      return this.session;
    }
    requireClock() {
      if (this.clock === null) throw new Error("module has not been prepared");
      return this.clock;
    }
  };

  // src/games/signal-station/golden-vectors.ts
  var FIXED_SEEDS = Object.freeze({
    "1": 6201001,
    "7": 6201007,
    "67": 6201067,
    "79": 6201079,
    "90": 6201090,
    "96": 6201096
  });

  // src/android-training/app.ts
  var SESSION_DURATION_MS3 = 3e5;
  var root = requireElement("app");
  var title = requireElement("game-title");
  var status = requireElement("status");
  var timer = requireElement("timer");
  var batch = requireElement("batch");
  var cue = requireElement("cue");
  var board = requireElement("board");
  var pauseButton = requireElement("pause-button");
  var endButton = requireElement("end-button");
  var module = null;
  var gameCode = "";
  var commandQueue = Promise.resolve();
  var state = "BOOT";
  var effectiveStartUptimeMs = 0;
  var cutoffUptimeMs = 0;
  var totalPausedMs = 0;
  var pauseStartedUptimeMs = null;
  var pointerSequence = 0;
  var frameHandle = 0;
  var lastRenderBucket = -1;
  var lastSignalPlan = null;
  var fruitEmoji = {
    APPLE: "\u{1F34E}",
    BANANA: "\u{1F34C}",
    ORANGE: "\u{1F34A}",
    PEAR: "\u{1F350}",
    STRAWBERRY: "\u{1F353}",
    GRAPE: "\u{1F347}",
    WATERMELON: "\u{1F349}",
    PINEAPPLE: "\u{1F34D}",
    PEACH: "\u{1F351}",
    LEMON: "\u{1F34B}",
    CHERRY: "\u{1F352}",
    MANGO: "\u{1F96D}"
  };
  var colorValue = {
    BLUE: "#3b82f6",
    TEAL: "#14b8a6",
    AMBER: "#f59e0b",
    VIOLET: "#8b5cf6"
  };
  function requireElement(id) {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`missing #${id}`);
    return element;
  }
  function uptimeMs() {
    const value = Number(window.A620Native.uptimeMs());
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("native uptime is invalid");
    return value;
  }
  function emit2(messageType, correlationId, payload) {
    window.A620Native.emitEvent(messageType, correlationId, canonicalString(payload));
  }
  function accepted(command, runtimeState, effectiveAtUptimeMs) {
    emit2("COMMAND_ACCEPTED", command.messageId, {
      acceptedMessageType: command.messageType,
      effectiveAtUptimeMs,
      runtimeState,
      clockRevision: Number(command.payload.clockRevision ?? 1)
    });
  }
  function activeElapsedAt(now) {
    if (effectiveStartUptimeMs === 0 || now <= effectiveStartUptimeMs) return 0;
    const pauseAdjustment = totalPausedMs + (pauseStartedUptimeMs === null ? 0 : Math.max(0, now - pauseStartedUptimeMs));
    return Math.max(0, Math.min(SESSION_DURATION_MS3, now - effectiveStartUptimeMs - pauseAdjustment));
  }
  async function receive(command) {
    switch (command.messageType) {
      case "PREPARE":
        await prepare(command);
        return;
      case "START":
        start(command);
        return;
      case "PAUSE":
        pause(command);
        return;
      case "RESUME":
        resume(command);
        return;
      case "DEADLINE":
        deadline(command);
        return;
      case "QUERY_STATE":
        queryState(command);
        return;
      case "ACK_RESULT_COMMITTED":
        committed(command);
        return;
      case "TERMINATE":
        terminate(command);
        return;
      default:
        throw new Error(`unsupported controller command ${command.messageType}`);
    }
  }
  async function prepare(command) {
    if (state !== "BOOT" && state !== "TERMINATED") throw new Error(`PREPARE is illegal in ${state}`);
    const payload = command.payload;
    gameCode = String(payload.gameCode);
    module = gameCode === "CATCH_LIGHT" ? new CatchLightGameModule() : gameCode === "SIGNAL_STATION" ? new SignalStationTrainingGameModule() : null;
    if (module === null) throw new Error(`unsupported gameCode ${gameCode}`);
    module.setEvidenceSink((closedBatch) => emit2("BATCH_CLOSED", null, closedBatch));
    await module.prepare({
      gameCode,
      sessionSeed: Number(payload.sessionSeed),
      sessionStartLevel: Number(payload.sessionStartLevel),
      durationMs: 3e5,
      runtimeConfigHash: String(payload.runtimeConfigHash),
      gameConfig: payload.gameConfig
    });
    state = "READY";
    title.textContent = gameCode === "CATCH_LIGHT" ? "\u6355\u5149\u884C\u52A8" : "\u4FE1\u53F7\u53CD\u5E94\u7AD9";
    status.textContent = "\u51C6\u5907\u5B8C\u6210";
    cue.textContent = "\u7B49\u5F85\u8BAD\u7EC3\u5F00\u59CB";
    board.replaceChildren();
    root.dataset.game = gameCode;
    pauseButton.disabled = true;
    endButton.disabled = false;
    emit2("READY", command.messageId, {
      runtimeConfigHash: payload.runtimeConfigHash,
      plannedBatchCount: payload.plannedBatchCount,
      runtimeState: "READY"
    });
  }
  function start(command) {
    const runtime = requireModule();
    const startAt = Number(command.payload.effectiveStartUptimeMs);
    const cutoff = Number(command.payload.cutoffUptimeMs);
    accepted(command, "START_SCHEDULED", startAt);
    runtime.onStart(startAt, cutoff);
    effectiveStartUptimeMs = startAt;
    cutoffUptimeMs = cutoff;
    totalPausedMs = 0;
    pauseStartedUptimeMs = null;
    state = "RUNNING";
    status.textContent = "\u8BAD\u7EC3\u4E2D";
    pauseButton.disabled = false;
    pauseButton.textContent = "\u6682\u505C";
    emit2("STARTED", command.messageId, {
      effectiveStartUptimeMs: startAt,
      cutoffUptimeMs: cutoff,
      runtimeState: "RUNNING",
      clockRevision: Number(command.payload.clockRevision)
    });
    startFrameLoop();
  }
  function pause(command) {
    if (state !== "RUNNING") throw new Error(`PAUSE is illegal in ${state}`);
    const pauseAt = Number(command.payload.effectivePauseUptimeMs);
    accepted(command, "PAUSE_SCHEDULED", pauseAt);
    requireModule().advanceToUptime(pauseAt);
    requireModule().onInputStreamsCancelled("PAUSE");
    requireModule().onPause(pauseAt);
    pauseStartedUptimeMs = pauseAt;
    state = "PAUSED";
    status.textContent = "\u5DF2\u6682\u505C";
    pauseButton.textContent = "\u7EE7\u7EED";
    emit2("PAUSED", command.messageId, {
      effectivePauseUptimeMs: pauseAt,
      activeElapsedMs: Number(command.payload.activeElapsedMs),
      runtimeState: "PAUSED",
      clockRevision: Number(command.payload.clockRevision)
    });
    render(uptimeMs(), true);
  }
  function resume(command) {
    if (state !== "PAUSED" || pauseStartedUptimeMs === null) throw new Error(`RESUME is illegal in ${state}`);
    const resumeAt = Number(command.payload.resumeInputEnabledUptimeMs);
    const cutoff = Number(command.payload.cutoffUptimeMs);
    accepted(command, "RESUME_SCHEDULED", resumeAt);
    requireModule().onResume(resumeAt, cutoff);
    totalPausedMs += Math.max(0, resumeAt - pauseStartedUptimeMs);
    pauseStartedUptimeMs = null;
    cutoffUptimeMs = cutoff;
    state = "RUNNING";
    status.textContent = "\u8BAD\u7EC3\u4E2D";
    pauseButton.textContent = "\u6682\u505C";
    emit2("RESUMED", command.messageId, {
      resumeInputEnabledUptimeMs: resumeAt,
      cutoffUptimeMs: cutoff,
      activeElapsedMs: Number(command.payload.activeElapsedMs),
      runtimeState: "RUNNING",
      clockRevision: Number(command.payload.clockRevision)
    });
    startFrameLoop();
  }
  function deadline(command) {
    if (state !== "RUNNING") throw new Error(`DEADLINE is illegal in ${state}`);
    const cutoff = Number(command.payload.cutoffUptimeMs);
    const runtime = requireModule();
    runtime.advanceToUptime(cutoff);
    runtime.retryPendingBatchEvidence();
    runtime.onInputStreamsCancelled("DEADLINE");
    runtime.onDeadline(cutoff);
    const gamePayload = runtime.buildResultDraft();
    state = "RESULT";
    status.textContent = "\u6B63\u5728\u4FDD\u5B58\u7ED3\u679C";
    cue.textContent = "\u8BAD\u7EC3\u5B8C\u6210";
    pauseButton.disabled = true;
    cancelAnimationFrame(frameHandle);
    emit2("RESULT_READY", null, {
      resultDraftSha256: canonicalSha256(gamePayload),
      gamePayload
    });
    renderResult(gamePayload);
  }
  function queryState(command) {
    emit2("STATE_SNAPSHOT", command.messageId, {
      runtimeState: state === "RESULT" ? "RESULT_PENDING_COMMIT" : state,
      activeElapsedMs: activeElapsedAt(uptimeMs()),
      clockRevision: Number(command.payload.clockRevision ?? 1),
      lastAppliedControllerSeq: command.senderSeq
    });
  }
  function committed(_) {
    status.textContent = "\u7ED3\u679C\u5DF2\u5B89\u5168\u4FDD\u5B58";
    cue.textContent = "\u53EF\u4EE5\u8FD4\u56DE\u9996\u9875";
    endButton.textContent = "\u8FD4\u56DE\u9996\u9875";
    document.body.classList.add("committed");
  }
  function terminate(command) {
    const terminateAt = Number(command.payload.effectiveTerminateUptimeMs);
    accepted(command, "TERMINATING", terminateAt);
    if (module !== null) {
      module.onInputStreamsCancelled("TERMINATE");
      module.onTerminate(String(command.payload.reasonCode));
    }
    state = "TERMINATED";
    cancelAnimationFrame(frameHandle);
    emit2("TERMINATED", command.messageId, {
      effectiveTerminateUptimeMs: terminateAt,
      runtimeState: "TERMINATED",
      reasonCode: command.payload.reasonCode
    });
    status.textContent = "\u8BAD\u7EC3\u5DF2\u7ED3\u675F";
    cue.textContent = "\u6B63\u5728\u8FD4\u56DE\u9996\u9875";
    pauseButton.disabled = true;
    window.setTimeout(() => window.A620Native.finishTraining(), 350);
  }
  function startFrameLoop() {
    cancelAnimationFrame(frameHandle);
    const tick = () => {
      if (state !== "RUNNING") return;
      const now = uptimeMs();
      if (now >= effectiveStartUptimeMs && now <= cutoffUptimeMs) {
        requireModule().advanceToUptime(now);
        render(now, false);
      }
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
  }
  function render(now, force) {
    const activeMs = activeElapsedAt(now);
    const bucket = Math.floor(activeMs / 100);
    if (!force && bucket === lastRenderBucket) return;
    lastRenderBucket = bucket;
    const remaining = Math.max(0, SESSION_DURATION_MS3 - activeMs);
    timer.textContent = `${Math.floor(remaining / 6e4).toString().padStart(2, "0")}:${Math.floor(remaining % 6e4 / 1e3).toString().padStart(2, "0")}`;
    if (gameCode === "CATCH_LIGHT") renderCatchLight(now);
    else renderSignalStation(activeMs);
  }
  function renderCatchLight(now) {
    const runtime = requireModule();
    const snapshot = runtime.snapshotAtUptime(now);
    const current = snapshot.currentBatch;
    batch.textContent = current === null ? "\u51C6\u5907\u6279\u6B21" : `\u7B2C ${current.batchOrdinal}/8 \u6279 \xB7 \u7B49\u7EA7 ${current.levelBefore}`;
    if (current === null) {
      cue.textContent = "\u51C6\u5907\u4E0B\u4E00\u6279";
      board.replaceChildren();
      return;
    }
    const target = fruitDefinition(current.targetFruitId);
    cue.textContent = current.phase === "PROMPT" ? `\u8BF7\u8BB0\u4F4F\u76EE\u6807\uFF1A${fruitEmoji[target.fruitId] ?? "\u25CF"} ${target.displayNameZh}` : `\u627E\u5230 ${fruitEmoji[target.fruitId] ?? "\u25CF"} ${target.displayNameZh}`;
    board.style.setProperty("--rows", current.gridId.split("x")[0] ?? "2");
    board.style.setProperty("--cols", current.gridId.split("x")[1] ?? "2");
    renderObjects(current.visibleObjects, (object) => fruitButton(object));
  }
  function fruitButton(object) {
    const button = document.createElement("button");
    button.className = `game-object fruit ${object.role.toLowerCase()} ${object.visualPhase.toLowerCase()}`;
    button.dataset.hitToken = object.instanceId;
    button.dataset.slot = object.slotId;
    const rowCol = /^R(\d+)C(\d+)$/.exec(object.slotId);
    if (rowCol !== null) {
      button.style.gridRow = rowCol[1];
      button.style.gridColumn = rowCol[2];
    }
    button.disabled = !object.clickable;
    button.textContent = fruitEmoji[object.fruitId] ?? "\u25CF";
    if (object.isDouble) button.dataset.double = object.doubleProgress === 1 ? "\u518D\u70B9\u4E00\u6B21" : "\xD72";
    return button;
  }
  function renderSignalStation(activeMs) {
    const runtime = requireModule();
    const plan = runtime.currentPlan();
    if (plan === null) {
      board.replaceChildren();
      cue.textContent = "\u51C6\u5907\u4E0B\u4E00\u6279";
      return;
    }
    lastSignalPlan = plan;
    const batchOrdinal = plan.batchOrdinal;
    const activeInBatch = activeMs - (batchOrdinal - 1) * 37500;
    batch.textContent = `\u7B2C ${batchOrdinal}/8 \u6279 \xB7 \u7B49\u7EA7 ${plan.level}`;
    const cards = Object.values(plan.targetCards).filter((value) => value !== null);
    cue.replaceChildren(document.createTextNode("\u76EE\u6807 "));
    cards.forEach((card) => cue.appendChild(symbolElement(card, "target-card")));
    const visible = plan.waves.flatMap((wave) => wave.instances).filter(
      (instance) => activeInBatch >= instance.enterStartInBatchMs && activeInBatch < instance.naturalExitEndInBatchMs
    );
    const rows = Math.max(1, ...plan.waves.flatMap((wave) => wave.instances.map((value) => value.row)));
    const cols = Math.max(1, ...plan.waves.flatMap((wave) => wave.instances.map((value) => value.column)));
    board.style.setProperty("--rows", String(rows));
    board.style.setProperty("--cols", String(cols));
    renderObjects(visible, (object) => signalButton(object));
  }
  function signalButton(instance) {
    const button = document.createElement("button");
    button.className = `game-object signal ${instance.role.toLowerCase()}`;
    button.dataset.hitToken = instance.instanceId;
    button.style.gridRow = String(instance.row + 1);
    button.style.gridColumn = String(instance.column + 1);
    button.appendChild(symbolElement(instance.symbol, "signal-symbol"));
    if (instance.requiresDouble) button.dataset.double = "\xD72";
    return button;
  }
  function symbolElement(symbol, className) {
    const element = document.createElement("span");
    element.className = `${className} contour-${symbol.contour.toLowerCase()}`;
    element.style.setProperty("--symbol-color", colorValue[symbol.colorFamily] ?? "#fff");
    element.style.setProperty("--rotation", `${symbol.directionDeg}deg`);
    element.dataset.mark = symbol.innerMark;
    return element;
  }
  function renderObjects(objects, create) {
    const fragment = document.createDocumentFragment();
    objects.forEach((object) => fragment.appendChild(create(object)));
    board.replaceChildren(fragment);
  }
  function renderResult(payload) {
    board.replaceChildren();
    const panel = document.createElement("section");
    panel.className = "result-panel";
    const score = Number(payload.sessionRawScore ?? 0);
    const eligible = Number(payload.eligibleBatchCount ?? 0);
    panel.innerHTML = `<strong>\u8BAD\u7EC3\u5B8C\u6210</strong><span>\u5B8C\u6210\u6279\u6B21 ${eligible}/8</span><span>\u672C\u6B21\u79EF\u5206 ${score}</span>`;
    board.appendChild(panel);
  }
  function requireModule() {
    if (module === null) throw new Error("game module is not prepared");
    return module;
  }
  board.addEventListener("pointerdown", (event) => {
    if (state !== "RUNNING") return;
    const target = event.target.closest("button[data-hit-token]");
    const sourceUptimeMs = uptimeMs();
    const pointerEvent = {
      pointerEventId: `WEB-${sourceUptimeMs}-${++pointerSequence}`,
      pointerId: String(event.pointerId),
      phase: "DOWN",
      sourceUptimeMs,
      xPx: Math.round(event.clientX),
      yPx: Math.round(event.clientY),
      hitToken: target?.dataset.hitToken ?? null
    };
    requireModule().onPointerEvent(pointerEvent);
    render(sourceUptimeMs, true);
  });
  pauseButton.addEventListener("click", () => {
    if (state === "RUNNING") window.A620Native.requestControl("PAUSE");
    else if (state === "PAUSED") window.A620Native.requestControl("RESUME");
  });
  endButton.addEventListener("click", () => {
    if (state === "RESULT" || state === "TERMINATED") window.A620Native.finishTraining();
    else window.A620Native.requestControl("TERMINATE");
  });
  window.A620Runtime = {
    receiveCommand(canonicalCommand) {
      commandQueue = commandQueue.then(async () => {
        const command = JSON.parse(canonicalCommand);
        await receive(command);
      }).catch((error) => {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        status.textContent = "\u8FD0\u884C\u5F02\u5E38";
        cue.textContent = reason;
        window.A620Native.reportFatal(reason.slice(0, 240));
      });
    }
  };
  status.textContent = "\u6B63\u5728\u8FDE\u63A5\u8BAD\u7EC3\u670D\u52A1";
  window.A620Native.requestControl("WEB_READY");
})();

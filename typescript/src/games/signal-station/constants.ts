import type { TimingProfile, TimingProfileId, WaveTemplate, WaveTemplateId } from "./types.js";

export const SIGNAL_STATION_GAME_CODE = "SIGNAL_STATION" as const;
export const SIGNAL_STATION_REQUIREMENT_VERSION = "1.2.1" as const;
export const SIGNAL_STATION_CONFIG_VERSION = "A620-SS-CONFIG-1.2.1" as const;
export const SIGNAL_STATION_GENERATOR_VERSION = "signal-station-gen-1.2.1" as const;
export const SIGNAL_STATION_SCORING_RULE_VERSION = "signal-station-score-1.2.1" as const;
export const SIGNAL_STATION_CONTENT_VERSION = "signal-station-six-slice-1.2.1" as const;

export const SESSION_DURATION_MS = 300_000 as const;
export const PLANNED_BATCH_COUNT = 8 as const;
export const BATCH_DURATION_MS = 37_500 as const;
export const CUE_DURATION_MS = 3_000 as const;
export const OPERATION_DURATION_MS = 30_000 as const;
export const FEEDBACK_DURATION_MS = 2_000 as const;
export const TRANSITION_DURATION_MS = 2_500 as const;

export const WAVE_START_OFFSETS_MS = Object.freeze([
  500, 4_000, 7_500, 11_000, 14_500, 18_000, 21_500, 25_000,
] as const);

export const TIMING_PROFILES: Readonly<Record<TimingProfileId, TimingProfile>> = Object.freeze({
  A: Object.freeze({
    id: "A",
    enteringMs: 200,
    activeMs: 2_500,
    exitingMs: 200,
    lifecycleMs: 2_900,
    gapMs: 600,
    tailBufferMs: 2_100,
    doubleWindowMs: 1_200,
  }),
  C: Object.freeze({
    id: "C",
    enteringMs: 180,
    activeMs: 2_240,
    exitingMs: 180,
    lifecycleMs: 2_600,
    gapMs: 900,
    tailBufferMs: 2_400,
    doubleWindowMs: 1_100,
  }),
  H: Object.freeze({
    id: "H",
    enteringMs: 160,
    activeMs: 1_980,
    exitingMs: 160,
    lifecycleMs: 2_300,
    gapMs: 1_200,
    tailBufferMs: 2_700,
    doubleWindowMs: 1_000,
  }),
});

export const WAVE_TEMPLATES: Readonly<Record<WaveTemplateId, WaveTemplate>> = Object.freeze({
  P10_D0: Object.freeze({
    id: "P10_D0",
    targetCounts: Object.freeze([1, 1, 1, 1, 1, 1, 2, 2] as const),
    distractorCounts: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0] as const),
    targetTotal: 10,
    distractorTotal: 0,
  }),
  P15_D5: Object.freeze({
    id: "P15_D5",
    targetCounts: Object.freeze([2, 2, 2, 2, 2, 2, 2, 1] as const),
    distractorCounts: Object.freeze([0, 1, 0, 1, 0, 1, 1, 1] as const),
    targetTotal: 15,
    distractorTotal: 5,
  }),
  P20_D5: Object.freeze({
    id: "P20_D5",
    targetCounts: Object.freeze([2, 3, 2, 3, 2, 3, 2, 3] as const),
    distractorCounts: Object.freeze([0, 1, 1, 0, 1, 0, 1, 1] as const),
    targetTotal: 20,
    distractorTotal: 5,
  }),
  P20_D10: Object.freeze({
    id: "P20_D10",
    targetCounts: Object.freeze([2, 3, 2, 3, 2, 3, 2, 3] as const),
    distractorCounts: Object.freeze([1, 1, 1, 1, 1, 1, 2, 2] as const),
    targetTotal: 20,
    distractorTotal: 10,
  }),
});

export const DUAL_TARGET_A_COUNTS = Object.freeze([1, 2, 1, 1, 1, 2, 1, 1] as const);
export const DUAL_TARGET_B_COUNTS = Object.freeze([1, 1, 1, 2, 1, 1, 1, 2] as const);

export const IMPLEMENTED_VERTICAL_SLICE_LEVELS = Object.freeze([1, 7, 67, 79, 90, 96] as const);

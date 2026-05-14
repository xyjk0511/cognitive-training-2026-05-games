#!/usr/bin/env python3
"""Generate-round simulation for all configured levels.

This script mirrors the runtime pool-selection rules in src/game.js. It does not
need a browser; it validates that every level can repeatedly produce one clue,
one specified correct option, and the configured number of distractors.
"""
from __future__ import annotations

import json
import random
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ROUNDS_PER_LEVEL = 200


def load_data() -> dict[str, Any]:
    text = (ROOT / "src" / "data.js").read_text(encoding="utf-8")
    match = re.match(r"\s*window\.GAME_DATA\s*=\s*(.*);\s*$", text, flags=re.S)
    if not match:
        raise AssertionError("Cannot parse src/data.js")
    return json.loads(match.group(1))


def item_category(item: dict[str, Any], depth: int) -> int | None:
    return item["typePath"][depth]


def items_in_category(items: list[dict[str, Any]], depth: int, category: int) -> list[dict[str, Any]]:
    return [item for item in items if item_category(item, depth) == category]


def unique_by_id(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[int] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        out.append(item)
    return out


def make_round(data: dict[str, Any], level: dict[str, Any]) -> dict[str, Any]:
    items = data["items"]
    depth = level["typeDepth"]
    scope = level.get("scope") or level["target"]
    target_categories = [cat for cat in level["target"] if len(items_in_category(items, depth, cat)) >= 2]
    if not target_categories:
        raise AssertionError(f"Level {level['level']}: no category has two target items")

    target_category = random.choice(target_categories)
    target_items = items_in_category(items, depth, target_category)
    clue = random.choice(target_items)
    correct_pool = [item for item in target_items if item["id"] != clue["id"]]
    correct = random.choice(correct_pool)
    excluded = {clue["id"], correct["id"]}

    configured = [
        item for item in items
        if item_category(item, depth) in scope
        and item_category(item, depth) not in level["target"]
        and item["id"] not in excluded
    ]
    same_scope = [
        item for item in items
        if item_category(item, depth) in scope
        and item_category(item, depth) != target_category
        and item["id"] not in excluded
    ]
    global_pool = [
        item for item in items
        if item_category(item, depth) != target_category
        and item["id"] not in excluded
    ]
    distractors = unique_by_id(configured + same_scope + global_pool)
    needed = level["optionalQuantity"] - 1
    if len(distractors) < needed:
        raise AssertionError(f"Level {level['level']}: not enough distractors")
    selected = random.sample(distractors, needed)
    options = [correct] + selected
    random.shuffle(options)

    if len(options) != level["optionalQuantity"]:
        raise AssertionError(f"Level {level['level']}: wrong option count")
    if clue["id"] == correct["id"]:
        raise AssertionError(f"Level {level['level']}: clue and correct duplicated")
    if sum(1 for option in options if option["id"] == correct["id"]) != 1:
        raise AssertionError(f"Level {level['level']}: correct option not unique")
    if any(option["id"] == clue["id"] for option in options):
        raise AssertionError(f"Level {level['level']}: clue appears in options")

    return {
        "level": level["level"],
        "depth": depth,
        "targetCategory": target_category,
        "clue": clue["id"],
        "correct": correct["id"],
        "options": [option["id"] for option in options],
    }


def main() -> int:
    data = load_data()
    random.seed(4711)
    depth_counter: Counter[int] = Counter()
    option_counter: Counter[int] = Counter()
    generated = 0
    for level in data["levels"]:
        depth_counter[level["typeDepth"]] += 1
        option_counter[level["optionalQuantity"]] += 1
        for _ in range(ROUNDS_PER_LEVEL):
            make_round(data, level)
            generated += 1

    print("Simulation passed")
    print(json.dumps({
        "levels": len(data["levels"]),
        "roundsPerLevel": ROUNDS_PER_LEVEL,
        "generatedRounds": generated,
        "depthCounts": dict(sorted(depth_counter.items())),
        "optionQuantityCounts": dict(sorted(option_counter.items())),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"Simulation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)

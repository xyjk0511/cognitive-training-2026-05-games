#!/usr/bin/env python3
"""Static validation for the local HTML5 game package."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_runtime_data() -> dict:
    data_js = (ROOT / "src" / "data.js").read_text(encoding="utf-8")
    match = re.match(r"\s*window\.GAME_DATA\s*=\s*(.*);\s*$", data_js, flags=re.S)
    if not match:
        raise AssertionError("src/data.js must assign window.GAME_DATA = {...};")
    return json.loads(match.group(1))


def assert_file(path: Path, label: str) -> None:
    if not path.exists():
        raise AssertionError(f"Missing {label}: {path.relative_to(ROOT)}")
    if path.is_file() and path.stat().st_size <= 0:
        raise AssertionError(f"Empty {label}: {path.relative_to(ROOT)}")


def main() -> int:
    data = load_runtime_data()

    # Basic structure.
    assert data["game"]["name"] == "分门别类"
    assert data["game"]["id"] == 4711
    assert data["game"]["version"] == "1.0.2"
    assert data["difficulties"]["easy"]["startLevel"] == 1
    assert data["difficulties"]["normal"]["startLevel"] == 15
    assert data["difficulties"]["hard"]["startLevel"] == 30
    assert len(data["levels"]) == 100
    assert len(data["items"]) == 92
    assert len(data["types"]["primary"]) == 6
    assert len(data["types"]["secondary"]) == 19
    assert len(data["types"]["tertiary"]) == 6

    # Referenced files.
    assert_file(ROOT / "index.html", "HTML entry")
    assert_file(ROOT / "style.css", "stylesheet")
    assert_file(ROOT / "src" / "game.js", "game logic")
    assert_file(ROOT / "src" / "data.js", "runtime data")
    assert_file(ROOT / "README.md", "readme")
    assert_file(ROOT / "docs" / "BEGINNER_TUTORIAL.md", "beginner tutorial")
    assert_file(ROOT / "docs" / "CODE_REVIEW_AND_CONSISTENCY.md", "review report")
    assert_file(ROOT / "docs" / "POLISH_CHANGELOG.md", "polish changelog")
    assert_file(ROOT / "docs" / "QA_CHECKLIST.md", "QA checklist")
    assert_file(ROOT / "tools" / "playtest_simulation.py", "playtest simulation")
    for path in [
        ROOT / "assets" / "ui" / "kangkang.svg",
        ROOT / "assets" / "ui" / "kangkang_airplane.svg",
        ROOT / "assets" / "ui" / "引导.jpg",
        ROOT / "assets" / "ui" / "帮助.jpg",
        ROOT / "assets" / "ui" / "整体效果图.jpg",
        ROOT / "assets" / "sfx" / "tip.wav",
        ROOT / "assets" / "sfx" / "correct.wav",
        ROOT / "assets" / "sfx" / "wrong.wav",
        ROOT / "assets" / "sfx" / "settlement.wav",
    ]:
        assert_file(path, "asset")

    ids = set()
    for item in data["items"]:
        ids.add(item["id"])
        assert_file(ROOT / item["asset"], f"item asset {item['id']}")
        assert len(item["typePath"]) == 3
        assert item["primary"] == item["typePath"][0]
        assert item["secondary"] == item["typePath"][1]
    assert ids == set(range(1, 93))

    by_depth: dict[int, dict[int, list[dict]]] = {0: {}, 1: {}, 2: {}}
    for item in data["items"]:
        for depth in (0, 1, 2):
            cat = item["typePath"][depth]
            if cat is None:
                continue
            by_depth[depth].setdefault(cat, []).append(item)

    depth_counts = {0: 0, 1: 0, 2: 0}
    for idx, level in enumerate(data["levels"], start=1):
        assert level["level"] == idx
        depth = level["typeDepth"]
        depth_counts[depth] += 1
        assert depth in (0, 1, 2)
        assert 2 <= level["optionalQuantity"] <= 4
        assert level["stageTime"] > 0
        assert level["baseScore"] > 0
        assert level["rewardScore"] > 0
        assert level["passTarget"] > 0
        assert level["target"], f"Level {idx}: empty target pool"
        scope = level.get("scope") or level["target"]
        for cat in level["target"]:
            assert cat in by_depth[depth], f"Level {idx}: target category {cat} has no items"
            assert len(by_depth[depth][cat]) >= 2, f"Level {idx}: target category {cat} needs at least two items"
            # Check that there can be enough distractors after the configured/fallback pools.
            excluded_target_count = 2
            configured = [item for item in data["items"] if item["typePath"][depth] in scope and item["typePath"][depth] not in level["target"]]
            same_scope = [item for item in data["items"] if item["typePath"][depth] in scope and item["typePath"][depth] != cat]
            global_pool = [item for item in data["items"] if item["typePath"][depth] != cat]
            possible = max(len(configured), len(same_scope), len(global_pool))
            assert possible >= level["optionalQuantity"] - 1, f"Level {idx}: insufficient distractors"

    assert depth_counts[0] == 12, depth_counts
    assert depth_counts[1] == 78, depth_counts
    assert depth_counts[2] == 10, depth_counts

    # HTML selector consistency.
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "style.css").read_text(encoding="utf-8")
    game_js = (ROOT / "src" / "game.js").read_text(encoding="utf-8")
    required_ids = sorted(set(re.findall(r'\$\("#([A-Za-z][A-Za-z0-9_-]+)"\)', game_js)))
    html_ids = set(re.findall(r'id="([^"]+)"', html))
    missing = [selector for selector in required_ids if selector not in html_ids]
    if missing:
        raise AssertionError("Missing HTML ids referenced by game.js: " + ", ".join(missing))

    required_ui_ids = {
        "assetProgress", "assetStatus", "assetPercent", "stageIntroLayer",
        "startStageBtn", "hudWrongStreak", "hudRound", "settleFormula",
        "settleAccuracy", "settleTime", "openCoachBtn", "closeInfoX"
    }
    missing_ui = sorted(required_ui_ids - html_ids)
    if missing_ui:
        raise AssertionError("Missing polished UI ids: " + ", ".join(missing_ui))

    for css_token in ["prefers-reduced-motion", "option-index", "coach-layer", "tutorial-grid"]:
        if css_token not in css:
            raise AssertionError(f"Missing CSS polish token: {css_token}")

    for js_token in ["preloadAssets", "handleKeyboard", "scoreDetailsForStage", "showStageIntro"]:
        if js_token not in game_js:
            raise AssertionError(f"Missing JS polish token: {js_token}")

    print("Validation passed")
    print(json.dumps({
        "levels": len(data["levels"]),
        "items": len(data["items"]),
        "difficultyStarts": {k: v["startLevel"] for k, v in data["difficulties"].items()},
        "depthCounts": depth_counts
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"Validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)

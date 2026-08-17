from __future__ import annotations

from collections import deque
from typing import Any


class StateSpecError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise StateSpecError(message)


def validate_state_machine_spec(spec: dict[str, Any]) -> dict[tuple[str, str], str | None]:
    """Validate the normative state machine and return its total legal matrix.

    ``None`` means the input is legal and non-mutating. Missing state/input
    pairs are intentionally illegal. The validation prevents a generated
    TypeScript/Kotlin table from silently encoding overlapping or unreachable
    normative rules.
    """

    states = spec.get("stateSet")
    _require(isinstance(states, list) and states, "stateSet must be a non-empty list")
    _require(all(isinstance(state, str) and state for state in states), "stateSet contains invalid state")
    _require(len(states) == len(set(states)), "stateSet contains duplicates")
    state_set = set(states)

    initial = spec.get("initialState")
    _require(initial in state_set, "initialState is not in stateSet")

    terminals = spec.get("terminalStates")
    _require(isinstance(terminals, list), "terminalStates must be a list")
    _require(len(terminals) == len(set(terminals)), "terminalStates contains duplicates")
    _require(set(terminals) <= state_set, "terminalStates contains unknown state")

    priority = spec.get("sameTimestampPriority")
    _require(isinstance(priority, list) and priority, "sameTimestampPriority must be a non-empty list")
    _require(len(priority) == len(set(priority)), "sameTimestampPriority contains duplicates")
    _require(priority[:2] == ["TERMINATE", "DEADLINE"], "TERMINATE and DEADLINE must be the two highest priorities")

    matrix: dict[tuple[str, str], str | None] = {}
    adjacency: dict[str, set[str]] = {state: set() for state in states}
    for index, transition in enumerate(spec.get("transitions", [])):
        _require(isinstance(transition, dict), f"transition {index} must be an object")
        sources = transition.get("from")
        input_name = transition.get("input")
        target = transition.get("to")
        _require(isinstance(sources, list) and sources, f"transition {index} has no source states")
        _require(isinstance(input_name, str) and input_name, f"transition {index} has invalid input")
        _require(target in state_set, f"transition {index} targets unknown state {target!r}")
        _require(len(sources) == len(set(sources)), f"transition {index} repeats a source state")
        for source in sources:
            _require(source in state_set, f"transition {index} uses unknown source state {source!r}")
            key = (source, input_name)
            _require(key not in matrix, f"duplicate/overlapping rule for {source} + {input_name}")
            _require(source not in terminals, f"terminal state {source} has a mutating transition")
            matrix[key] = target
            adjacency[source].add(target)

    non_mutating = spec.get("nonMutatingInputLegality")
    _require(isinstance(non_mutating, dict), "nonMutatingInputLegality must be an object")
    for input_name, legal_states in non_mutating.items():
        _require(isinstance(input_name, str) and input_name, "non-mutating input name is invalid")
        _require(isinstance(legal_states, list), f"non-mutating state list for {input_name} is invalid")
        _require(len(legal_states) == len(set(legal_states)), f"non-mutating states repeat for {input_name}")
        for state in legal_states:
            _require(state in state_set, f"non-mutating input {input_name} uses unknown state {state!r}")
            key = (state, input_name)
            _require(key not in matrix, f"mutating and non-mutating rules overlap for {state} + {input_name}")
            matrix[key] = None

    # Every declared state must be reachable from the initial state through a
    # sequence of mutating transitions. This catches dead states caused by a
    # typo in generated or hand-edited normative files.
    reached = {initial}
    queue: deque[str] = deque([initial])
    while queue:
        source = queue.popleft()
        for target in adjacency[source]:
            if target not in reached:
                reached.add(target)
                queue.append(target)
    _require(reached == state_set, f"unreachable runtime states: {sorted(state_set - reached)}")

    return matrix

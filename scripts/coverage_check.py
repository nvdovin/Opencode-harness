#!/usr/bin/env python3
"""Детерминированная проверка покрытия концепции.

Режимы:
  plan  — requirements.json <-> sprints.json (requirement_map)
  spec  — требования спринта <-> spec.md/criteria.md
  final — требования <-> changelist/review + design-review

Смысловую полноту и проверяемость критериев оценивает
concept-coverage-auditor; этот скрипт проверяет механику: схему, ссылки,
наличие R-ID и обязательных артефактов.

Exit codes:
  0 — PASS
  1 — FAIL (есть gaps)
  2 — ошибка схемы/аргументов
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ID_RE = re.compile(r"^[A-Z][A-Z0-9]*-\d{3,}$")
PRIORITIES = {"must", "should", "could", "won't", "wont"}
STATUSES = {
    "planned",
    "specified",
    "implemented",
    "verified",
    "backlog",
    "non_goal",
    "ambiguous",
    "gap",
}
TYPES = {
    "functional",
    "non_functional",
    "design",
    "security",
    "migration",
    "test",
    "content",
    "integration",
    "constraint",
}
SUCCESS_MARKERS = ("✅", "passed_with_proof", "verified", "PASS", "OK")


class Check:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, code: str, message: str) -> None:
        self.errors.append(f"[{code}] {message}")

    def warning(self, code: str, message: str) -> None:
        self.warnings.append(f"[{code}] {message}")

    @property
    def failed(self) -> bool:
        return bool(self.errors)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: {path}: невалидный JSON: {exc}") from exc


def normalize_requirements(data: Any) -> list[dict[str, Any]]:
    if data is None:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        reqs = data.get("requirements")
        if isinstance(reqs, list):
            return reqs
    raise SystemExit("ERROR: requirements.json: ожидается объект с полем requirements[]")


def normalize_sprints(data: Any) -> list[dict[str, Any]]:
    if data is None:
        return []
    if isinstance(data, dict) and isinstance(data.get("sprints"), list):
        return data["sprints"]
    if isinstance(data, list):
        return data
    raise SystemExit("ERROR: sprints.json: ожидается объект с полем sprints[]")


def validate_requirements(reqs: list[dict[str, Any]], check: Check) -> dict[str, dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for index, req in enumerate(reqs, start=1):
        if not isinstance(req, dict):
            check.error("SCHEMA", f"requirements[{index}] — не объект")
            continue
        rid = str(req.get("id", "")).strip()
        if not rid:
            check.error("SCHEMA", f"requirements[{index}]: нет id")
            continue
        if not ID_RE.match(rid):
            check.error("SCHEMA", f"{rid}: id должен быть вида R-001")
        if rid in by_id:
            check.error("SCHEMA", f"{rid}: дублирующийся id")
        by_id[rid] = req

        priority = str(req.get("priority", "")).strip().lower()
        if priority not in PRIORITIES:
            check.error("SCHEMA", f"{rid}: недопустимый priority={priority!r}")
        status = str(req.get("status", "planned")).strip().lower()
        if status not in STATUSES:
            check.error("SCHEMA", f"{rid}: недопустимый status={status!r}")
        rtype = str(req.get("type", "functional")).strip().lower()
        if rtype not in TYPES:
            check.warning("SCHEMA", f"{rid}: неизвестный type={rtype!r}")
        if not req.get("quote") and not req.get("title"):
            check.warning("SCHEMA", f"{rid}: нет quote/title — требование сложно проверить на источник")
        if not req.get("acceptance"):
            check.warning("SCHEMA", f"{rid}: нет acceptance — неясно, как считать выполненным")
    return by_id


def requirement_map_of(sprint: dict[str, Any]) -> dict[str, dict[str, list[Any]]]:
    """Поддерживает list[dict], dict[R, dict] и legacy requirement_ids."""
    raw = sprint.get("requirement_map")
    result: dict[str, dict[str, list[Any]]] = {}
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            rid = str(item.get("requirement_id") or item.get("id") or "").strip()
            if not rid:
                continue
            result[rid] = {
                "subtasks": list(item.get("subtasks") or []),
                "criteria": list(item.get("criteria") or []),
            }
    elif isinstance(raw, dict):
        for rid, item in raw.items():
            if isinstance(item, dict):
                result[str(rid)] = {
                    "subtasks": list(item.get("subtasks") or []),
                    "criteria": list(item.get("criteria") or []),
                }
            elif isinstance(item, list):
                result[str(rid)] = {"subtasks": list(item), "criteria": []}
    if not result:
        legacy_ids = sprint.get("requirement_ids")
        if isinstance(legacy_ids, list):
            for rid in legacy_ids:
                result[str(rid)] = {"subtasks": [], "criteria": []}
    return result


def sprint_number(sprint: dict[str, Any]) -> int | None:
    try:
        return int(sprint.get("sprint_number"))
    except (TypeError, ValueError):
        return None


def canonical_plan_payload(
    requirements: list[dict[str, Any]],
    sprints: list[dict[str, Any]],
) -> dict[str, Any]:
    """Каноническое представление плана для plan_hash.

    Хэш меняется при любом изменении требований, состава спринтов,
    requirement_map, подзадач, критериев, волн, design_pages или
    test_profile. Это защищает от переиспользования старого аудита.
    """
    req_items: list[dict[str, Any]] = []
    for req in sorted(requirements, key=lambda item: str(item.get("id", "")) if isinstance(item, dict) else ""):
        if not isinstance(req, dict):
            continue
        req_items.append(
            {
                "id": req.get("id"),
                "title": req.get("title"),
                "quote": req.get("quote"),
                "source_ref": req.get("source_ref"),
                "type": req.get("type"),
                "priority": req.get("priority"),
                "status": req.get("status"),
                "acceptance": req.get("acceptance"),
                "design": bool(req.get("design")),
            }
        )

    sprint_items: list[dict[str, Any]] = []
    for sprint in sorted(
        sprints,
        key=lambda item: (
            sprint_number(item) if isinstance(item, dict) else 0,
            str(item.get("name", "")) if isinstance(item, dict) else "",
        ),
    ):
        if not isinstance(sprint, dict):
            continue
        rmap = requirement_map_of(sprint)
        sprint_items.append(
            {
                "sprint_number": sprint_number(sprint),
                "name": sprint.get("name"),
                "description": sprint.get("description"),
                "subtasks": sprint.get("subtasks") or [],
                "coverage_criteria": sprint.get("coverage_criteria") or [],
                "requirement_map": {
                    rid: {"subtasks": refs["subtasks"], "criteria": refs["criteria"]}
                    for rid, refs in sorted(rmap.items())
                },
                "design_pages": sprint.get("design_pages") or [],
                "test_profile": sprint.get("test_profile"),
                "wave": sprint.get("wave"),
            }
        )

    return {"requirements": req_items, "sprints": sprint_items}


def plan_fingerprint(
    requirements: list[dict[str, Any]],
    sprints: list[dict[str, Any]],
) -> str:
    raw = json.dumps(
        canonical_plan_payload(requirements, sprints),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def check_plan(
    reqs: dict[str, dict[str, Any]],
    sprints: list[dict[str, Any]],
    check: Check,
    *,
    legacy_ok: bool,
    strict_tags: bool,
    allow_deferred: bool,
) -> None:
    if not reqs:
        if legacy_ok:
            check.warning("LEGACY", "requirements.json отсутствует/пуст — легаси-режим")
            return
        check.error("LEDGER", "requirements.json отсутствует/пуст; для нового плана ledger обязателен")
        return

    mapping: dict[str, list[tuple[int, dict[str, list[Any]]]]] = {}
    known_sprints: set[int] = set()

    for sprint in sprints:
        number = sprint_number(sprint)
        if number is None:
            check.error("SPRINT", "у спринта нет числового sprint_number")
            continue
        known_sprints.add(number)
        rmap = requirement_map_of(sprint)
        if not rmap:
            message = f"спринт {number}: нет requirement_map"
            if legacy_ok:
                check.warning("LEGACY", message)
            else:
                check.error("MAP", message)
            continue
        for rid, refs in rmap.items():
            if rid not in reqs:
                check.error("MAP", f"спринт {number}: неизвестный requirement_id {rid}")
                continue
            mapping.setdefault(rid, []).append((number, refs))
            if not refs["subtasks"]:
                check.error("MAP", f"спринт {number}: {rid} без subtasks")
            if not refs["criteria"]:
                check.error("MAP", f"спринт {number}: {rid} без criteria")
            subtask_count = len(sprint.get("subtasks") or [])
            criteria_count = len(sprint.get("coverage_criteria") or [])
            for key, refs_list, total in (
                ("subtask", refs["subtasks"], subtask_count),
                ("criterion", refs["criteria"], criteria_count),
            ):
                for ref in refs_list:
                    try:
                        index = int(ref)
                    except (TypeError, ValueError):
                        check.error("MAP", f"спринт {number}: {rid} — некорректный {key} {ref!r}")
                        continue
                    if index < 1 or index > total:
                        check.error(
                            "MAP",
                            f"спринт {number}: {rid} — {key} {index} вне диапазона 1..{total}",
                        )

    for rid, req in reqs.items():
        priority = str(req.get("priority", "")).strip().lower()
        status = str(req.get("status", "planned")).strip().lower()
        if priority in {"must", "should"}:
            if status in {"gap", "ambiguous"}:
                check.error("REQ", f"{rid}: статус {status} при priority={priority}")
            if status in {"backlog", "non_goal"} and not allow_deferred:
                check.error("REQ", f"{rid}: {priority}-требование помечено {status}")
            if rid not in mapping:
                check.error("GAP", f"{rid}: {priority}-требование не привязано ни к одному спринту")
        elif priority in {"could", "won't", "wont"}:
            if rid not in mapping and status not in {"backlog", "non_goal", "planned"}:
                check.warning("REQ", f"{rid}: {priority}-требование не в плане (статус {status})")

    # Критерии-теги в строках coverage_criteria.
    if strict_tags:
        for sprint in sprints:
            number = sprint_number(sprint)
            if number is None:
                continue
            rmap = requirement_map_of(sprint)
            if not rmap:
                continue
            criteria = sprint.get("coverage_criteria") or []
            if not isinstance(criteria, list):
                check.error("TAGS", f"спринт {number}: coverage_criteria должен быть списком")
                continue
            joined = "\n".join(str(c) for c in criteria)
            for rid in rmap:
                if rid not in joined:
                    check.error("TAGS", f"спринт {number}: {rid} не упомянут в coverage_criteria")
            untagged = [
                index
                for index, criterion in enumerate(criteria, start=1)
                if not re.search(r"\[[A-Z][A-Z0-9]*-\d{3,}\]", str(criterion))
            ]
            if untagged:
                check.warning(
                    "TAGS",
                    f"спринт {number}: критерии без [R-xxx]: {untagged[:10]}",
                )

    if known_sprints and len(known_sprints) != len(sprints):
        check.warning("SPRINT", "есть спринты с некорректным/повторяющимся номером")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def sprint_artifacts(root: Path, number: int) -> tuple[Path, Path, Path]:
    wave = root / "staff" / "sprints" / f"sprint-{number}"
    if wave.exists():
        return (
            wave / "spec.md",
            wave / "criteria.md",
            wave,
        )
    current = root / "staff" / "current-sprint"
    return current / "spec.md", current / "criteria.md", current


def check_spec(
    root: Path,
    number: int,
    reqs: dict[str, dict[str, Any]],
    sprints: list[dict[str, Any]],
    check: Check,
    *,
    legacy_ok: bool,
) -> None:
    sprint = next((s for s in sprints if sprint_number(s) == number), None)
    if sprint is None:
        check.error("SPRINT", f"спринт {number} не найден в sprints.json")
        return
    spec_path, criteria_path, artifact_dir = sprint_artifacts(root, number)
    spec = read_text(spec_path)
    criteria = read_text(criteria_path)
    if not spec:
        check.error("SPEC", f"нет {spec_path.relative_to(root)}")
        return
    if not criteria:
        check.error("SPEC", f"нет {criteria_path.relative_to(root)}")
        return

    rmap = requirement_map_of(sprint)
    if not rmap:
        message = f"спринт {number}: нет requirement_map"
        if legacy_ok:
            check.warning("LEGACY", message)
            return
        check.error("MAP", message)
        return

    design_ids = {
        rid
        for rid in rmap
        if str(reqs.get(rid, {}).get("type", "")).lower() == "design"
        or bool(reqs.get(rid, {}).get("design"))
    }

    for rid in rmap:
        if rid not in reqs:
            check.error("MAP", f"спринт {number}: неизвестный requirement_id {rid}")
            continue
        if rid not in spec:
            check.error("TRACE", f"спринт {number}: {rid} отсутствует в spec.md")
        if rid not in criteria:
            check.error("TRACE", f"спринт {number}: {rid} отсутствует в criteria.md")
        criterion_lines = [
            line for line in criteria.splitlines() if rid in line and line.strip()
        ]
        if not criterion_lines:
            check.error("TRACE", f"спринт {number}: у {rid} нет строки критерия")
        elif not any(any(marker in line for marker in ("Проверка", "Признак", "`", "curl", "GET", "POST")) for line in criterion_lines):
            check.warning("TRACE", f"спринт {number}: {rid} есть в criteria, но без явной проверки")

    if "Трассировка требований" not in spec:
        check.warning("TRACE", f"спринт {number}: в spec.md нет раздела «Трассировка требований»")

    if design_ids and "Дизайн-контракт" not in spec:
        check.error("DESIGN", f"спринт {number}: дизайн-требования {sorted(design_ids)} без раздела «Дизайн-контракт»")

    if "Тестовая стратегия" not in spec:
        check.warning("TEST", f"спринт {number}: в spec.md нет раздела «Тестовая стратегия»")

    empty_criteria = [
        index for index, line in enumerate(criteria.splitlines(), start=1)
        if re.match(r"^\s*\d+\.", line) and not re.search(r"\[[A-Z][A-Z0-9]*-\d{3,}\]", line)
    ]
    if empty_criteria:
        check.warning("TAGS", f"спринт {number}: критерии без R-ID: строки {empty_criteria[:10]}")

    _ = artifact_dir


def check_final(
    root: Path,
    reqs: dict[str, dict[str, Any]],
    sprints: list[dict[str, Any]],
    check: Check,
    *,
    legacy_ok: bool,
    strict_final: bool,
) -> None:
    if not reqs:
        if legacy_ok:
            check.warning("LEGACY", "requirements.json отсутствует/пуст — финальный аудит в легаси-режиме")
            return
        check.error("LEDGER", "requirements.json отсутствует/пуст")
        return

    mapping: dict[str, list[tuple[int, Path]]] = {}
    for sprint in sprints:
        number = sprint_number(sprint)
        if number is None:
            continue
        rmap = requirement_map_of(sprint)
        if not rmap:
            continue
        _, _, artifact_dir = sprint_artifacts(root, number)
        evidence_files = sorted(artifact_dir.glob("changelist*.md")) + sorted(
            artifact_dir.glob("review.md")
        )
        if not evidence_files:
            evidence_files = [artifact_dir / "changelist.md", artifact_dir / "review.md"]
        evidence = "\n".join(read_text(path) for path in evidence_files)
        for rid in rmap:
            mapping.setdefault(rid, []).append((number, evidence_files[0] if evidence_files else artifact_dir))
        for rid in rmap:
            if rid not in evidence:
                check.warning("EVIDENCE", f"спринт {number}: {rid} не упомянут в changelist/review")
                continue
            lines = [line for line in evidence.splitlines() if rid in line]
            if not any(any(marker in line for marker in SUCCESS_MARKERS) for line in lines):
                message = f"спринт {number}: {rid} без явного маркера успеха в доказательствах"
                if strict_final:
                    check.error("EVIDENCE", message)
                else:
                    check.warning("EVIDENCE", message)

        # Дизайн-требования: обязательный PASS, если спринт менял UI.
        design_ids = [
            rid
            for rid in rmap
            if str(reqs.get(rid, {}).get("type", "")).lower() == "design"
            or bool(reqs.get(rid, {}).get("design"))
        ]
        if design_ids:
            design_review_paths = [
                artifact_dir / "design-review.md",
                root / "staff" / "design-review" / f"sprint-{number}" / "design-review.md",
                artifact_dir / "review.md",
            ]
            design_text = "\n".join(read_text(path) for path in design_review_paths)
            if "DESIGN: PASS" not in design_text and "DESIGN: N/A" not in design_text:
                check.warning("DESIGN", f"спринт {number}: нет design-review.md с DESIGN: PASS для {sorted(design_ids)}")

    for rid, req in reqs.items():
        priority = str(req.get("priority", "")).strip().lower()
        status = str(req.get("status", "planned")).strip().lower()
        if priority in {"must", "should"}:
            if status in {"gap", "ambiguous"}:
                check.error("REQ", f"{rid}: статус {status} при priority={priority}")
            if rid not in mapping:
                check.error("GAP", f"{rid}: {priority}-требование не привязано к спринту")


def main() -> int:
    parser = argparse.ArgumentParser(description="Проверка покрытия концепции")
    parser.add_argument("--mode", choices=("plan", "spec", "final"), required=True)
    parser.add_argument("--sprint", type=int, help="номер спринта для mode=spec")
    parser.add_argument("--root", default=".", help="корень проекта (по умолчанию cwd)")
    parser.add_argument("--requirements", default="staff/requirements.json", help="путь к requirements.json")
    parser.add_argument("--sprints", default="staff/sprints.json", help="путь к sprints.json (можно draft)")
    parser.add_argument("--json", action="store_true", help="вывести JSON-сводку")
    parser.add_argument("--legacy-ok", action="store_true", help="разрешить отсутствие ledger/requirement_map")
    parser.add_argument("--strict-tags", action="store_true", help="требовать [R-xxx] в критериях")
    parser.add_argument("--no-strict-tags", action="store_true", help="не требовать [R-xxx] в критериях")
    parser.add_argument("--strict-final", action="store_true", help="считать отсутствие маркера успеха ошибкой")
    parser.add_argument("--allow-deferred", action="store_true", help="разрешить backlog/non_goal для must/should")
    parser.add_argument("--require-ledger", action="store_true", help="ошибка, если requirements.json нет")
    parser.add_argument(
        "--print-plan-hash",
        action="store_true",
        help="напечатать plan_hash текущего плана и выйти (для аудита)",
    )
    args = parser.parse_args()

    if args.mode == "spec" and not args.sprint:
        parser.error("--sprint обязателен для mode=spec")

    root = Path(args.root).resolve()
    check = Check()

    requirements_path = Path(args.requirements)
    if not requirements_path.is_absolute():
        requirements_path = root / requirements_path
    sprints_path = Path(args.sprints)
    if not sprints_path.is_absolute():
        sprints_path = root / sprints_path

    requirements_data = load_json(requirements_path)
    sprints_data = load_json(sprints_path)
    if requirements_data is None and args.require_ledger:
        check.error("LEDGER", f"{requirements_path.relative_to(root) if requirements_path.is_relative_to(root) else requirements_path} не найден")
    if sprints_data is None:
        check.error("SPRINTS", f"{sprints_path.relative_to(root) if sprints_path.is_relative_to(root) else sprints_path} не найден")

    reqs = normalize_requirements(requirements_data)
    sprints = normalize_sprints(sprints_data)
    fingerprint = plan_fingerprint(reqs, sprints)
    if args.print_plan_hash:
        print(fingerprint)
        return 0
    reqs_by_id = validate_requirements(reqs, check)

    strict_tags = not args.legacy_ok
    if args.strict_tags:
        strict_tags = True
    if args.no_strict_tags:
        strict_tags = False

    if args.mode == "plan":
        check_plan(
            reqs_by_id,
            sprints,
            check,
            legacy_ok=args.legacy_ok,
            strict_tags=strict_tags,
            allow_deferred=args.allow_deferred,
        )
    elif args.mode == "spec":
        check_spec(
            root,
            args.sprint,
            reqs_by_id,
            sprints,
            check,
            legacy_ok=args.legacy_ok,
        )
    else:
        check_final(
            root,
            reqs_by_id,
            sprints,
            check,
            legacy_ok=args.legacy_ok,
            strict_final=args.strict_final,
        )

    verdict = "FAIL" if check.failed else "PASS"
    payload = {
        "verdict": verdict,
        "mode": args.mode,
        "sprint": args.sprint,
        "plan_hash": fingerprint,
        "errors": check.errors,
        "warnings": check.warnings,
        "requirements": len(reqs_by_id),
        "sprints": len(sprints),
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"COVERAGE: {verdict}")
        print(f"mode={args.mode} requirements={len(reqs_by_id)} sprints={len(sprints)} plan_hash={fingerprint}")
        for item in check.errors:
            print(f"  ERROR {item}")
        for item in check.warnings:
            print(f"  WARN  {item}")
    return 1 if check.failed else 0


if __name__ == "__main__":
    sys.exit(main())

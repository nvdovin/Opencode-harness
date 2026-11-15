#!/usr/bin/env python3
"""Запуск тестовых профилей из staff/test-strategy.json.

Профили: fast / affected / full / e2e.
- affected вычисляет targets по git diff и test_map;
- full_if_changed принудительно включает full;
- зелёный full можно переиспользовать по tree_hash;
- результат пишется в staff/test-runs.json.

Не запускает тесты под собственным flock: если нужен flock, он должен быть
частью команды профиля.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_config(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"ERROR: нет {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: {path}: невалидный JSON: {exc}")
    if not isinstance(data, dict):
        raise SystemExit(f"ERROR: {path}: ожидается объект")
    return data


def run_git(root: Path, args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def tree_hash(root: Path) -> str | None:
    head = run_git(root, ["rev-parse", "HEAD"])
    if head is None:
        return None
    diff = run_git(root, ["diff", "--binary", "HEAD"])
    status = run_git(root, ["status", "--porcelain"])
    if diff is None or status is None:
        return None
    payload = (head + diff + status).encode("utf-8", errors="replace")
    return hashlib.sha256(payload).hexdigest()


def changed_files(root: Path) -> list[str]:
    files: list[str] = []
    tracked = run_git(root, ["diff", "--name-only", "HEAD"])
    if tracked:
        files.extend(line.strip() for line in tracked.splitlines() if line.strip())
    untracked = run_git(root, ["ls-files", "--others", "--exclude-standard"])
    if untracked:
        files.extend(line.strip() for line in untracked.splitlines() if line.strip())
    # На всякий случай — staged-only изменения, если HEAD diff их не покрыл.
    cached = run_git(root, ["diff", "--cached", "--name-only"])
    if cached:
        files.extend(line.strip() for line in cached.splitlines() if line.strip())
    return sorted(set(files))


def matches(path: str, pattern: str) -> bool:
    path = path.replace(os.sep, "/")
    pattern = pattern.replace(os.sep, "/")
    return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch("/" + path, pattern)


def force_full(files: list[str], patterns: list[str]) -> list[str]:
    return [file for file in files if any(matches(file, pattern) for pattern in patterns)]


def targets_for(files: list[str], test_map: dict[str, Any]) -> list[str]:
    targets: list[str] = []
    for pattern, value in test_map.items():
        if not any(matches(file, pattern) for file in files):
            continue
        if isinstance(value, str):
            targets.append(value)
        elif isinstance(value, list):
            targets.extend(str(item) for item in value)
    return sorted(dict.fromkeys(targets))


def build_command(profile: dict[str, Any], targets: list[str]) -> tuple[Any, bool]:
    command = profile.get("command")
    if not command:
        raise SystemExit("ERROR: в профиле нет command")
    shell = bool(profile.get("shell", isinstance(command, str)))
    if isinstance(command, list):
        expanded: list[str] = []
        for item in command:
            text = str(item)
            if "{targets}" in text:
                if text.strip() == "{targets}":
                    expanded.extend(targets)
                else:
                    expanded.append(text.replace("{targets}", " ".join(targets)))
            else:
                expanded.append(text)
        return expanded, shell
    return str(command).replace("{targets}", shlex.join(targets)), shell


def append_run(root: Path, record: dict[str, Any]) -> None:
    path = root / "staff" / "test-runs.json"
    data: dict[str, Any] = {"runs": []}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and isinstance(loaded.get("runs"), list):
                data = loaded
        except json.JSONDecodeError:
            data = {"runs": []}
    data["runs"].append(record)
    data["runs"] = data["runs"][-200:]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def last_green_full(root: Path, current_hash: str | None) -> dict[str, Any] | None:
    if not current_hash:
        return None
    path = root / "staff" / "test-runs.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    runs = data.get("runs") if isinstance(data, dict) else None
    if not isinstance(runs, list):
        return None
    for run in reversed(runs):
        if (
            isinstance(run, dict)
            and run.get("profile") == "full"
            and run.get("exit_code") == 0
            and run.get("tree_hash") == current_hash
        ):
            return run
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Запуск профиля тестов")
    parser.add_argument("--profile", choices=("fast", "affected", "full", "e2e"), required=True)
    parser.add_argument("--root", default=".", help="корень проекта")
    parser.add_argument("--config", default=None, help="путь к test-strategy.json")
    parser.add_argument("--changed", action="append", default=[], help="изменённый файл (можно повторять)")
    parser.add_argument("--git-diff", action="store_true", help="взять изменения из git")
    parser.add_argument("--reuse-green-full", action="store_true", help="переиспользовать зелёный full")
    parser.add_argument("--fallback-full", action="store_true", default=True, help="если affected не нашёл targets — full")
    parser.add_argument("--no-fallback-full", dest="fallback_full", action="store_false")
    parser.add_argument("--enforce-budget", action="store_true", help="exit 1 при превышении бюджета")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    config_path = Path(args.config) if args.config else root / "staff" / "test-strategy.json"
    if not config_path.is_absolute():
        config_path = root / config_path
    config = load_config(config_path)
    profiles = config.get("profiles")
    if not isinstance(profiles, dict):
        raise SystemExit("ERROR: test-strategy.json: нет profiles{}")

    profile_name = args.profile
    profile = profiles.get(profile_name)
    if not isinstance(profile, dict):
        raise SystemExit(f"ERROR: нет профиля {profile_name!r}")

    current_hash = tree_hash(root)
    if profile_name == "full" and args.reuse_green_full:
        previous = last_green_full(root, current_hash)
        if previous:
            message = (
                f"REUSED: full (exit 0, {previous.get('duration_seconds')}s, "
                f"tree_hash={str(current_hash)[:12]})"
            )
            print(message)
            if args.json:
                print(json.dumps({"reused": True, "profile": "full", "run": previous}, ensure_ascii=False, indent=2))
            return 0

    changed = list(args.changed)
    if args.git_diff or profile_name == "affected":
        changed.extend(changed_files(root))
    changed = sorted(set(changed))

    targets: list[str] = []
    forced: list[str] = []
    if profile_name == "affected":
        patterns = config.get("full_if_changed") or []
        if isinstance(patterns, list):
            forced = force_full(changed, [str(item) for item in patterns])
        if forced:
            profile_name = "full"
            profile = profiles.get("full")
            if not isinstance(profile, dict):
                raise SystemExit("ERROR: нет профиля full для fallback")
        else:
            test_map = config.get("test_map") or {}
            if isinstance(test_map, dict):
                targets = targets_for(changed, test_map)
            if not targets:
                if args.fallback_full:
                    profile_name = "full"
                    profile = profiles.get("full")
                    if not isinstance(profile, dict):
                        raise SystemExit("ERROR: нет профиля full для fallback")
                else:
                    raise SystemExit("ERROR: affected не нашёл targets; укажите --changed или test_map")

    command, shell = build_command(profile, targets)
    timeout = int(profile.get("timeout", 1800))
    budget = profile.get("budget_seconds")

    if not args.quiet:
        print(f"PROFILE: {profile_name}")
        if changed:
            print(f"CHANGED: {', '.join(changed[:20])}{' ...' if len(changed) > 20 else ''}")
        if forced:
            print(f"FORCED FULL: shared files changed: {', '.join(forced[:10])}")
        if targets:
            print(f"TARGETS: {' '.join(targets)}")
        print(f"COMMAND: {command if isinstance(command, str) else shlex.join(command)}")
        print(f"TIMEOUT: {timeout}s" + (f", BUDGET: {budget}s" if budget else ""))

    if args.dry_run:
        return 0

    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=root,
            shell=shell,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        exit_code = result.returncode
        stdout = result.stdout
        stderr = result.stderr
    except subprocess.TimeoutExpired as exc:
        exit_code = 124
        stdout = exc.stdout or ""
        stderr = (exc.stderr or "") + f"\nTIMEOUT after {timeout}s"
    duration = round(time.monotonic() - started, 3)

    if not args.quiet:
        if stdout:
            print(stdout)
        if stderr:
            print(stderr, file=sys.stderr)
        print(f"EXIT: {exit_code}")
        print(f"DURATION: {duration}s")
        if budget and duration > float(budget):
            print(f"BUDGET EXCEEDED: {duration}s > {budget}s")
        if exit_code == 0:
            print("PROFILE: PASS")
        else:
            print("PROFILE: FAIL")

    record = {
        "profile": profile_name,
        "requested_profile": args.profile,
        "command": command if isinstance(command, str) else command,
        "cwd": str(root),
        "exit_code": exit_code,
        "duration_seconds": duration,
        "timeout_seconds": timeout,
        "budget_seconds": budget,
        "targets": targets,
        "changed": changed,
        "forced_full": forced,
        "git_head": (run_git(root, ["rev-parse", "HEAD"]) or "").strip() or None,
        "tree_hash": current_hash,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    append_run(root, record)

    if args.json:
        print(json.dumps(record, ensure_ascii=False, indent=2))

    if exit_code != 0:
        return exit_code
    if args.enforce_budget and budget and duration > float(budget):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

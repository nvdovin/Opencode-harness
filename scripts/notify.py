#!/usr/bin/env python3
"""Уведомления конвейера в Telegram через единственного бота OpenCoder.

Секреты читаются только из TG_ENV_FILE (по умолчанию
~/.config/opencode/notify.env). Токен никогда не печатается и не попадает
в текст ошибок.

Использование:
    notify.py --check
    notify.py "текст сообщения"
    echo "текст" | notify.py --stdin

Коды возврата:
    0 — отправлено (или --check успешен)
    1 — ошибка отправки/конфигурации
    2 — ошибка аргументов
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_ENV = Path.home() / ".config" / "opencode" / "notify.env"
API_BASE = "https://api.telegram.org"
MAX_MESSAGE = 3500
TIMEOUT = 10


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return env
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        env[key] = value
    return env


def credentials() -> tuple[str, str]:
    path = Path(os.environ.get("TG_ENV_FILE", str(DEFAULT_ENV))).expanduser()
    env = load_env_file(path)
    token = env.get("TG_BOT_TOKEN", "").strip()
    chat_id = env.get("TG_CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError(f"в {path} нет TG_BOT_TOKEN/TG_CHAT_ID")
    return token, chat_id


def api_call(token: str, method: str, payload: dict | None = None) -> dict:
    url = f"{API_BASE}/bot{token}/{method}"
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        body = json.loads(response.read().decode("utf-8") or "{}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        description = body.get("description") if isinstance(body, dict) else "unknown"
        raise RuntimeError(f"Telegram API: {description}")
    result = body.get("result")
    return result if isinstance(result, dict) else {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Уведомление через бота OpenCoder")
    parser.add_argument("message", nargs="?", help="текст сообщения")
    parser.add_argument("--check", action="store_true", help="проверить токен через getMe")
    parser.add_argument("--stdin", action="store_true", help="прочитать сообщение из stdin")
    args = parser.parse_args(argv)

    try:
        token, chat_id = credentials()
        if args.check:
            me = api_call(token, "getMe")
            name = me.get("first_name") or "?"
            username = me.get("username") or "?"
            print(f"telegram: ok: {name} (@{username})")
            return 0

        if args.stdin:
            text = sys.stdin.read()
        else:
            text = args.message or ""
        text = text.strip()
        if not text:
            print("notify: пустое сообщение", file=sys.stderr)
            return 2
        if len(text) > MAX_MESSAGE:
            text = text[: MAX_MESSAGE - 1] + "…"

        result = api_call(
            token,
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "disable_web_page_preview": True,
            },
        )
        print(f"telegram: sent message_id={result.get('message_id', '?')}")
        return 0
    except urllib.error.HTTPError as exc:
        # Не печатаем URL: в нём токен.
        print(f"notify: HTTP {exc.code}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"notify: network: {exc.reason}", file=sys.stderr)
        return 1
    except (RuntimeError, OSError, ValueError) as exc:
        print(f"notify: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

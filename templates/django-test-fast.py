"""Быстрые настройки для тестов Django (шаблон).

Скопируйте в config/settings/test_fast.py (или аналог) и адаптируйте импорт.
Прод-настройки не менять. Тесты, которые проверяют именно хэширование,
должны переопределять PASSWORD_HASHERS через override_settings.

Запуск:
  python manage.py test --settings=config.settings.test_fast --keepdb --parallel 2
"""

from .dev import *  # noqa: F401,F403

DEBUG = False

# Тестовое окружение не должно тратить секунды на PBKDF2.
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]

# Необязательно: кэш шаблонов и отключение лишних проверок.
TEMPLATES = [
    {
        **template,
        "OPTIONS": {
            **template.get("OPTIONS", {}),
            "debug": False,
        },
    }
    for template in TEMPLATES  # noqa: F405
]

# Тестовая БД: имя можно переопределить, чтобы не пересекаться с другими прогонами.
DATABASES["default"].setdefault("TEST", {})  # noqa: F405
DATABASES["default"]["TEST"].setdefault("NAME", "test_fast")  # noqa: F405

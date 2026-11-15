# OpenCode Harness

Набор субагентов, общих инструкций и детерминированных скриптов для
конвейера разработки по спринтам: от свободной концепции до закрытых
спринтов с трассировкой требований.

Репозиторий — снимок рабочей конфигурации `~/.config/opencode`. Он не
содержит секретов: `.env`, `notify.env` и `service.json` исключены через
`.gitignore`.

## Состав

| Путь | Назначение |
|---|---|
| `agent/concept-sprint-planner.md` | превращает концепцию в `requirements.json` и `sprints.json` |
| `agent/concept-coverage-auditor.md` | извлекает требования и проверяет покрытие (extract / plan / spec / final) |
| `agent/sprint-planner.md` | готовит ТЗ спринта в `staff/current-sprint/` или `staff/sprints/sprint-N/` |
| `agent/sprint-implementer.md` | реализует ТЗ и ведёт changelist |
| `agent/sprint-reviewer.md` | проверяет критерии, R-ID и качество кода |
| `agent/ui-design-reviewer.md` | дизайн-ревью по `design-brief.md` и скриншотам 375/768/1440 |
| `agent/sprint-orchestrator.md` | ведёт конвейер: легаси-режим и волны |
| `instructions/` | общие правила: вопросы, покрытие, тесты, дизайн |
| `scripts/coverage_check.py` | механическая проверка покрытия и `plan_hash` |
| `scripts/run_profile.py` | профили тестов `fast/affected/full/e2e` |
| `scripts/design_audit.py` | DOM-аудит и скриншоты для UI |
| `scripts/notify.py` | единственный канал уведомлений — бот OpenCoder |
| `templates/` | шаблоны requirements, design-brief, test-strategy, Django fast settings |
| `plugin/telegram-bridge.ts` | плагин OpenCode: уведомления о сессиях и вопросах |
| `plugin/telegram-bridge/` | реализация моста и тесты |

## Конвейер

1. `concept-sprint-planner` фиксирует концепцию и решения, извлекает
   требования через аудитора, собирает план и проходит гейт `COVERAGE: PASS`.
2. `sprint-orchestrator` определяет режим по полю `wave`:
   - **легаси** — последовательные спринты через `staff/current-sprint/`;
   - **волновой** — параллельные линии в `staff/sprints/sprint-N/`.
3. Для каждого спринта: `sprint-planner` → аудит ТЗ → `sprint-implementer`
   → UI-ревью (если менялся UI) → `sprint-reviewer`.
4. На границе волны — один `full`-прогон тестов и финальный аудит покрытия.

### Гейты

- `COVERAGE: PASS` для плана, ТЗ спринта и финала.
- `DESIGN: PASS` или `DESIGN: N/A` для UI-спринтов.
- `plan_hash` в отчётах аудита защищает от переиспользования старого PASS
  после перепланирования.
- Тесты: implementer — targeted/`fast`, reviewer — `affected`,
  orchestrator — `full` один раз на волну.

## Установка

```bash
git clone git@github.com:nvdovin/Opencode-harness.git ~/.config/opencode
cd ~/.config/opencode
npm install
cp .env.example notify.env
chmod 600 notify.env
# впишите TG_BOT_TOKEN и TG_CHAT_ID бота OpenCoder
python3 scripts/notify.py --check
```

`opencode.jsonc` в репозитории содержит абсолютные пути `/root/...` —
это снимок рабочей машины. Для другой машины возьмите
`opencode.example.jsonc` и замените `~` на фактический путь, если ваша
версия OpenCode не раскрывает `~`.

## Уведомления

У конвейера **один** канал — бот OpenCoder:

```bash
python3 ~/.config/opencode/scripts/notify.py "текст"
python3 ~/.config/opencode/scripts/notify.py --check
```

`notify.py` читает только `~/.config/opencode/notify.env` (или путь из
`TG_ENV_FILE`). Он не читает `.env` проекта, не печатает токен и не
зависит от того, в каком проекте запущен конвейер.

Старые прямые вызовы `curl`/`api.telegram.org` из промптов удалены.
Плагин и `oc-notify-fail` используют тот же токен OpenCoder.

## Планировщик концепции

`concept-sprint-planner` работает по схеме:

```text
concept.md → requirements.json (extract + reconcile)
           → design-brief/test-strategy (если применимо)
           → sprints.draft.json
           → coverage_check.py (механика)
           → concept-coverage-auditor (смысл)
           → sprints.json (атомарно)
           → сброс трекеров с архивом
```

Ключевые правила:

- R-ID стабильны: повторный `extract` сохраняет существующие ID, новые
  получают `max+1`, удалённые помечаются `gap` и не переиспользуются.
- Дизайн-бриф и тест-стратегия создаются **до** аудита плана.
- При перепланировании `staff/coverage/` и журнал спринтов архивируются;
  старый `COVERAGE: PASS` не переиспользуется.
- `staff/.plan.lock` защищает от параллельного запуска планировщика.

## Безопасность

- Не коммитьте `.env`, `notify.env`, `service.json`.
- Токены не должны попадать в промпты, логи и `changelog`.
- `notify.py` не печатает URL с токеном и не включает его в текст ошибок.
- Перед публикацией форка проверьте `git grep` по токенам и паролям.

## Ограничения

- Плагин `telegram-bridge` рассчитан на Unix-сокет/HTTP API OpenCode и
  локальный `~/.config/opencode`.
- Скрипты используют стандартную библиотеку Python 3.10+; внешние
  зависимости нужны только для тестов плагина (`node`/`bun`).
- Абсолютные пути в `opencode.jsonc` и `plugin/telegram-bridge/config.ts`
  привязаны к рабочей машине; при переносе поправьте их.

# Покрытие концепции: сквозная трассировка

Эти правила действуют для всех проектов harness-конвейера.

## Источник правды

Цепочка артефактов, от сильного к слабому:

1. `staff/concept.md` — концепция пользователя дословно + журнал решений.
2. `staff/requirements.json` — атомарные требования с ID.
3. `staff/sprints.json` — план с `requirement_map`.
4. `staff/sprints/sprint-<N>/spec.md` и `criteria.md` — ТЗ спринта.
5. `changelist*.md` и `review.md` — доказательства выполнения.

Ни один агент не имеет права молча удалить, переформулировать или
проигнорировать требование. Любое изменение требования — только через
пользователя и с новой записью в `concept.md` (раздел «Решения»).

## ID требований

- Формат: `R-001`, `R-002`, …; ID стабильны и не переиспользуются.
- Типы: `functional`, `non_functional`, `design`, `security`, `migration`,
  `test`, `content`, `integration`, `constraint`.
- Приоритеты:
  - `must` — без этого проект не считается выполненным;
  - `should` — должно войти в план, может быть в позднем спринте;
  - `could` — backlog, только с явным согласием пользователя;
  - `won't` — явный non-goal, только с явным согласием пользователя.
- Статусы: `planned`, `specified`, `implemented`, `verified`,
  `backlog`, `non_goal`, `ambiguous`, `gap`.
- У каждого требования есть `quote` и `source_ref` — цитата и место в
  концепции. Требования не выдумываются: всё, чего нет в концепции или
  решениях пользователя, помечается как `derived` и требует подтверждения.

### Повторное извлечение (reconcile)

- Повторный `extract` не перенумеровывает существующие R-ID.
- Мысль сопоставляется с ledger по `quote` + `source_ref`, при изменении
  цитаты — по `source_ref` + `title`; неоднозначность сохраняет старый ID
  и помечается `ambiguous`.
- Новое требование получает `R-<max+1>`; номера удалённых не переиспользуются.
- Удалённое из концепции требование остаётся в ledger со `status: gap` и
  пометкой в `notes`, а не исчезает молча.
- Аудитор возвращает diff `added/updated/removed/renumbered`; список
  `renumbered` обязан быть пустым.

## `requirement_map` в `sprints.json`

Каждый спринт, участвующий в новом плане, содержит:

```json
"requirement_map": [
  {"requirement_id": "R-003", "subtasks": [1, 2], "criteria": [1, 4]}
]
```

- `subtasks` и `criteria` — номера (1-based) подзадач и критериев спринта.
- Один R-ID может быть в нескольких спринтах, если требование сквозное.
- Каждый критерий должен быть проверяемым: команда/URL/действие +
  ожидаемый результат.
- Если спринт содержит техническую подготовку без прямого требования,
  это оформляется как `requirement_id: "TECH-..."` с обоснованием, а не
  как скрытый обход покрытия.

## Определение 100%

- 100% мыслей концепции извлечены и классифицированы.
- 100% `must`/`should` привязаны к спринту, подзадаче и критерию.
- 100% критериев имеют команду/действие и ожидаемый результат.
- 100% реализованных `must`/`should` имеют доказательство в changelist/review.
- `could`/`won't` явно согласованы пользователем, а не потеряны.

«Упоминание в описании спринта» покрытием не считается. Нужна подзадача
и проверяемый критерий.

## Гейты

1. **План:** `concept-sprint-planner` не фиксирует финальный `staff/sprints.json` и не сбрасывает трекеры, пока `concept-coverage-auditor` не вернул `COVERAGE: PASS` в режиме `plan`. Черновик `staff/sprints.draft.json` допустим.
2. **ТЗ:** `sprint-orchestrator` не запускает implementer, пока аудитор не
   подтвердил `spec N`.
3. **Релиз/волна:** финальный аудит не пропускает следующую волну или релиз,
   если есть `must`/`should` без доказательств.
4. **Свежесть аудита:** каждый отчёт `plan-audit.md`, `sprint-N-audit.md`,
   `final-audit.md` содержит `plan_hash`. PASS с другим хешем — stale и не
   считается гейтом; нужен повторный аудит.
5. **Порядок артефактов:** `design-brief.md`, `design-audit.json` и
   `test-strategy.*` создаются до аудита плана. Если после `COVERAGE: PASS`
   изменились требования, план, дизайн или тест-стратегия — аудит
   повторяется.
6. **Перепланирование:** при новом плане `staff/coverage/` архивируется;
   старые `sprint-N-audit.md` не переиспользуются. `sprints-done.json`,
   `concept.md` и `requirements.json` архивируются перед сбросом.

## Обязанности агентов

- `concept-coverage-auditor` извлекает требования и проверяет покрытие;
  он не редактирует план и ТЗ.
- `concept-sprint-planner` пишет `concept.md`, `requirements.json`,
  `sprints.json`, `design-brief.md`, `test-strategy.*` и исправляет пробелы.
- `sprint-planner` переносит R-ID в spec/criteria и добавляет раздел
  «Трассировка требований».
- `sprint-implementer` ведёт статус по R-ID в changelist; при неясности
  пишет `REQUIREMENT-GAP: R-xxx ...` и не выдумывает.
- `sprint-reviewer` проверяет покрытие требований спринта и требует
  доказательства по каждому R-ID.
- `sprint-orchestrator` вызывает гейты и не пропускает спринт/волну/релиз
  при `COVERAGE: FAIL`.

## Легаси-проекты

Если `concept.md`/`requirements.json` ещё нет, аудитор может один раз
собрать ledger из `staff/prompt.md` или существующего `sprints.json`
и пометить его `"legacy": true`. Для нового плана ledger обязателен.
Легаси-план не блокируется автоматически, но получает предупреждение
`legacy_no_traceability` и рекомендацию добавить R-ID.

## Механическая проверка

Детерминированный чекер:

```bash
python3 ~/.config/opencode/scripts/coverage_check.py --mode plan
python3 ~/.config/opencode/scripts/coverage_check.py --mode plan --sprints staff/sprints.draft.json
python3 ~/.config/opencode/scripts/coverage_check.py --mode spec --sprint 3
python3 ~/.config/opencode/scripts/coverage_check.py --mode final
python3 ~/.config/opencode/scripts/coverage_check.py --mode plan --print-plan-hash
```

Он проверяет схему, ссылки, обязательные поля и наличие R-ID в артефактах.
Смысловую полноту и проверяемость критериев оценивает аудитор.

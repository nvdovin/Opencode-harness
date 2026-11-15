// Тесты routes.ts — маршруты, дедуп, corrupt-recovery, prune, атомарность,
// секция permissions (спринт 3) и секция questions (инструмент question).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoutes,
  DEFAULT_LOCK_TIMEOUT_MS,
  generateRid,
  permissionPendingKey,
  questionPendingKey,
  startupCleanup,
  type PermissionRoute,
  type QuestionRoute,
} from "../routes.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tb-routes-"));
}

test("test_record_and_get_message", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    await store.recordMessage(555, {
      sessionID: "ses_abc",
      serverUrl: "http://127.0.0.1:4100",
      directory: "/root/projects/opencode-telegram-notifier",
    });
    const route = await store.getMessage(555);
    assert.ok(route);
    assert.equal(route.sessionID, "ses_abc");
    assert.equal(route.serverUrl, "http://127.0.0.1:4100");
    assert.equal(route.directory, "/root/projects/opencode-telegram-notifier");
    assert.equal(typeof route.sentAt, "number");
    assert.equal(await store.getMessage(999), undefined);

    // персистентность: новый экземпляр читает те же данные
    const store2 = createRoutes({ stateDir: dir });
    const again = await store2.getMessage("555");
    assert.equal(again?.sessionID, "ses_abc");

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      version: number;
      messages: Record<string, unknown>;
      permissions: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
    assert.equal(raw.version, 1);
    assert.ok(raw.messages["555"]);
    assert.deepEqual(raw.permissions, {}, "permissions остаётся пустым объектом (подготовка спринта 4)");
    assert.deepEqual(raw.questions, {}, "questions остаётся пустым объектом");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_dedup_mark_sent", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const key = "ses_abc:msg_1";
    assert.equal(await store.hasSent(key), false);
    await store.markSent(key);
    assert.equal(await store.hasSent(key), true);
    assert.equal(await store.hasSent("ses_abc:msg_2"), false);

    // персистентно между экземплярами
    const store2 = createRoutes({ stateDir: dir });
    assert.equal(await store2.hasSent(key), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_corrupt_state_recovers", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "routes.json");
    writeFileSync(file, '{"version":1,"messages":{ BROKEN', "utf8");

    const store = createRoutes({ stateDir: dir });
    // битый JSON не роняет процесс
    assert.equal(await store.getMessage(1), undefined);
    assert.equal(await store.hasSent("any:key"), false);

    const files = readdirSync(dir);
    const corrupt = files.filter((name) => name.startsWith("routes.json.corrupt-"));
    assert.equal(corrupt.length, 1, `ожидался файл .corrupt-*, найдено: ${files.join(", ")}`);
    assert.ok(!files.includes("routes.json"), "битый файл должен быть переименован");

    // состояние начинается с пустого и запись работает
    await store.recordMessage(2, {
      sessionID: "ses_new",
      serverUrl: "http://127.0.0.1:4100",
      directory: "/tmp/x",
    });
    assert.equal((await store.getMessage(2))?.sessionID, "ses_new");

    // содержимое битого файла не попало в новый routes.json
    const fresh = readFileSync(file, "utf8");
    assert.ok(!fresh.includes("BROKEN"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_prune_expired", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const now = Date.now();
    await store.recordMessage(1, {
      sessionID: "old",
      serverUrl: "http://127.0.0.1:4100",
      directory: "/tmp/old",
      sentAt: now - 10 * 86400000,
    });
    await store.recordMessage(2, {
      sessionID: "fresh",
      serverUrl: "http://127.0.0.1:4100",
      directory: "/tmp/fresh",
      sentAt: now,
    });
    await store.markSent("old:key", now - 10 * 86400000);
    await store.markSent("fresh:key", now);

    const removed = await store.prune(7, now);
    assert.equal(removed, 1, "удаляется ровно просроченная запись");
    assert.equal(await store.getMessage(1), undefined);
    assert.ok(await store.getMessage(2));
    assert.equal(await store.hasSent("old:key"), false, "просроченный дедуп-ключ удаляется");
    assert.equal(await store.hasSent("fresh:key"), true);

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      messages: Record<string, unknown>;
    };
    assert.equal(Object.keys(raw.messages).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_atomic_write_keeps_valid_json", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (async () => {
          // небольшая рассинхронизация, чтобы записи реально пересекались
          await new Promise((resolve) => setTimeout(resolve, (index * 7) % 13));
          await store.recordMessage(1000 + index, {
            sessionID: `ses_${index}`,
            serverUrl: "http://127.0.0.1:4100",
            directory: `/tmp/dir_${index}`,
          });
        })(),
      ),
    );

    const file = join(dir, "routes.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { messages: Record<string, unknown> };
    assert.equal(Object.keys(raw.messages).length, 20, "ни одна из 20 записей не потеряна");

    const state = await store.readState();
    assert.equal(Object.keys(state.messages).length, 20);

    // нет остаточных tmp-файлов и локов
    const leftovers = readdirSync(dir).filter(
      (name) => name.includes(".tmp-") || name.endsWith(".lock"),
    );
    assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- спринт 3: секция permissions ---

function permissionRoute(overrides: Partial<PermissionRoute> = {}): PermissionRoute {
  return {
    sessionID: "ses_perm",
    permissionID: "perm_abc",
    serverUrl: "http://127.0.0.1:4100",
    directory: "/root/projects/opencode-telegram-notifier",
    messageId: 901,
    createdAt: Date.now(),
    ...overrides,
  };
}

test("test_permission_record_and_get", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    assert.equal(rid.length, 12, "rid — ровно 12 символов");
    assert.match(rid, /^[0-9a-f]{12}$/, "rid — hex без дефисов (crypto.randomUUID)");

    await store.recordPermission(rid, permissionRoute());
    const route = await store.getPermission(rid);
    assert.ok(route, "permission-маршрут должен читаться по rid");
    assert.equal(route.sessionID, "ses_perm");
    assert.equal(route.permissionID, "perm_abc");
    assert.equal(route.serverUrl, "http://127.0.0.1:4100");
    assert.equal(route.messageId, 901);
    assert.equal(typeof route.createdAt, "number");
    assert.equal(await store.getPermission("nope"), undefined);

    // дедуп по значению permissionID (rid заранее неизвестен)
    const found = await store.findPermissionByPermissionID("perm_abc");
    assert.equal(found?.messageId, 901);
    assert.equal(await store.findPermissionByPermissionID("perm_other"), undefined);

    // персистентность между экземплярами + общее состояние с messages
    await store.recordMessage(77, {
      sessionID: "ses_msg",
      serverUrl: "http://127.0.0.1:4100",
      directory: "/tmp/x",
    });
    const store2 = createRoutes({ stateDir: dir });
    assert.equal((await store2.getPermission(rid))?.permissionID, "perm_abc");
    assert.ok(await store2.getMessage(77));

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      version: number;
      permissions: Record<string, PermissionRoute>;
      messages: Record<string, unknown>;
    };
    assert.equal(raw.version, 1);
    assert.equal(raw.permissions[rid].sessionID, "ses_perm");
    assert.ok(raw.messages["77"], "секции живут в одном файле");

    // права файла маршрутов — 600
    const mode = statSync(join(dir, "routes.json")).mode & 0o777;
    assert.equal(mode.toString(8), "600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_permission_dedup_lookup_by_permission_id", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    await store.recordPermission(rid, permissionRoute({ permissionID: "perm_dup" }));

    // повторный поиск того же permissionID находит первую запись → обработчик выйдет без отправки
    const again = await store.findPermissionByPermissionID("perm_dup");
    assert.equal(again?.sessionID, "ses_perm");
    // чужой permissionID не совпадает
    assert.equal(await store.findPermissionByPermissionID("perm_dup2"), undefined);
    // пустой аргумент не матчится
    assert.equal(await store.findPermissionByPermissionID(""), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_prune_permissions_expired", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const now = Date.now();
    const oldRid = generateRid();
    const freshRid = generateRid();
    await store.recordPermission(
      oldRid,
      permissionRoute({ permissionID: "perm_old", createdAt: now - 10 * 86400000 }),
    );
    await store.recordPermission(
      freshRid,
      permissionRoute({ permissionID: "perm_fresh", createdAt: now }),
    );

    const removed = await store.prunePermissions(7, now);
    assert.equal(removed, 1, "удаляется ровно просроченная permission-запись");
    assert.equal(await store.getPermission(oldRid), undefined);
    assert.ok(await store.getPermission(freshRid));
    assert.equal(await store.findPermissionByPermissionID("perm_old"), undefined);
    assert.ok(await store.findPermissionByPermissionID("perm_fresh"));

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      permissions: Record<string, unknown>;
    };
    assert.equal(Object.keys(raw.permissions).length, 1);
    assert.equal(Object.keys(raw.permissions)[0], freshRid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_claim_pending_atomic", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });

    // первый claim занимает отправку, повторный видит «в полёте»
    assert.equal(await store.claimPending("ses:a1"), "claimed");
    assert.equal(await store.claimPending("ses:a1"), "pending");

    // после снятия pending можно занять снова (ошибка доставки → повтор)
    await store.clearPending("ses:a1");
    assert.equal(await store.claimPending("ses:a1"), "claimed");

    // после успешной отправки (markSent) — дедуп
    await store.markSent("ses:a1");
    assert.equal(await store.claimPending("ses:a1"), "duplicate");

    // устаревший pending (дочерний процесс убит) перезанимается
    await store.markPending("ses:stale", Date.now() - 11 * 60 * 1000);
    assert.equal(await store.claimPending("ses:stale"), "claimed");

    // состояние персистентно
    const store2 = createRoutes({ stateDir: dir });
    assert.equal(await store2.claimPending("ses:a1"), "duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- спринт 6: атомарный claimPermission, лок, cleanup tmp ---

test("test_claim_permission_atomic", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });

    // первый claim занимает permission, повторный видит pending → duplicate
    assert.equal(await store.claimPermission("perm_a"), "claimed");
    assert.equal(await store.claimPermission("perm_a"), "duplicate");

    // снятие pending без записи маршрута (ошибка отправки) → retry проходит
    await store.clearPending(permissionPendingKey("perm_a"));
    assert.equal(await store.claimPermission("perm_a"), "claimed");
    await store.clearPending(permissionPendingKey("perm_a"));

    // запись маршрута (recordPermission) → claim снова duplicate,
    // даже после снятия pending: маршрут уже есть в permissions
    await store.recordPermission(generateRid(), permissionRoute({ permissionID: "perm_a" }));
    await store.clearPending(permissionPendingKey("perm_a"));
    assert.equal(await store.claimPermission("perm_a"), "duplicate");

    // пустой permissionID не занимается
    assert.equal(await store.claimPermission(""), "duplicate");

    // состояние персистентно между экземплярами
    const store2 = createRoutes({ stateDir: dir });
    assert.equal(await store2.claimPermission("perm_a"), "duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_claim_permission_cross_instance", async () => {
  const dir = tmp();
  try {
    // два независимых экземпляра (как два процесса): файловый лок сериализует,
    // ровно один claim получает "claimed"
    const storeA = createRoutes({ stateDir: dir });
    const storeB = createRoutes({ stateDir: dir });
    const results = await Promise.all([
      storeA.claimPermission("perm_race"),
      storeB.claimPermission("perm_race"),
    ]);
    assert.deepEqual(
      [...results].sort(),
      ["claimed", "duplicate"],
      "ровно один процесс занял permission",
    );
    const state = await storeA.readState();
    assert.equal(state.pending[permissionPendingKey("perm_race")] !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_lock_timeout_default_and_stale_lock", async () => {
  // дефолт таймаута лока поднят с 2 с до 10 с
  assert.equal(DEFAULT_LOCK_TIMEOUT_MS, 10_000);

  const dir = tmp();
  try {
    const lockFile = join(dir, "routes.json.lock");
    const store = createRoutes({ stateDir: dir, lockTimeoutMs: 150 });

    // свежий чужой лок → таймаут ожидания
    writeFileSync(lockFile, "", { mode: 0o600 });
    await assert.rejects(
      () =>
        store.recordMessage(1, {
          sessionID: "ses_lock",
          serverUrl: "http://127.0.0.1:4100",
          directory: "/tmp/x",
        }),
      /timeout waiting for lock/,
    );
    assert.ok(existsSync(lockFile), "чужой лок не удалён при таймауте");

    // устаревший лок (владелец умер) снимается автоматически и запись проходит
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockFile, past, past);
    await store.recordMessage(1, {
      sessionID: "ses_lock",
      serverUrl: "http://127.0.0.1:4100",
      directory: "/tmp/x",
    });
    assert.ok(await store.getMessage(1), "запись после снятия stale-лока успешна");
    assert.ok(!existsSync(lockFile), "лок снят после работы");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cleanup_stale_tmp", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const staleTmp = join(dir, "routes.json.tmp-dead");
    const freshTmp = join(dir, "routes.json.tmp-live");
    const otherFile = join(dir, "routes.json.corrupt-1");
    writeFileSync(staleTmp, "{}");
    writeFileSync(freshTmp, "{}");
    writeFileSync(otherFile, "{}");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    // осиротевший старше часа — удалён; свежий и чужой файл — нет
    const removed = await store.cleanupStaleTmp();
    assert.equal(removed, 1, "удалён ровно один осиротевший tmp");
    assert.ok(!existsSync(staleTmp), "старый tmp удалён");
    assert.ok(existsSync(freshTmp), "свежий tmp не тронут");
    assert.ok(existsSync(otherFile), "не-tmp файл не тронут");
    assert.equal(await store.cleanupStaleTmp(), 0, "повторно удалять нечего");

    // startupCleanup вызывает cleanupStaleTmp и возвращает счётчик tmp
    const staleAgain = join(dir, "routes.json.tmp-dead2");
    writeFileSync(staleAgain, "{}");
    utimesSync(staleAgain, twoHoursAgo, twoHoursAgo);
    const result = await startupCleanup(store, 7);
    assert.equal(result.tmp, 1, "startupCleanup удалил осиротевший tmp");
    assert.ok(!existsSync(staleAgain));
    assert.equal(typeof result.messages, "number");
    assert.equal(typeof result.permissions, "number");
    assert.equal(typeof result.questions, "number", "startupCleanup учитывает секцию questions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- секция questions: маршруты инструмента question ---

function questionRoute(overrides: Partial<QuestionRoute> = {}): QuestionRoute {
  return {
    sessionID: "ses_question",
    requestID: "que_abc123",
    serverUrl: "http://127.0.0.1:4100",
    directory: "/root/projects/opencode-telegram-notifier",
    messageId: 911,
    questions: [
      {
        question: "Какой формат?",
        header: "format",
        options: [
          { label: "JSON", description: "структурированный" },
          { label: "YAML", description: "" },
        ],
        multiple: false,
        custom: false,
      },
    ],
    createdAt: Date.now(),
    ...overrides,
  };
}

test("test_question_field_index_round_trip", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    await store.recordQuestion(
      rid,
      questionRoute({
        questions: [
          { question: "Свободный?", header: "", options: [], multiple: false, custom: true, fieldIndex: 5 },
          {
            question: "Вариантный?",
            header: "",
            options: [{ label: "A", description: "" }],
            multiple: false,
            custom: false,
            fieldIndex: 7,
          },
        ],
        fieldIndex: 5,
      }),
    );
    const route = await store.getQuestion(rid);
    assert.ok(route, "маршрут с fieldIndex читается");
    assert.equal(route.questions[0].fieldIndex, 5, "fieldIndex вопроса персистится");
    assert.equal(route.questions[1].fieldIndex, 7);
    assert.equal(route.fieldIndex, 5, "route-level fieldIndex персистится");

    // запись старого формата (без fieldIndex) читается без изменений — TTL не ломается
    const legacyRid = generateRid();
    await store.recordQuestion(legacyRid, questionRoute());
    const legacy = await store.getQuestion(legacyRid);
    assert.ok(legacy, "старая запись без fieldIndex читается");
    assert.equal(legacy.fieldIndex, undefined);
    assert.equal(legacy.questions[0].fieldIndex, undefined);
    assert.equal(typeof legacy.createdAt, "number");

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      questions: Record<string, QuestionRoute>;
    };
    assert.equal(raw.questions[rid].questions[0].fieldIndex, 5, "fieldIndex попадает в файл");
    assert.equal(raw.questions[legacyRid].fieldIndex, undefined, "legacy-запись без нового поля");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_question_sequential_round_trip", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    await store.recordQuestion(rid, questionRoute({ sequential: true, messageId: 555 }));

    const route = await store.getQuestion(rid);
    assert.ok(route, "sequential-маршрут читается");
    assert.equal(route.sequential, true, "sequential персистится");
    assert.equal(route.messageId, 555, "messageId = сообщение Q1");
    assert.equal(route.questions.length, 1);

    // legacy-запись без поля читается, sequential не подставляется
    const legacyRid = generateRid();
    await store.recordQuestion(legacyRid, questionRoute());
    const legacy = await store.getQuestion(legacyRid);
    assert.ok(legacy, "legacy-маршрут читается");
    assert.equal(legacy.sequential, undefined);
    assert.equal(legacy.messageId, 911);

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      questions: Record<string, QuestionRoute>;
    };
    assert.equal(raw.questions[rid].sequential, true, "sequential попадает в файл");
    assert.equal(raw.questions[legacyRid].sequential, undefined, "legacy-запись не получает поле");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_question_record_and_get", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    assert.equal(rid.length, 12, "rid — ровно 12 символов");

    await store.recordQuestion(rid, questionRoute());
    const route = await store.getQuestion(rid);
    assert.ok(route, "question-маршрут должен читаться по rid");
    assert.equal(route.sessionID, "ses_question");
    assert.equal(route.requestID, "que_abc123");
    assert.equal(route.serverUrl, "http://127.0.0.1:4100");
    assert.equal(route.directory, "/root/projects/opencode-telegram-notifier");
    assert.equal(route.messageId, 911);
    assert.equal(route.questions.length, 1);
    assert.deepEqual(route.questions[0].options, [
      { label: "JSON", description: "структурированный" },
      { label: "YAML", description: "" },
    ]);
    assert.equal(route.questions[0].multiple, false);
    assert.equal(typeof route.createdAt, "number");
    assert.equal(await store.getQuestion("nope"), undefined);

    // удаление
    await store.removeQuestion(rid);
    assert.equal(await store.getQuestion(rid), undefined);

    // персистентность между экземплярами
    const rid2 = generateRid();
    await store.recordQuestion(rid2, questionRoute());
    const store2 = createRoutes({ stateDir: dir });
    assert.equal((await store2.getQuestion(rid2))?.requestID, "que_abc123");

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      version: number;
      questions: Record<string, QuestionRoute>;
      messages: Record<string, unknown>;
      permissions: Record<string, unknown>;
    };
    assert.equal(raw.version, 1);
    assert.ok(raw.questions[rid2], "секция questions пишется в тот же файл");
    assert.deepEqual(raw.permissions, {});
    assert.ok(raw.messages, "секции живут вместе");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_question_dedup_by_request_id", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    await store.recordQuestion(rid, questionRoute({ requestID: "que_dup" }));

    const found = await store.getQuestionByRequestID("que_dup");
    assert.equal(found?.rid, rid, "по requestID возвращается rid + маршрут");
    assert.equal(found?.route.sessionID, "ses_question");
    assert.equal(await store.getQuestionByRequestID("que_other"), undefined);
    assert.equal(await store.getQuestionByRequestID(""), undefined, "пустой requestID не матчится");

    await store.removeQuestion(rid);
    assert.equal(await store.getQuestionByRequestID("que_dup"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_take_question_by_request_id_wins_once", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    await store.recordQuestion(rid, questionRoute({ requestID: "que_take" }));

    const first = await store.takeQuestionByRequestID("que_take");
    assert.equal(first?.rid, rid, "первый вызов забирает маршрут");
    assert.equal(first?.route.requestID, "que_take");
    assert.equal(await store.getQuestion(rid), undefined, "маршрут удалён атомарно");
    assert.equal(
      await store.takeQuestionByRequestID("que_take"),
      undefined,
      "второй процесс уже не получит маршрут",
    );
    assert.equal(await store.takeQuestionByRequestID(""), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_question_get_by_message", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const rid = generateRid();
    await store.recordQuestion(rid, questionRoute({ messageId: 7777 }));

    const route = await store.getQuestionByMessage(7777);
    assert.ok(route, "маршрут находится по message_id");
    assert.equal(route.requestID, "que_abc123");
    assert.equal(await store.getQuestionByMessage(7778), undefined);
    assert.equal(await store.getQuestionByMessage(0), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_question_prune_expired", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });
    const now = Date.now();
    const oldRid = generateRid();
    const freshRid = generateRid();
    await store.recordQuestion(
      oldRid,
      questionRoute({ requestID: "que_old", createdAt: now - 10 * 86400000 }),
    );
    await store.recordQuestion(
      freshRid,
      questionRoute({ requestID: "que_fresh", messageId: 912, createdAt: now }),
    );

    const removed = await store.pruneQuestions(7, now);
    assert.equal(removed, 1, "удаляется ровно просроченная question-запись");
    assert.equal(await store.getQuestion(oldRid), undefined);
    assert.ok(await store.getQuestion(freshRid));
    assert.equal(await store.getQuestionByRequestID("que_old"), undefined);

    const raw = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")) as {
      questions: Record<string, unknown>;
    };
    assert.equal(Object.keys(raw.questions).length, 1);
    assert.equal(Object.keys(raw.questions)[0], freshRid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_questions_survive_legacy_file", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "routes.json");
    // legacy-файл без секции questions читается как {questions: {}}
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        messages: {
          "555": {
            sessionID: "ses_old",
            serverUrl: "http://127.0.0.1:4100",
            directory: "/tmp/x",
            sentAt: 1000,
          },
        },
        permissions: {},
        dedup: {},
        pending: {},
      }),
      "utf8",
    );

    const store = createRoutes({ stateDir: dir });
    const state = await store.readState();
    assert.deepEqual(state.questions, {}, "legacy-файл без questions → questions={}");
    assert.equal(await store.getQuestion("unknown_rid"), undefined);
    assert.equal(await store.getQuestionByRequestID("que_x"), undefined);
    assert.ok(await store.getMessage(555), "прочие секции не пострадали");

    // запись в legacy-файл работает и добавляет секцию questions
    const newRid = generateRid();
    await store.recordQuestion(newRid, questionRoute());
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      questions: Record<string, QuestionRoute>;
    };
    assert.equal(raw.questions[newRid].requestID, "que_abc123");
    assert.ok(raw.questions[newRid].createdAt);

    // неизвестные секции не роняют чтение
    writeFileSync(
      file,
      JSON.stringify({ version: 1, futureSection: { x: 1 }, questions: {} }),
      "utf8",
    );
    const future = await store.readState();
    assert.deepEqual(future.questions, {});
    assert.equal(future.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_claim_question_atomic", async () => {
  const dir = tmp();
  try {
    const store = createRoutes({ stateDir: dir });

    // первый claim занимает вопрос, повторный видит pending → duplicate
    assert.equal(await store.claimQuestion("que_a"), "claimed");
    assert.equal(await store.claimQuestion("que_a"), "duplicate");

    // снятие pending без записи маршрута (ошибка отправки) → retry проходит
    await store.clearQuestionPending(questionPendingKey("que_a"));
    assert.equal(await store.claimQuestion("que_a"), "claimed");
    await store.clearQuestionPending(questionPendingKey("que_a"));

    // запись маршрута (recordQuestion) → claim снова duplicate,
    // даже после снятия pending: маршрут уже есть в questions
    await store.recordQuestion(generateRid(), questionRoute({ requestID: "que_a" }));
    await store.clearQuestionPending(questionPendingKey("que_a"));
    assert.equal(await store.claimQuestion("que_a"), "duplicate");

    // пустой requestID не занимается
    assert.equal(await store.claimQuestion(""), "duplicate");

    // состояние персистентно между экземплярами
    const store2 = createRoutes({ stateDir: dir });
    assert.equal(await store2.claimQuestion("que_a"), "duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_claim_question_cross_instance", async () => {
  const dir = tmp();
  try {
    // два независимых экземпляра (как два процесса): файловый лок сериализует,
    // ровно один claim получает "claimed"
    const storeA = createRoutes({ stateDir: dir });
    const storeB = createRoutes({ stateDir: dir });
    const results = await Promise.all([
      storeA.claimQuestion("que_race"),
      storeB.claimQuestion("que_race"),
    ]);
    assert.deepEqual(
      [...results].sort(),
      ["claimed", "duplicate"],
      "ровно один процесс занял вопрос",
    );
    const state = await storeA.readState();
    assert.equal(state.pending[questionPendingKey("que_race")] !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

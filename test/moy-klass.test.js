const test = require("node:test");
const assert = require("node:assert/strict");
const { MoyKlassService, gradeFromName, gradeFromUser, resolveSubject, isAllowedClientState } = require("../src/moy-klass");

test("Moy Klass uses the company key only to obtain a temporary access token", async () => {
  const requests = [];
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
    },
  });
  assert.equal(await service.getAccessToken(), "temporary-token");
  assert.equal(requests[0].url, "https://api.moyklass.com/v1/company/auth/getToken");
  assert.deepEqual(JSON.parse(requests[0].options.body), { apiKey: "company-key" });
});

test("Moy Klass extracts a grade only from an explicit class label", () => {
  assert.equal(gradeFromName("Математика, 8 класс"), 8);
  assert.equal(gradeFromName("Подготовка к ЦТ"), null);
});

test("Moy Klass reads grade from user attribute klass_uchenika", () => {
  assert.equal(gradeFromUser({ attributes: [{ attributeAlias: "klass_uchenika", value: "9" }] }), 9);
  assert.equal(gradeFromUser({ attributes: [] }), null);
});

test("Moy Klass prefers class subject over generic Individual course", () => {
  assert.equal(
    resolveSubject({ name: "Математика", courseId: 0 }, { name: "Индивидуальное обучение" }),
    "Математика"
  );
  assert.equal(
    resolveSubject({ name: "9МС1", courseId: 104046 }, { name: "Математика" }),
    "Математика"
  );
});

test("Moy Klass retries HTTP 429 before succeeding", async () => {
  let calls = 0;
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => "0" },
          text: async () => "",
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
    },
  });
  assert.equal(await service.getAccessToken(), "temporary-token");
  assert.equal(calls, 2);
});

test("Moy Klass getAll stops when API ignores pagination and returns a full dump", async () => {
  let calls = 0;
  const dump = Array.from({ length: 150 }, (_, index) => ({ id: index + 1 }));
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(dump) };
    },
  });
  const items = await service.getAll("/managers", "temporary-token");
  assert.equal(items.length, 150);
  assert.equal(calls, 1);
});

test("Moy Klass getAll reads nested users and joins collections", async () => {
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url) => {
      if (String(url).includes("/users")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ users: [{ id: 1 }, { id: 2 }], stats: { totalItems: 2 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ joins: [{ id: 10, userId: 1 }], stats: { totalItems: 1 } }),
      };
    },
  });
  assert.equal((await service.getAll("/users", "temporary-token")).length, 2);
  assert.equal((await service.getAll("/joins", "temporary-token")).length, 1);
});

test("Moy Klass syncTeacherStudents links students and saves the lesson without a transcript", async () => {
  const calls = [];
  const database = {
    upsertMoyKlassStudent: async (user, meta) => {
      calls.push(["upsert", user.id, meta.tutorId, meta.subject, meta.grade]);
      return { id: Number(user.id) + 1000 };
    },
    linkTutorStudent: async (tutorId, studentId) => {
      calls.push(["link", tutorId, studentId]);
    },
    pruneTutorStudents: async (tutorId, keepIds) => {
      calls.push(["prune", tutorId, keepIds]);
    },
    syncMoyKlassLesson: async (input) => {
      calls.push(["lesson", input.myKlassLessonId, input.studentId, input.tutorId, input.lessonDate, input.topic, input.description]);
      return { created: true, transcriptCreated: false };
    },
  };
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.includes("/auth/getToken")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
      }
      if (href.includes("/lessons?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessons: [{ id: 77, date: "2026-01-10", classId: 12, teacherIds: [214414] }], stats: { totalItems: 1 } }) };
      }
      if (href.includes("/classes?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 12, name: "Математика", courseId: 0 }]) };
      }
      if (href.includes("/courses?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 0, name: "Индивидуальное обучение" }]) };
      }
      if (href.includes("/lessonRecords?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessonRecords: [{ userId: 55, lessonId: 77, visit: true }], stats: { totalItems: 1 } }) };
      }
      if (href.endsWith("/users/55")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            id: 55,
            name: "Ученик",
            clientStateId: 179145,
            attributes: [{ attributeAlias: "klass_uchenika", attributeName: "Класс ученика", value: "8" }],
          }),
        };
      }
      throw new Error(`Unexpected URL ${href} ${options?.method || "GET"}`);
    },
  });
  const result = await service.syncTeacherStudents(database, { id: 9, my_klass_id: "214414" });
  assert.deepEqual(result, { lessons: 1, students: 1, lessonsSynced: 1, transcripts: 0 });
  assert.deepEqual(calls, [
    ["upsert", 55, 9, "Математика", 8],
    ["link", 9, 1055],
    ["lesson", "77", 1055, 9, "2026-01-10", null, null],
    ["prune", 9, [1055]],
  ]);
});

test("Moy Klass syncTeacherStudents syncs lesson description as a transcript", async () => {
  const calls = [];
  const database = {
    upsertMoyKlassStudent: async (user, meta) => {
      calls.push(["upsert", user.id, meta.tutorId, meta.subject, meta.grade]);
      return { id: Number(user.id) + 1000 };
    },
    linkTutorStudent: async (tutorId, studentId) => {
      calls.push(["link", tutorId, studentId]);
    },
    pruneTutorStudents: async (tutorId, keepIds) => {
      calls.push(["prune", tutorId, keepIds]);
    },
    syncMoyKlassLesson: async (input) => {
      calls.push(["lesson", input.myKlassLessonId, input.studentId, input.tutorId, input.lessonDate, input.topic, input.description]);
      return { created: true, transcriptCreated: true };
    },
  };
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.includes("/auth/getToken")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
      }
      if (href.includes("/lessons?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessons: [{ id: 77, date: "2026-01-10", classId: 12, teacherIds: [214414], topic: "Дискриминант", description: "Разобрали формулу дискриминанта" }], stats: { totalItems: 1 } }) };
      }
      if (href.includes("/classes?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 12, name: "Математика", courseId: 0 }]) };
      }
      if (href.includes("/courses?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 0, name: "Индивидуальное обучение" }]) };
      }
      if (href.includes("/lessonRecords?")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessonRecords: [{ userId: 55, lessonId: 77, visit: true }], stats: { totalItems: 1 } }) };
      }
      if (href.endsWith("/users/55")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            id: 55,
            name: "Ученик",
            clientStateId: 179145,
            attributes: [{ attributeAlias: "klass_uchenika", attributeName: "Класс ученика", value: "8" }],
          }),
        };
      }
      throw new Error(`Unexpected URL ${href} ${options?.method || "GET"}`);
    },
  });
  const result = await service.syncTeacherStudents(database, { id: 9, my_klass_id: "214414" });
  assert.deepEqual(result, { lessons: 1, students: 1, lessonsSynced: 1, transcripts: 1 });
  assert.deepEqual(calls, [
    ["upsert", 55, 9, "Математика", 8],
    ["link", 9, 1055],
    ["lesson", "77", 1055, 9, "2026-01-10", "Дискриминант", "Разобрали формулу дискриминанта"],
    ["prune", 9, [1055]],
  ]);
});

test("isAllowedClientState keeps only Клиент and Временно прекратил заниматься", () => {
  assert.equal(isAllowedClientState({ clientStateId: 179145 }), true); // Клиент
  assert.equal(isAllowedClientState({ clientStateId: 186173 }), true); // Временно прекратил заниматься
  assert.equal(isAllowedClientState({ clientStateId: 208697 }), false); // Посетил пробное
  assert.equal(isAllowedClientState({ clientStateId: 179141 }), false); // Новая заявка
  assert.equal(isAllowedClientState({ clientStateId: 179142 }), false); // промежуточный/недопустимый статус
  assert.equal(isAllowedClientState({ clientStateId: 179144 }), false); // Некачественный лид
  assert.equal(isAllowedClientState({ clientStateId: 179146 }), false); // Неактивный клиент
  assert.equal(isAllowedClientState({ clientStateId: 191959 }), false); // Прекратил
  assert.equal(isAllowedClientState({}), false);
});

test("Moy Klass syncTeacherStudents skips lesson records the student did not attend", async () => {
  const calls = [];
  const database = {
    upsertMoyKlassStudent: async (user, meta) => { calls.push(["upsert", user.id, meta.tutorId]); return { id: Number(user.id) + 1000 }; },
    linkTutorStudent: async (tutorId, studentId) => { calls.push(["link", tutorId, studentId]); },
    pruneTutorStudents: async (tutorId, keepIds) => { calls.push(["prune", tutorId, keepIds]); },
    syncMoyKlassLesson: async () => { calls.push(["lesson"]); return { created: true, transcriptCreated: false }; },
  };
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/auth/getToken")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
      if (href.includes("/lessons?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessons: [{ id: 77, date: "2026-01-10", classId: 12, teacherIds: [214414] }], stats: { totalItems: 1 } }) };
      if (href.includes("/classes?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 12, name: "Математика", courseId: 0 }]) };
      if (href.includes("/courses?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 0, name: "Индивидуальное обучение" }]) };
      // Booked but not attended: no lesson, no student in the tutor's list.
      if (href.includes("/lessonRecords?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessonRecords: [{ userId: 55, lessonId: 77, visit: false }], stats: { totalItems: 1 } }) };
      throw new Error(`Unexpected URL ${href}`);
    },
  });
  const result = await service.syncTeacherStudents(database, { id: 9, my_klass_id: "214414" });
  assert.deepEqual(result, { lessons: 1, students: 0, lessonsSynced: 0, transcripts: 0 });
  // No attended students → prune clears any previously linked leftovers.
  assert.deepEqual(calls, [["prune", 9, []]]);
});

test("Moy Klass syncTeacherStudents skips students in a disallowed client status and unlinks any stale link", async () => {
  const calls = [];
  const database = {
    upsertMoyKlassStudent: async (user, meta) => { calls.push(["upsert", user.id, meta.tutorId]); return { id: Number(user.id) + 1000 }; },
    linkTutorStudent: async (tutorId, studentId) => { calls.push(["link", tutorId, studentId]); },
    unlinkTutorStudentByMyKlassId: async (tutorId, myKlassId) => { calls.push(["unlink", tutorId, myKlassId]); },
    pruneTutorStudents: async (tutorId, keepIds) => { calls.push(["prune", tutorId, keepIds]); },
    syncMoyKlassLesson: async () => { calls.push(["lesson"]); return { created: true, transcriptCreated: false }; },
  };
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/auth/getToken")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
      if (href.includes("/lessons?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessons: [{ id: 77, date: "2026-01-10", classId: 12, teacherIds: [214414] }], stats: { totalItems: 1 } }) };
      if (href.includes("/classes?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 12, name: "Математика", courseId: 0 }]) };
      if (href.includes("/courses?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 0, name: "Индивидуальное обучение" }]) };
      if (href.includes("/lessonRecords?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessonRecords: [{ userId: 55, lessonId: 77, visit: true }], stats: { totalItems: 1 } }) };
      // Attended a trial lesson, but trial students must not surface anymore.
      if (href.endsWith("/users/55")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 55, name: "Ученик", clientStateId: 208697 }) };
      throw new Error(`Unexpected URL ${href}`);
    },
  });
  const result = await service.syncTeacherStudents(database, { id: 9, my_klass_id: "214414" });
  assert.deepEqual(result, { lessons: 1, students: 0, lessonsSynced: 0, transcripts: 0 });
  assert.deepEqual(calls, [["unlink", 9, "55"], ["prune", 9, []]]);
});

test("Moy Klass syncTeacherStudents prunes previously linked students who no longer attended", async () => {
  const calls = [];
  const database = {
    upsertMoyKlassStudent: async (user) => ({ id: Number(user.id) + 1000 }),
    linkTutorStudent: async () => {},
    pruneTutorStudents: async (tutorId, keepIds) => { calls.push(["prune", tutorId, keepIds]); },
    syncMoyKlassLesson: async () => ({ created: false, transcriptCreated: false }),
  };
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/auth/getToken")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
      if (href.includes("/lessons?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessons: [{ id: 77, date: "2026-01-10", classId: 12, teacherIds: [214414] }], stats: { totalItems: 1 } }) };
      if (href.includes("/classes?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 12, name: "Математика", courseId: 0 }]) };
      if (href.includes("/courses?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: 0, name: "Индивидуальное обучение" }]) };
      if (href.includes("/lessonRecords?")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ lessonRecords: [{ userId: 55, lessonId: 77, visit: true }], stats: { totalItems: 1 } }) };
      if (href.endsWith("/users/55")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 55, name: "Ученик", clientStateId: 179145 }) };
      throw new Error(`Unexpected URL ${href}`);
    },
  });
  await service.syncTeacherStudents(database, { id: 9, my_klass_id: "214414" });
  assert.deepEqual(calls, [["prune", 9, [1055]]]);
});

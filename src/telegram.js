const TelegramBot = require("node-telegram-bot-api").default;
const { runLessonAnalysis, runProfileAnalysis } = require("./analysis-runner");
const { GENERATION_TYPES, studentVersion } = require("./generator");
const { createMessageHandler } = require("./telegram/message-handler");
const { createCallbackHandler } = require("./telegram/callback-handler");
const { createAdminHandler } = require("./telegram/admin-handler");
const { TelegramSessionStore } = require("./telegram/session-store");
const { AiCallGuard, blockedMessage } = require("./telegram/rate-limiter");
const { escapeHtml, normalizeRichMarkdown, richMarkdownToPlainText } = require("./telegram/text");
const { formatMoscowDate } = require("./time");

const MESSAGE_CHUNK_SIZE = 3900;
const STUDENTS_PAGE_SIZE = 30;

const formatDate = formatMoscowDate;

function listOrNone(items, empty) {
  return Array.isArray(items) && items.length ? items.map((item) => `- ${escapeHtml(item)}`).join("\n") : empty;
}

function studentCardMarkup(student, card, recentLessons = [], upcomingLesson = null) {
  const subject = student.subject && student.subject !== "Не указан" ? student.subject : "предмет не указан";
  const grade = student.grade != null ? `${student.grade} класс` : "класс не указан";
  const status = student.status === "active" ? "активный" : (student.status || "не указан");
  const lastLesson = student.last_lesson_at ? formatDate(student.last_lesson_at) : "не указана";
  const topics = recentLessons.length
    ? recentLessons.map((item) => `- ${formatDate(item.lessonDate)}: ${/^\d+$/.test(String(item.topic || "").trim()) ? "тема не указана" : item.topic || "тема не указана"}`).join("\n")
    : "Занятий из Мой Класс пока не найдено.";

  return [
    `<b>${student.full_name}</b>`,
    `${subject}, ${grade}`,
    `Статус: ${status}`,
    `Дата последнего занятия: ${lastLesson}`,
    `Ближайшее занятие: ${upcomingLesson ? formatDate(upcomingLesson.lessonDate) : "не запланировано"}`,
    "",
    `<b>Уровень:</b> ${card.currentLevel || "не указан"}`,
    `<b>Темп обучения:</b> ${card.learningPace || "не указан"}`,
    `<b>Цель обучения:</b> ${card.learningGoal || "не указана"}`,
    `<b>Особенности:</b> ${card.features || "не указаны"}`,
    "",
    "<b>Изученные темы по расшифровкам</b>",
    listOrNone(card.topics, "Не указаны"),
    "",
    "<b>Сильные стороны</b>",
    listOrNone(card.strengths, "Не указаны"),
    "",
    "<b>Слабые стороны</b>",
    listOrNone(card.weaknesses, "Не указаны"),
    "",
    "<b>Пробелы</b>",
    listOrNone(card.gaps, "Нет подтверждённых пробелов"),
    "",
    "<b>Рекомендации</b>",
    listOrNone(card.recommendations, "Нет"),
    "",
    "<b>План следующего урока</b>",
    card.nextLessonPlan || "Не указан",
    "",
    "<b>Последние темы</b>",
    topics,
  ].join("\n");
}

function studentCardText(student, card, recentLessons = [], upcomingLesson = null) {
  const escapedStudent = {
    ...student,
    full_name: escapeHtml(student.full_name),
    subject: escapeHtml(student.subject),
    status: escapeHtml(student.status),
  };
  const escapedCard = {
    ...card,
    currentLevel: escapeHtml(card.currentLevel),
    learningPace: escapeHtml(card.learningPace),
    learningGoal: escapeHtml(card.learningGoal),
    features: escapeHtml(card.features),
    nextLessonPlan: escapeHtml(card.nextLessonPlan),
  };
  const escapedLessons = recentLessons.map((lesson) => ({ ...lesson, topic: escapeHtml(lesson.topic) }));
  return studentCardMarkup(escapedStudent, escapedCard, escapedLessons, upcomingLesson);
}

function studentButtonLabel(student) {
  const details = [];
  if (student.subject && student.subject !== "Не указан") details.push(student.subject);
  if (student.grade != null) details.push(`${student.grade} класс`);
  return details.length ? `${student.full_name} — ${details.join(", ")}` : student.full_name;
}

const CARD_FIELDS = {
  currentLevel: { label: "Уровень ученика", type: "text" },
  topics: { label: "Изученные темы", type: "list" },
  strengths: { label: "Сильные стороны", type: "list" },
  weaknesses: { label: "Слабые стороны", type: "list" },
  gaps: { label: "Пробелы", type: "list" },
  recommendations: { label: "Рекомендации", type: "list" },
  learningGoal: { label: "Цель обучения", type: "text" },
  learningPace: { label: "Темп обучения", type: "text" },
  features: { label: "Комментарии / особенности", type: "text" },
  nextLessonPlan: { label: "План следующего урока", type: "text" },
};

const PROFILE_DRAFT_FIELDS = CARD_FIELDS;

const DRAFT_FIELDS = {
  understood: { label: "Что получилось", type: "list" },
  difficulties: { label: "Трудности", type: "list" },
  gaps: { label: "Пробелы", type: "list" },
  recommendations: { label: "Рекомендации", type: "list" },
  nextLessonPlan: { label: "План следующего урока", type: "text" },
};

function cardFieldValueText(card, field) {
  const value = card[field];
  if (CARD_FIELDS[field].type === "list") {
    return Array.isArray(value) && value.length ? value.map((item) => `- ${escapeHtml(item)}`).join("\n") : "(пусто)";
  }
  return value ? escapeHtml(value) : "(пусто)";
}

function draftFieldValueText(draft, field) {
  const value = draft.changes?.[field];
  if (DRAFT_FIELDS[field].type === "list") {
    return Array.isArray(value) && value.length ? value.map((item) => `- ${escapeHtml(item)}`).join("\n") : "(пусто)";
  }
  return value ? escapeHtml(value) : "(пусто)";
}

function draftText(draft) {
  const changes = draft.changes || {};
  return [
    "<b>Черновик обновления карточки</b>",
    `Тема: ${escapeHtml(changes.lessonTopic || "не определена")}`,
    "",
    "<b>Что получилось</b>",
    listOrNone(changes.understood, "Не указано"),
    "",
    "<b>Трудности</b>",
    listOrNone(changes.difficulties, "Не указаны"),
    "",
    "<b>Пробелы</b>",
    listOrNone(changes.gaps, "Не выявлены"),
    "",
    "<b>Рекомендации</b>",
    listOrNone(changes.recommendations, "Нет"),
    "",
    "<b>План следующего урока</b>",
    changes.nextLessonPlan ? escapeHtml(changes.nextLessonPlan) : "Не указан",
    "",
    "Карточка обновится только после подтверждения.",
  ].join("\n");
}

function profileDraftFieldValueText(draft, field) {
  const value = draft.changes?.[field];
  if (PROFILE_DRAFT_FIELDS[field].type === "list") {
    if (!Array.isArray(value) || !value.length) return "(пусто)";
    const limit = field === "topics" ? 30 : 3;
    const items = value.slice(0, limit).map((item) => {
      const text = String(item);
      return `- ${escapeHtml(text.length > 100 ? `${text.slice(0, 99)}…` : text)}`;
    });
    if (value.length > limit) items.push(`…ещё ${value.length - limit}`);
    return items.join("\n");
  }
  if (!value) return "(пусто)";
  const limits = { currentLevel: 150, learningGoal: 250, learningPace: 150, features: 250, nextLessonPlan: 300 };
  const text = String(value);
  const limit = limits[field] || 250;
  return escapeHtml(text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
}

function profileDraftText(draft) {
  const fieldBlocks = Object.entries(PROFILE_DRAFT_FIELDS).flatMap(([field, meta]) => [
    `<b>${meta.label}</b>`,
    profileDraftFieldValueText(draft, field),
    "",
  ]);
  const missing = Array.isArray(draft.missingFields) ? draft.missingFields : [];
  const missingText = missing.length
    ? missing.map((field) => PROFILE_DRAFT_FIELDS[field]?.label || field).join(", ")
    : "нет — все поля заполнены";
  return [
    "<b>Черновик карточки по всем урокам</b>",
    `Проанализировано расшифровок: ${draft.sourceTranscriptIds?.length || 0}`,
    "",
    ...fieldBlocks,
    `<b>Не хватило данных:</b> ${escapeHtml(missingText)}`,
    "",
    "Проверьте результат. Карточка изменится только после подтверждения.",
  ].join("\n");
}

const FEEDBACK_REASONS = {
  offtopic: "Не по теме",
  task_error: "Ошибка в задании",
  too_much: "Слишком много",
  too_little: "Слишком мало",
};

function materialsText(materials) {
  if (!materials.length) return "Ничего не найдено. Попробуйте другой запрос.";
  const lines = materials.map((item, index) => {
    const grade = item.category === "ct_ce" ? "ЦТ/ЦЭ" : (item.grade != null ? `${item.grade} класс` : "");
    const meta = [item.subject, grade, item.materialType].filter(Boolean).join(", ");
    const links = item.downloadUrl && item.downloadUrl !== item.url
      ? `Просмотр: ${item.url}\nСкачать: ${item.downloadUrl}`
      : item.url;
    return `${index + 1}. ${item.topic || item.name}\n${meta}\n${links}`;
  });
  return `Найдено материалов: ${materials.length}\n\n${lines.join("\n\n")}`;
}

// Splits long text into Telegram-sized chunks, preferring line boundaries and
// never cutting a surrogate pair in half.
function splitChunks(text, size = MESSAGE_CHUNK_SIZE) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  chunks.push(rest);
  return chunks;
}

async function sendRichMarkdown(bot, chatId, text, options = undefined) {
  const chunks = splitChunks(normalizeRichMarkdown(text));
  const sendChunk = async (chunk, chunkOptions) => {
    if (typeof bot.sendRichMessage !== "function") {
      return bot.sendMessage(chatId, richMarkdownToPlainText(chunk), chunkOptions);
    }
    try {
      return await bot.sendRichMessage(chatId, { markdown: chunk }, chunkOptions);
    } catch (error) {
      console.warn("Telegram rejected Rich Markdown; sending plain text fallback", error.message);
      return bot.sendMessage(chatId, richMarkdownToPlainText(chunk), chunkOptions);
    }
  };
  for (let index = 0; index < chunks.length - 1; index += 1) await sendChunk(chunks[index]);
  return sendChunk(chunks[chunks.length - 1], options);
}

const HELP_TEXT = [
  "Ассистент репетитора EDme.",
  "",
  "Команды:",
  "/start — запуск и авторизация",
  "/menu — главное меню",
  "/students — мои ученики",
  "/refresh — обновить учеников из Мой Класс",
  "/settings — настройки аккаунта",
  "/admin — админ-панель (только для администраторов)",
  "/logout — сменить аккаунт",
  "",
  "Как пользоваться:",
  "1. Выберите ученика в «Мои ученики».",
  "2. В меню ученика: «Создать ДЗ», «Создать тест», «Сген. задачи», «Найти материал» — введите тему и получите результат.",
  "3. Под результатом есть кнопки: заново, проще, сложнее, короче, больше практики, своя правка, а также оценка 👍/👎.",
  "4. Для теста доступны «Версия для ученика» и изменение числа вопросов, для задач — «Решения и ответы».",
  "5. «Расшифровки» — просмотр и ИИ-анализ уроков. Черновик анализа можно отредактировать по кнопкам и только потом подтвердить.",
  "6. «🧠 Собрать карточку по всем урокам» — последовательно проанализировать все расшифровки и получить полный черновик карточки для проверки.",
  "7. «Редакт. карточку» — ручное обновление карточки ученика.",
  "8. Любой свободный вопрос можно просто написать в чат — ассистент ответит.",
].join("\n");

// Main-menu keyboard. The admin entry is shown only to admins (spec 5.2); the
// callback re-checks the flag, so a stale button from a revoked admin can't act.
function menuKeyboard(tutor = null) {
  const rows = [
    [{ text: "Мои ученики", callback_data: "students" }],
    [{ text: "Обновить учеников", callback_data: "refreshStudents" }],
    [{ text: "Помощь", callback_data: "help" }],
    [{ text: "Сменить аккаунт", callback_data: "logout" }],
  ];
  if (tutor?.is_admin) rows.unshift([{ text: "🛠 Админ-панель", callback_data: "adm:menu" }]);
  return { inline_keyboard: rows };
}

function createBot({ token, database, analyzer, moyKlass, generator }) {
  if (!token) return null;

  const bot = new TelegramBot(token, { polling: false });
  const sessions = new TelegramSessionStore(database);
  const aiGuard = new AiCallGuard();
  const adminHandler = createAdminHandler({ bot, database, sessions });

  bot.setMyCommands([
    { command: "start", description: "Запуск и авторизация" },
    { command: "menu", description: "Главное меню" },
    { command: "students", description: "Мои ученики" },
    { command: "refresh", description: "Обновить учеников из Мой Класс" },
    { command: "help", description: "Помощь" },
    { command: "settings", description: "Настройки" },
    { command: "admin", description: "Админ-панель (для администраторов)" },
    { command: "logout", description: "Сменить аккаунт" },
  ]).catch((error) => console.error("Failed to set Telegram commands", error));

  // node-telegram-bot-api emits listeners synchronously and does not await
  // them, so a rejection inside a handler would become an unhandled rejection
  // and kill the process. Every registered handler goes through this guard.
  const safe = (handler) => async (message, match) => {
    try {
      if (message?.chat?.type && message.chat.type !== "private") return;
      await handler(message, match);
    } catch (error) {
      console.error("Telegram command failed", error);
      const chatId = message?.chat?.id;
      if (chatId != null) await bot.sendMessage(chatId, "Не удалось обработать команду. Попробуйте ещё раз.").catch(() => {});
    }
  };

  // `menu` may be called with the tutor already loaded so the admin button
  // reflects the caller's freshest is_admin value.
  const menu = async (chatId, tutor = undefined) => {
    return bot.sendMessage(chatId, "Главное меню", { reply_markup: menuKeyboard(tutor) });
  };

  const sendStudentList = async (tutor, chatId, offset = 0) => {
    const rows = await database.listStudents(tutor.id);
    if (!rows.length) {
      return bot.sendMessage(chatId, "Пока нет учеников. Нажмите «Обновить учеников» или отправьте /refresh.");
    }
    const page = rows.slice(offset, offset + STUDENTS_PAGE_SIZE);
    const keyboard = page.map((student) => [{ text: studentButtonLabel(student), callback_data: `student:${student.id}` }]);
    const remaining = rows.length - offset - STUDENTS_PAGE_SIZE;
    if (remaining > 0) keyboard.push([{ text: `Показать ещё (${remaining})`, callback_data: `studentsPage:${offset + STUDENTS_PAGE_SIZE}` }]);
    return bot.sendMessage(chatId, "Выберите ученика:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  };

  const generationKeyboard = (generation) => {
    const rows = [
      [
        { text: "🔄 Заново", callback_data: `gadj:${generation.id}:regenerate` },
        { text: "Проще", callback_data: `gadj:${generation.id}:easier` },
        { text: "Сложнее", callback_data: `gadj:${generation.id}:harder` },
      ],
      [
        { text: "Короче", callback_data: `gadj:${generation.id}:shorter` },
        { text: "Больше практики", callback_data: `gadj:${generation.id}:more_practice` },
        { text: "✏️ Своя правка", callback_data: `gedit:${generation.id}` },
      ],
      [
        { text: "👍 Подходит", callback_data: `gfb:${generation.id}:up` },
        { text: "👎 Не подходит", callback_data: `gfb:${generation.id}:down` },
      ],
    ];
    if (generation.type === "test") {
      rows.push([
        { text: "Больше вопросов", callback_data: `gadj:${generation.id}:more_questions` },
        { text: "Меньше вопросов", callback_data: `gadj:${generation.id}:fewer_questions` },
      ]);
      rows.push([{ text: "Версия для ученика", callback_data: `gstud:${generation.id}` }]);
    }
    if (generation.type === "tasks") {
      rows.push([{ text: "Решения и ответы", callback_data: `gsol:${generation.id}` }]);
    }
    rows.push([
      { text: "⬅️ К карточке", callback_data: `student:${generation.studentId}` },
      { text: "🏠 Меню", callback_data: "menu" },
    ]);
    return { inline_keyboard: rows };
  };

  const sendChunked = (chatId, text, options = undefined) => sendRichMarkdown(bot, chatId, text, options);

  const sendGeneration = (chatId, generation) => sendChunked(chatId, generation.result, { reply_markup: generationKeyboard(generation) });

  const studentMenuKeyboard = (studentId) => ({
    inline_keyboard: [
      [{ text: "Создать ДЗ", callback_data: `gen:${studentId}:homework` }, { text: "Создать тест", callback_data: `gen:${studentId}:test` }],
      [{ text: "Сген. задачи", callback_data: `gen:${studentId}:tasks` }, { text: "Найти материал", callback_data: `findMaterial:${studentId}` }],
      [{ text: "🧠 Собрать карточку по всем урокам", callback_data: `deepProfile:${studentId}` }],
      [{ text: "Карточка", callback_data: `card:${studentId}` }, { text: "Редакт. карточку", callback_data: `editCard:${studentId}` }],
      [{ text: "Расшифровки", callback_data: `transcripts:${studentId}` }, { text: "Последние темы", callback_data: `lessons:${studentId}` }],
      [{ text: "⬅️ К ученикам", callback_data: "students" }, { text: "🏠 Меню", callback_data: "menu" }],
    ],
  });

  // Single row appended under sub-menus (transcript list, lessons, edit-card
  // field picker) so the tutor can always get back to the student's card or
  // the main menu without hunting for the student again.
  const backToStudentRow = (studentId) => [
    { text: "⬅️ К карточке", callback_data: `student:${studentId}` },
    { text: "🏠 Меню", callback_data: "menu" },
  ];

  // Re-shown after any card-changing action (manual field edit, draft approval)
  // so the tutor lands back on the student instead of hunting for them again.
  const sendStudentCard = async (chatId, student) => {
    const [card, recentLessons, upcomingLesson] = await Promise.all([
      database.getCard(student.id), database.listRecentLessons(student.id), database.getUpcomingLesson(student.id),
    ]);
    return bot.sendMessage(chatId, studentCardText(student, card, recentLessons, upcomingLesson), {
      parse_mode: "HTML",
      reply_markup: studentMenuKeyboard(student.id),
    });
  };

  const sendDraft = (chatId, draft) => bot.sendMessage(chatId, draftText(draft), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "✅ Подтвердить", callback_data: `approve:${draft.id}` }],
      [
        { text: "✏️ Пробелы", callback_data: `editDraft:${draft.id}:gaps` },
        { text: "✏️ Рекомендации", callback_data: `editDraft:${draft.id}:recommendations` },
      ],
      [
        { text: "✏️ Что получилось", callback_data: `editDraft:${draft.id}:understood` },
        { text: "✏️ Трудности", callback_data: `editDraft:${draft.id}:difficulties` },
      ],
      [{ text: "✏️ План урока", callback_data: `editDraft:${draft.id}:nextLessonPlan` }],
    ] },
  });

  const sendProfileDraft = (chatId, draft) => bot.sendMessage(chatId, profileDraftText(draft), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "✅ Подтвердить карточку", callback_data: `approveProfile:${draft.id}` }],
      [
        { text: "✏️ Уровень", callback_data: `editProfileDraft:${draft.id}:currentLevel` },
        { text: "✏️ Темы", callback_data: `editProfileDraft:${draft.id}:topics` },
      ],
      [
        { text: "✏️ Сильные стороны", callback_data: `editProfileDraft:${draft.id}:strengths` },
        { text: "✏️ Слабые стороны", callback_data: `editProfileDraft:${draft.id}:weaknesses` },
      ],
      [
        { text: "✏️ Пробелы", callback_data: `editProfileDraft:${draft.id}:gaps` },
        { text: "✏️ Рекомендации", callback_data: `editProfileDraft:${draft.id}:recommendations` },
      ],
      [
        { text: "✏️ Цель", callback_data: `editProfileDraft:${draft.id}:learningGoal` },
        { text: "✏️ Темп", callback_data: `editProfileDraft:${draft.id}:learningPace` },
      ],
      [{ text: "✏️ Особенности", callback_data: `editProfileDraft:${draft.id}:features` }],
      [{ text: "✏️ План следующего урока", callback_data: `editProfileDraft:${draft.id}:nextLessonPlan` }],
      [{ text: "❌ Отменить", callback_data: `rejectProfile:${draft.id}` }],
      backToStudentRow(draft.studentId),
    ] },
  });

  const handleFreeform = async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (!tutor) return bot.sendMessage(message.chat.id, "Сначала выполните /start и авторизацию.");
    if (!generator?.isConfigured()) return bot.sendMessage(message.chat.id, "ИИ недоступен: настройте ключ ИИ на сервере.");
    try {
      const outcome = await aiGuard.run(message.from.id, async () => {
        await database.logUsageEvent({ eventType: "freeform_question", tutorId: tutor.id });
        await bot.sendMessage(message.chat.id, "Готовлю ответ. Это может занять до минуты.");
        const { result } = await generator.freeform({ question: message.text });
        return result;
      });
      if (outcome.blocked) return await bot.sendMessage(message.chat.id, blockedMessage(outcome.blocked));
      return await sendChunked(message.chat.id, outcome.value);
    } catch (error) {
      console.error("Freeform answer failed", error);
      return bot.sendMessage(message.chat.id, "Не удалось ответить. Попробуйте ещё раз или воспользуйтесь /menu.");
    }
  };

  const beginLogin = async (telegramUserId, chatId) => {
    await sessions.set(telegramUserId, { action: "identity" });
    // request_contact forces Telegram's native "share phone" flow: the phone
    // number comes signed from Telegram itself, so it cannot be typed in for
    // someone else's profile.
    return bot.sendMessage(chatId, "Нажмите кнопку ниже, чтобы поделиться номером телефона, указанным в Мой Класс.", {
      reply_markup: {
        keyboard: [[{ text: "📱 Поделиться номером телефона", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  };

  const logout = async (telegramUserId, chatId) => {
    await sessions.delete(telegramUserId);
    await database.unbindTutorTelegramId(telegramUserId);
    await bot.sendMessage(chatId, "Вы вышли из аккаунта.");
    return beginLogin(telegramUserId, chatId);
  };

  const refreshInFlight = new Set();
  const refreshStudents = async (tutor, chatId) => {
    if (!moyKlass?.isConfigured()) {
      return bot.sendMessage(chatId, "Мой Класс не настроен на сервере.");
    }
    if (!tutor.my_klass_id) {
      return bot.sendMessage(chatId, "Профиль не связан с Мой Класс.");
    }
    if (refreshInFlight.has(tutor.id)) {
      return bot.sendMessage(chatId, "Обновление уже выполняется. Дождитесь сообщения о готовности.");
    }
    refreshInFlight.add(tutor.id);
    try {
      await bot.sendMessage(chatId, "Обновляю учеников из Мой Класс по вашим занятиям…");
      const result = await moyKlass.syncTeacherStudents(database, tutor);
      const rows = await database.listStudents(tutor.id);
      return bot.sendMessage(chatId, `Готово: занятий ${result.lessons}, учеников ${rows.length}, новых расшифровок ${result.transcripts}.`, {
        reply_markup: menuKeyboard(tutor),
      });
    } finally {
      refreshInFlight.delete(tutor.id);
    }
  };

  bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, safe(async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (tutor) return menu(message.chat.id, tutor);
    return beginLogin(message.from.id, message.chat.id);
  }));

  bot.onText(/^\/(?:logout|login|switch)(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    return logout(message.from.id, message.chat.id);
  }));

  bot.onText(/^\/(?:refresh|sync)(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (!tutor) return bot.sendMessage(message.chat.id, "Сначала выполните /start и авторизацию.");
    try {
      return await refreshStudents(tutor, message.chat.id);
    } catch (error) {
      console.error("Teacher students refresh failed", error);
      return bot.sendMessage(message.chat.id, "Не удалось обновить учеников из Мой Класс. Попробуйте позже.");
    }
  }));

  bot.onText(/^\/menu(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (!tutor) return beginLogin(message.from.id, message.chat.id);
    return menu(message.chat.id, tutor);
  }));

  bot.onText(/^\/students(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (!tutor) return bot.sendMessage(message.chat.id, "Сначала выполните /start и авторизацию.");
    return sendStudentList(tutor, message.chat.id);
  }));

  bot.onText(/^\/admin(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (!tutor) return bot.sendMessage(message.chat.id, "Сначала выполните /start и авторизацию.");
    if (!tutor.is_admin) return bot.sendMessage(message.chat.id, "Команда доступна только администраторам.");
    return adminHandler.adminMenu(message.chat.id);
  }));

  bot.onText(/^\/help(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    return bot.sendMessage(message.chat.id, HELP_TEXT);
  }));

  bot.onText(/^\/settings(?:@\w+)?(?:\s|$)/i, safe(async (message) => {
    const tutor = await database.getTutorByTelegramId(message.from.id);
    if (!tutor) return bot.sendMessage(message.chat.id, "Сначала выполните /start и авторизацию.");
    const lines = [
      `Аккаунт: ${tutor.full_name}`,
      tutor.email ? `Email: ${tutor.email}` : null,
      tutor.phone ? `Телефон: ${tutor.phone}` : null,
      tutor.my_klass_id ? `Мой Класс ID: ${tutor.my_klass_id}` : "Профиль не связан с Мой Класс",
    ].filter(Boolean);
    return bot.sendMessage(message.chat.id, lines.join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "Сменить аккаунт", callback_data: "logout" }]] },
    });
  }));

  bot.on("callback_query", createCallbackHandler({
    bot, database, analyzer, generator, sessions, aiGuard, adminHandler, logout, refreshStudents, sendStudentList, sendGeneration, sendChunked, sendDraft, sendProfileDraft, sendStudentCard, menu, backToStudentRow,
    formatDate, studentCardText, cardFieldValueText, draftFieldValueText, profileDraftFieldValueText, materialsText, HELP_TEXT, FEEDBACK_REASONS, CARD_FIELDS, DRAFT_FIELDS, PROFILE_DRAFT_FIELDS, GENERATION_TYPES, studentVersion, runLessonAnalysis, runProfileAnalysis,
  }));

  bot.on("message", createMessageHandler({
    bot, database, generator, sessions, aiGuard, adminHandler, handleFreeform, menu, refreshStudents, sendGeneration, sendDraft, sendProfileDraft, sendStudentCard, CARD_FIELDS, DRAFT_FIELDS, PROFILE_DRAFT_FIELDS, cardFieldValueText, materialsText,
  }));

  return bot;
}

module.exports = { createBot, splitChunks, sendRichMarkdown, menuKeyboard };

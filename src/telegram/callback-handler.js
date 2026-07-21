const { escapeHtml } = require("./text");
const { blockedMessage } = require("./rate-limiter");
const { MIN_TARGET_QUESTION_COUNT, MAX_TARGET_QUESTION_COUNT } = require("../generator");

const TRANSCRIPTS_PAGE_SIZE = 10;
const LESSONS_PAGE_SIZE = 4;

function createCallbackHandler({ bot, database, analyzer, generator, sessions, aiGuard, adminHandler, logout, refreshStudents, sendStudentList, sendGeneration, sendChunked, sendDraft, sendProfileDraft, sendStudentCard, menu, backToStudentRow, editCardKeyboard, formatDate, studentCardText, cardFieldValueText, draftFieldValueText, profileDraftFieldValueText, materialsText, HELP_TEXT, FEEDBACK_REASONS, CARD_FIELDS, DRAFT_FIELDS, PROFILE_DRAFT_FIELDS, GENERATION_TYPES, studentVersion, runLessonAnalysis, runProfileAnalysis }) {
  const AI_UNAVAILABLE_TEXT = "ИИ недоступен: настройте ключ ИИ на сервере.";

  return async (query) => {
    // Answer immediately: Telegram invalidates callback queries after ~15
    // seconds, while AI actions below can run for a minute. Answering late
    // leaves the button spinner hanging and provokes repeated taps.
    bot.answerCallbackQuery(query.id).catch(() => {});
    const chatId = query.message?.chat?.id;
    if (chatId == null) return;
    try {
      // Non-interactive separator buttons (e.g. grade headings in the student
      // list) carry "noop": acknowledge silently and do nothing.
      if (query.data === "noop") return;

      if (query.data === "logout") {
        await logout(query.from.id, chatId);
        return;
      }

      const tutor = await database.getTutorByTelegramId(query.from.id);
      if (!tutor) return bot.sendMessage(chatId, "Сначала выполните /start и авторизацию.");

      // Admin panel owns the "adm:" callback namespace and re-checks is_admin.
      if (adminHandler && typeof query.data === "string" && query.data.startsWith("adm:")) {
        return await adminHandler.handleCallback(query, tutor, chatId);
      }

      if (query.data === "refreshStudents") {
        return await refreshStudents(tutor, chatId);
      }

      if (query.data === "students") {
        return await sendStudentList(tutor, chatId);
      }

      if (query.data === "menu") {
        return await menu(chatId, tutor);
      }

      if (query.data === "help") {
        return await bot.sendMessage(chatId, HELP_TEXT);
      }

      const [action, rawId, extra] = query.data.split(":");
      const id = Number(rawId);
      if (!Number.isInteger(id)) return bot.sendMessage(chatId, "Некорректное действие.");

      if (action === "studentsPage") {
        return await sendStudentList(tutor, chatId, id);
      }

      if (action === "viewTranscript") {
        const transcript = await database.getTranscript(id, tutor.id);
        if (!transcript) return bot.sendMessage(chatId, "Расшифровка не найдена.");
        const text = escapeHtml(transcript.text.length > 3500 ? `${transcript.text.slice(0, 3500)}…` : transcript.text);
        return bot.sendMessage(chatId, `<b>Расшифровка от ${formatDate(transcript.lessonDate)}</b>\n\n${text}`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "Анализировать", callback_data: `analyze:${id}` }],
            [{ text: "⬅️ К расшифровкам", callback_data: `transcripts:${transcript.studentId}` }],
            backToStudentRow(transcript.studentId),
          ] },
        });
      }

      if (action === "analyze") {
        const transcript = await database.getTranscript(id, tutor.id);
        if (!transcript) return bot.sendMessage(chatId, "Расшифровка не найдена.");
        const student = await database.getStudent(transcript.studentId, tutor.id);
        if (!student) return bot.sendMessage(chatId, "Ученик не найден или больше не привязан к вам.");
        const outcome = await aiGuard.run(query.from.id, async () => {
          await bot.sendMessage(chatId, "Анализирую расшифровку урока. Это может занять до минуты.");
          return runLessonAnalysis({ analyzer, database, transcript, student, tutorId: tutor.id });
        });
        if (outcome.blocked) return bot.sendMessage(chatId, blockedMessage(outcome.blocked));
        return sendDraft(chatId, outcome.value);
      }

      if (action === "deepProfile") {
        const student = await database.getStudent(id, tutor.id);
        if (!student) return bot.sendMessage(chatId, "Ученик не найден или больше не привязан к вам.");
        const transcripts = await database.listTranscripts(id, tutor.id);
        if (!transcripts.length) {
          return bot.sendMessage(chatId, "Для этого ученика пока нет расшифровок. Сначала дождитесь их загрузки из МТС Линк.", {
            reply_markup: { inline_keyboard: [backToStudentRow(id)] },
          });
        }
        const card = await database.getCard(id);
        const analyzedIds = new Set((card?.sourceTranscriptIds || []).map(String));
        const newTranscripts = transcripts.filter((transcript) => !analyzedIds.has(String(transcript.id)));
        if (!newTranscripts.length) {
          return bot.sendMessage(chatId, "Карточка уже учитывает все доступные расшифровки. Новых уроков для анализа нет.", {
            reply_markup: { inline_keyboard: [backToStudentRow(id)] },
          });
        }
        const outcome = await aiGuard.run(query.from.id, async () => {
          await bot.sendMessage(chatId, `Анализирую ${newTranscripts.length} новых расшифровок. Уже учтено: ${transcripts.length - newTranscripts.length}.`);
          return runProfileAnalysis({
            analyzer,
            database,
            transcripts: [...newTranscripts].reverse(),
            student,
            card,
            tutorId: tutor.id,
          });
        });
        if (outcome.blocked) return bot.sendMessage(chatId, blockedMessage(outcome.blocked));
        return sendProfileDraft(chatId, outcome.value);
      }

      if (action === "editDraft") {
        const field = extra;
        if (!DRAFT_FIELDS[field]) return bot.sendMessage(chatId, "Неизвестное поле.");
        const draft = await database.getDraft(id, tutor.id);
        if (!draft || draft.status !== "draft") return bot.sendMessage(chatId, "Черновик уже обработан или не найден.");
        await sessions.set(query.from.id, { action: "editDraftField", draftId: id, field });
        const hint = DRAFT_FIELDS[field].type === "list" ? "Отправьте новый список, каждый пункт с новой строки." : "Отправьте новое значение одним сообщением.";
        return bot.sendMessage(chatId, `<b>${DRAFT_FIELDS[field].label}</b>\nТекущее значение:\n${draftFieldValueText(draft, field)}\n\n${hint}`, { parse_mode: "HTML" });
      }

      if (action === "approve") {
        const draft = await database.approveDraft(id, tutor.id);
        await bot.sendMessage(chatId, draft ? "Карточка обновлена. Изменение сохранено в истории." : "Черновик уже обработан или не найден.");
        // Land back on the student's card so the tutor doesn't have to search
        // for them again after approving the analysis draft.
        if (draft) {
          const student = await database.getStudent(draft.studentId, tutor.id);
          if (student) await sendStudentCard(chatId, student);
        }
        return;
      }

      if (action === "editProfileDraft") {
        const field = extra;
        if (!PROFILE_DRAFT_FIELDS[field]) return bot.sendMessage(chatId, "Неизвестное поле.");
        const draft = await database.getProfileDraft(id, tutor.id);
        if (!draft || draft.status !== "draft") return bot.sendMessage(chatId, "Черновик уже обработан или не найден.");
        await sessions.set(query.from.id, { action: "editProfileDraftField", draftId: id, field });
        const hint = PROFILE_DRAFT_FIELDS[field].type === "list" ? "Отправьте новый список, каждый пункт с новой строки." : "Отправьте новое значение одним сообщением.";
        return bot.sendMessage(chatId, `<b>${PROFILE_DRAFT_FIELDS[field].label}</b>\nТекущее значение:\n${profileDraftFieldValueText(draft, field)}\n\n${hint}`, { parse_mode: "HTML" });
      }

      if (action === "approveProfile") {
        const draft = await database.approveProfileDraft(id, tutor.id);
        await bot.sendMessage(chatId, draft ? "Карточка подтверждена и обновлена по всем расшифровкам." : "Черновик уже обработан или не найден.");
        if (draft) {
          const student = await database.getStudent(draft.studentId, tutor.id);
          if (student) await sendStudentCard(chatId, student);
        }
        return;
      }

      if (action === "rejectProfile") {
        const draft = await database.rejectProfileDraft(id, tutor.id);
        await bot.sendMessage(chatId, draft ? "Черновик отменён. Карточка не изменена." : "Черновик уже обработан или не найден.");
        if (draft) {
          const student = await database.getStudent(draft.studentId, tutor.id);
          if (student) await sendStudentCard(chatId, student);
        }
        return;
      }

      if (action === "gadj") {
        const generation = await database.getGeneration(id, tutor.id);
        if (!generation) return bot.sendMessage(chatId, "Генерация не найдена.");
        if (!generator?.isConfigured()) return bot.sendMessage(chatId, AI_UNAVAILABLE_TEXT);
        const student = await database.getStudent(generation.studentId, tutor.id);
        if (!student) return bot.sendMessage(chatId, "Ученик не найден.");
        const card = await database.getCard(generation.studentId);
        const label = GENERATION_TYPES[generation.type]?.label || "материал";
        const outcome = await aiGuard.run(query.from.id, async () => {
          await bot.sendMessage(chatId, `Генерирую новый вариант: ${label}. Тема: ${generation.topic}.`);
          const { result } = await generator.generate({
            type: generation.type, student, card, topic: generation.topic,
            adjustment: extra, previousResult: generation.result,
          });
          const next = await database.createGeneration({
            type: generation.type, studentId: generation.studentId, tutorId: tutor.id,
            topic: generation.topic, inputParams: { adjustment: extra }, result, parentId: generation.id,
          });
          await database.logUsageEvent({ eventType: "generation_adjustment", tutorId: tutor.id, meta: { type: generation.type, adjustment: extra } });
          return next;
        });
        if (outcome.blocked) return bot.sendMessage(chatId, blockedMessage(outcome.blocked));
        return sendGeneration(chatId, outcome.value);
      }

      if (action === "gsol") {
        const generation = await database.getGeneration(id, tutor.id);
        if (!generation) return bot.sendMessage(chatId, "Генерация не найдена.");
        if (!generator?.isConfigured()) return bot.sendMessage(chatId, AI_UNAVAILABLE_TEXT);
        const student = await database.getStudent(generation.studentId, tutor.id);
        if (!student) return bot.sendMessage(chatId, "Ученик не найден.");
        const outcome = await aiGuard.run(query.from.id, async () => {
          await bot.sendMessage(chatId, "Готовлю решения, ответы и подсказки. Это может занять до минуты.");
          const { result } = await generator.solutions({ student, topic: generation.topic, previousResult: generation.result });
          await database.logUsageEvent({ eventType: "generation_solutions", tutorId: tutor.id, meta: { type: generation.type } });
          return result;
        });
        if (outcome.blocked) return bot.sendMessage(chatId, blockedMessage(outcome.blocked));
        return sendChunked(chatId, outcome.value, {
          reply_markup: { inline_keyboard: [backToStudentRow(generation.studentId)] },
        });
      }

      if (action === "gedit") {
        const generation = await database.getGeneration(id, tutor.id);
        if (!generation) return bot.sendMessage(chatId, "Генерация не найдена.");
        if (!generator?.isConfigured()) return bot.sendMessage(chatId, AI_UNAVAILABLE_TEXT);
        await sessions.set(query.from.id, { action: "generationEdit", generationId: id });
        return bot.sendMessage(chatId, "Опишите одним сообщением, что изменить в этом варианте.\nНапример: «замени задачу 2 на задачу про проценты» или «добавь блок теории в начало».");
      }

      if (action === "gcount") {
        const generation = await database.getGeneration(id, tutor.id);
        if (!generation) return bot.sendMessage(chatId, "Генерация не найдена.");
        if (!generator?.isConfigured()) return bot.sendMessage(chatId, AI_UNAVAILABLE_TEXT);
        await sessions.set(query.from.id, { action: "generationQuestionCount", generationId: id });
        return bot.sendMessage(chatId, `Сколько вопросов должно быть в тесте? Укажите число от ${MIN_TARGET_QUESTION_COUNT} до ${MAX_TARGET_QUESTION_COUNT}.`);
      }

      if (action === "gstud") {
        const generation = await database.getGeneration(id, tutor.id);
        if (!generation) return bot.sendMessage(chatId, "Генерация не найдена.");
        return sendChunked(chatId, studentVersion(generation.result), {
          reply_markup: { inline_keyboard: [backToStudentRow(generation.studentId)] },
        });
      }

      if (action === "gfb") {
        if (extra === "down") {
          const rows = Object.entries(FEEDBACK_REASONS).map(([reason, label]) => [{ text: label, callback_data: `gfr:${id}:${reason}` }]);
          rows.push([{ text: "Отмена", callback_data: `gfbCancel:${id}` }]);
          return bot.sendMessage(chatId, "Что именно не подошло?", {
            reply_markup: { inline_keyboard: rows },
          });
        }
        const feedback = await database.createGenerationFeedback({ generationId: id, tutorId: tutor.id, rating: "up" });
        return bot.sendMessage(chatId, feedback ? "Спасибо! Отметил, что материал подходит." : "Генерация не найдена.");
      }

      if (action === "gfbCancel") {
        return bot.sendMessage(chatId, "Хорошо, ничего не отмечаю.");
      }

      if (action === "gfr") {
        if (!FEEDBACK_REASONS[extra]) return bot.sendMessage(chatId, "Неизвестная причина.");
        const feedback = await database.createGenerationFeedback({ generationId: id, tutorId: tutor.id, rating: "down", reason: extra });
        return bot.sendMessage(chatId, feedback
          ? "Спасибо, учтём. Кнопками «Проще», «Сложнее», «Короче», «Своя правка» или «🔄 Заново» можно сразу получить другой вариант."
          : "Генерация не найдена.");
      }

      const student = await database.getStudent(id, tutor.id);
      if (!student) return bot.sendMessage(chatId, "Ученик не найден.");
      if (action === "student") {
        return sendStudentCard(chatId, student);
      }
      if (action === "findMaterial") {
        await sessions.set(query.from.id, { action: "materialSearch", studentId: id });
        return bot.sendMessage(chatId, `Что ищем для ${student.full_name}? Введите тему или ключевые слова.`);
      }
      if (action === "gen") {
        if (!GENERATION_TYPES[extra]) return bot.sendMessage(chatId, "Неизвестный тип генерации.");
        if (!generator?.isConfigured()) return bot.sendMessage(chatId, AI_UNAVAILABLE_TEXT);
        await sessions.set(query.from.id, { action: "generationTopic", studentId: id, type: extra });
        return bot.sendMessage(chatId, `${GENERATION_TYPES[extra].label} для ${student.full_name}.\nВведите тему одним сообщением.`);
      }
      if (action === "card") {
        const [card, recentLessons, upcomingLesson] = await Promise.all([database.getCard(id), database.listRecentLessons(id), database.getUpcomingLesson(id)]);
        return bot.sendMessage(chatId, studentCardText(student, card, recentLessons, upcomingLesson), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [backToStudentRow(id)] },
        });
      }
      if (action === "editCard") {
        return bot.sendMessage(chatId, "Что редактируем?", {
          reply_markup: editCardKeyboard(id),
        });
      }
      if (action === "editField") {
        const field = extra;
        if (!CARD_FIELDS[field]) return bot.sendMessage(chatId, "Неизвестное поле.");
        const card = await database.getCard(id);
        await sessions.set(query.from.id, { action: "editCardField", studentId: id, field });
        const hint = CARD_FIELDS[field].type === "list" ? "Отправьте новый список, каждый пункт с новой строки." : "Отправьте новое значение одним сообщением.";
        return bot.sendMessage(chatId, `<b>${CARD_FIELDS[field].label}</b>\nТекущее значение:\n${cardFieldValueText(card, field)}\n\n${hint}`, { parse_mode: "HTML" });
      }
      if (action === "addTranscript") {
        await sessions.set(query.from.id, { action: "transcript", studentId: id });
        return bot.sendMessage(chatId, "Отправьте краткую расшифровку урока одним сообщением. Дата будет установлена сегодняшней.");
      }
      if (action === "transcripts") {
        const offset = Number(extra) || 0;
        const transcripts = await database.listTranscripts(id, tutor.id, { limit: TRANSCRIPTS_PAGE_SIZE + 1, offset });
        if (!transcripts.length) {
          return bot.sendMessage(chatId, offset ? "Более ранних расшифровок нет." : "Расшифровок пока нет.", {
            reply_markup: { inline_keyboard: [backToStudentRow(id)] },
          });
        }
        const rows = transcripts.slice(0, TRANSCRIPTS_PAGE_SIZE)
          .map((item) => [{ text: `${formatDate(item.lessonDate)}: ${item.status}`, callback_data: `viewTranscript:${item.id}` }]);
        if (transcripts.length > TRANSCRIPTS_PAGE_SIZE) rows.push([{ text: "Показать ещё", callback_data: `transcripts:${id}:${offset + TRANSCRIPTS_PAGE_SIZE}` }]);
        rows.push(backToStudentRow(id));
        return bot.sendMessage(chatId, offset ? "Более ранние расшифровки:" : "Расшифровки:", {
          reply_markup: { inline_keyboard: rows },
        });
      }
      if (action === "lessons") {
        const offset = Number(extra) || 0;
        const lessons = await database.listRecentLessons(id, LESSONS_PAGE_SIZE + 1, offset);
        if (!lessons.length) {
          return bot.sendMessage(chatId, offset ? "Более ранних занятий нет." : "Занятий из Мой Класс пока не найдено. Нажмите «Обновить учеников» в главном меню.", {
            reply_markup: { inline_keyboard: [backToStudentRow(id)] },
          });
        }
        const page = lessons.slice(0, LESSONS_PAGE_SIZE);
        const text = page.map((item) => `${formatDate(item.lessonDate)}: ${/^\d+$/.test(String(item.topic || "").trim()) ? "тема не указана" : escapeHtml(item.topic || "тема не указана")}`).join("\n");
        const hasMore = lessons.length > LESSONS_PAGE_SIZE;
        const rows = [];
        if (hasMore) rows.push([{ text: "Показать раньше", callback_data: `lessons:${id}:${offset + LESSONS_PAGE_SIZE}` }]);
        rows.push(backToStudentRow(id));
        return bot.sendMessage(chatId, `<b>${offset ? "Более ранние темы" : "Последние темы"}</b>\n${text}`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: rows },
        });
      }
    } catch (error) {
      console.error("Telegram callback failed", error);
      return bot.sendMessage(chatId, error.code === "AI_NOT_CONFIGURED" ? AI_UNAVAILABLE_TEXT : "Не удалось обработать действие.").catch(() => {});
    }
  };
}

module.exports = { createCallbackHandler, TRANSCRIPTS_PAGE_SIZE, LESSONS_PAGE_SIZE };

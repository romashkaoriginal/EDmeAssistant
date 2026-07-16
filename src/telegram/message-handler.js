const { blockedMessage } = require("./rate-limiter");

const MIN_TRANSCRIPT_LENGTH = 20;

function createMessageHandler({ bot, database, generator, sessions, aiGuard, adminHandler, handleFreeform, menu, refreshStudents, sendGeneration, sendDraft, sendProfileDraft, sendStudentCard, CARD_FIELDS, DRAFT_FIELDS, PROFILE_DRAFT_FIELDS, cardFieldValueText, materialsText }) {
  const AI_UNAVAILABLE_TEXT = "ИИ недоступен: настройте ключ ИИ на сервере.";

  return async (message) => {
    try {
      // The assistant is personal: ignore chatter in groups/channels the bot
      // was added to (tests and older payloads may omit chat.type).
      if (message.chat?.type && message.chat.type !== "private") return;

      if (message.contact) {
        const session = await sessions.get(message.from.id);
        if (!session || session.action !== "identity") return;
        // Reject a shared vCard for someone else: user_id must match the
        // sender, otherwise anyone could forward a tutor's contact card and
        // claim their profile.
        if (message.contact.user_id && String(message.contact.user_id) !== String(message.from.id)) {
          return bot.sendMessage(message.chat.id, "Поделитесь своим собственным номером телефона, а не чужим контактом.");
        }
        const tutor = await database.getTutorByPhone(message.contact.phone_number);
        if (!tutor) return bot.sendMessage(message.chat.id, "Профиль не найден по этому номеру телефона. Проверьте номер, указанный в Мой Класс, и обратитесь к администратору.");
        const linkedTutor = await database.bindTutorTelegramId(tutor.id, message.from.id);
        if (!linkedTutor) {
          const text = tutor.telegram_id && String(tutor.telegram_id) !== String(message.from.id)
            ? "Этот профиль уже привязан к другому Telegram-аккаунту. Обратитесь к администратору."
            : "Этот Telegram уже привязан к другому профилю. Выполните /logout и попробуйте снова.";
          return bot.sendMessage(message.chat.id, text, { reply_markup: { remove_keyboard: true } });
        }
        await sessions.delete(message.from.id);
        // Bootstrap the seeded admin the first time they log in, in case a Moy
        // Klass sync never touched their row (one phone maps to one account, so
        // this stays scoped to the number that just authenticated).
        if (linkedTutor.phone) await database.ensureBootstrapAdmin(linkedTutor.phone).catch(() => {});
        // Re-read so a freshly granted admin sees the admin button immediately.
        const activeTutor = (await database.getTutorByTelegramId(message.from.id)) || linkedTutor;
        await bot.sendMessage(message.chat.id, `Вы вошли как ${activeTutor.full_name}.`, { reply_markup: { remove_keyboard: true } });
        await menu(message.chat.id, activeTutor);
        try {
          await refreshStudents(linkedTutor, message.chat.id);
        } catch (error) {
          console.error("Teacher students refresh failed", error);
          await bot.sendMessage(message.chat.id, "Вход выполнен, но учеников обновить не удалось. Позже нажмите «Обновить учеников».");
        }
        return;
      }

      if (!message.text || message.text.startsWith("/")) return;
      const session = await sessions.get(message.from.id);
      if (!session) return await handleFreeform(message);

      if (session.expired) {
        return await bot.sendMessage(message.chat.id, "Время ожидания истекло, действие отменено. Откройте /menu и начните заново.");
      }

      if (session.action === "identity") {
        return bot.sendMessage(message.chat.id, "Нажмите кнопку «Поделиться номером телефона» ниже — так система найдёт ваш профиль в Мой Класс.");
      }

      // Admin text-entry sessions (grant access by phone, edit material metadata).
      if (adminHandler && (session.action === "adminGrantPhone" || session.action === "adminEditMaterialField")) {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) {
          await sessions.delete(message.from.id);
          return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        }
        return await adminHandler.handleTextSession(message, session, tutor);
      }

      if (session.action === "transcript") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        if (message.text.trim().length < MIN_TRANSCRIPT_LENGTH) {
          return bot.sendMessage(message.chat.id, "Слишком короткий текст для расшифровки. Отправьте более подробное описание урока одним сообщением.");
        }
        await database.createTranscript({ studentId: session.studentId, tutorId: tutor.id, lessonDate: new Date().toISOString().slice(0, 10), text: message.text });
        await sessions.delete(message.from.id);
        return bot.sendMessage(message.chat.id, "Расшифровка сохранена. Откройте «Расшифровки» у ученика и нажмите на неё для анализа.");
      }

      if (session.action === "editCardField") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        const { field, studentId } = session;
        const value = CARD_FIELDS[field].type === "list"
          ? message.text.split("\n").map((line) => line.trim()).filter(Boolean)
          : message.text.trim();
        await sessions.delete(message.from.id);
        const card = await database.updateCard(studentId, tutor.id, { [field]: value });
        await bot.sendMessage(message.chat.id, `<b>${CARD_FIELDS[field].label}</b> обновлено:\n${cardFieldValueText(card, field)}`, { parse_mode: "HTML" });
        // Land back on the student's card so the tutor doesn't have to search
        // for them again after an edit.
        const student = await database.getStudent(studentId, tutor.id);
        if (student) await sendStudentCard(message.chat.id, student);
        return;
      }

      if (session.action === "editDraftField") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        const { field, draftId } = session;
        const value = DRAFT_FIELDS[field].type === "list"
          ? message.text.split("\n").map((line) => line.trim()).filter(Boolean)
          : message.text.trim();
        await sessions.delete(message.from.id);
        const draft = await database.updateDraft(draftId, tutor.id, { [field]: value });
        if (!draft) return bot.sendMessage(message.chat.id, "Черновик уже обработан или не найден.");
        return sendDraft(message.chat.id, draft);
      }

      if (session.action === "editProfileDraftField") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        const { field, draftId } = session;
        if (!PROFILE_DRAFT_FIELDS[field]) {
          await sessions.delete(message.from.id);
          return bot.sendMessage(message.chat.id, "Неизвестное поле карточки.");
        }
        const value = PROFILE_DRAFT_FIELDS[field].type === "list"
          ? message.text.split("\n").map((line) => line.trim()).filter(Boolean)
          : message.text.trim();
        await sessions.delete(message.from.id);
        const draft = await database.updateProfileDraft(draftId, tutor.id, { [field]: value });
        if (!draft) return bot.sendMessage(message.chat.id, "Черновик уже обработан или не найден.");
        return sendProfileDraft(message.chat.id, draft);
      }

      if (session.action === "generationTopic") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        const student = await database.getStudent(session.studentId, tutor.id);
        if (!student) {
          await sessions.delete(message.from.id);
          return bot.sendMessage(message.chat.id, "Ученик не найден.");
        }
        const topic = message.text.trim();
        try {
          const outcome = await aiGuard.run(message.from.id, async () => {
            // The session survives a blocked attempt so the tutor can resend
            // the topic; it is consumed only once the generation starts.
            await sessions.delete(message.from.id);
            const card = await database.getCard(session.studentId);
            const label = session.type === "homework" ? "домашнее задание" : session.type === "test" ? "тест" : "задачи";
            await bot.sendMessage(message.chat.id, `Генерирую ${label}. Тема: ${topic}. Обычно это занимает меньше минуты.`);
            const { result } = await generator.generate({ type: session.type, student, card, topic });
            const generation = await database.createGeneration({
              type: session.type, studentId: student.id, tutorId: tutor.id, topic, result,
            });
            await database.logUsageEvent({ eventType: "generation", tutorId: tutor.id, meta: { type: session.type } });
            return generation;
          });
          if (outcome.blocked) return await bot.sendMessage(message.chat.id, blockedMessage(outcome.blocked));
          return await sendGeneration(message.chat.id, outcome.value);
        } catch (error) {
          console.error("Generation failed", error);
          return bot.sendMessage(message.chat.id, error.code === "AI_NOT_CONFIGURED"
            ? AI_UNAVAILABLE_TEXT
            : "Не удалось сгенерировать. Попробуйте ещё раз.");
        }
      }

      if (session.action === "generationEdit") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        const generation = await database.getGeneration(session.generationId, tutor.id);
        if (!generation) {
          await sessions.delete(message.from.id);
          return bot.sendMessage(message.chat.id, "Генерация не найдена.");
        }
        const student = await database.getStudent(generation.studentId, tutor.id);
        if (!student) {
          await sessions.delete(message.from.id);
          return bot.sendMessage(message.chat.id, "Ученик не найден.");
        }
        const instruction = message.text.trim();
        try {
          const outcome = await aiGuard.run(message.from.id, async () => {
            await sessions.delete(message.from.id);
            const card = await database.getCard(generation.studentId);
            await bot.sendMessage(message.chat.id, "Вношу правку. Это может занять до минуты.");
            const { result } = await generator.generate({
              type: generation.type, student, card, topic: generation.topic,
              previousResult: generation.result, customInstruction: instruction,
            });
            const next = await database.createGeneration({
              type: generation.type, studentId: generation.studentId, tutorId: tutor.id,
              topic: generation.topic, inputParams: { customInstruction: instruction }, result, parentId: generation.id,
            });
            await database.logUsageEvent({ eventType: "generation_adjustment", tutorId: tutor.id, meta: { type: generation.type, adjustment: "custom" } });
            return next;
          });
          if (outcome.blocked) return await bot.sendMessage(message.chat.id, blockedMessage(outcome.blocked));
          return await sendGeneration(message.chat.id, outcome.value);
        } catch (error) {
          console.error("Generation edit failed", error);
          return bot.sendMessage(message.chat.id, error.code === "AI_NOT_CONFIGURED"
            ? AI_UNAVAILABLE_TEXT
            : "Не удалось внести правку. Попробуйте ещё раз.");
        }
      }

      if (session.action === "materialSearch") {
        const tutor = await database.getTutorByTelegramId(message.from.id);
        if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
        await sessions.delete(message.from.id);
        const student = await database.getStudent(session.studentId, tutor.id);
        if (!student) return bot.sendMessage(message.chat.id, "Ученик не найден.");
        const materials = await database.searchMaterials({ query: message.text.trim(), subject: student.subject !== "Не указан" ? student.subject : null, grade: student.grade });
        await database.logUsageEvent({ eventType: "material_search", tutorId: tutor.id, meta: { query: message.text.trim(), found: materials.length } });
        return bot.sendMessage(message.chat.id, materialsText(materials));
      }
    } catch (error) {
      // Last-resort guard: an unhandled rejection here would otherwise
      // escape processUpdate and take the whole process down.
      console.error("Telegram message handling failed", error);
      await bot.sendMessage(message.chat.id, "Не удалось обработать сообщение. Попробуйте ещё раз или откройте /menu.").catch(() => {});
    }
  };
}

module.exports = { createMessageHandler };

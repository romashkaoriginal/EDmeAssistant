const TelegramBot = require("node-telegram-bot-api").default;

const sessions = new Map();

function studentText(student, card) {
  const gaps = card.gaps.length ? card.gaps.map((item) => `- ${item}`).join("\n") : "Нет подтверждённых пробелов";
  return `<b>${student.full_name}</b>\n${student.subject}, ${student.grade} класс\nУровень: ${card.currentLevel || "не указан"}\n\n<b>Пробелы</b>\n${gaps}`;
}

function createBot({ token, database, analyzer }) {
  if (!token) return null;

  const bot = new TelegramBot(token, { polling: false });
  const menu = (chatId) => bot.sendMessage(chatId, "Главное меню", {
    reply_markup: { inline_keyboard: [[{ text: "Мои ученики", callback_data: "students" }]] },
  });

  bot.onText(/^\/start$/, async (message) => {
    if (await database.getTutorByTelegramId(message.from.id)) return menu(message.chat.id);
    sessions.set(message.from.id, { action: "identity" });
    return bot.sendMessage(message.chat.id, "Введите email или номер телефона, указанный в Мой Класс.");
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const tutor = await database.getTutorByTelegramId(query.from.id);
    try {
      if (!tutor) return bot.sendMessage(chatId, "Сначала выполните /start и авторизацию.");
      if (query.data === "students") {
        const rows = await database.listStudents(tutor.id);
        return bot.sendMessage(chatId, "Выберите ученика:", {
          reply_markup: { inline_keyboard: rows.map((student) => [{ text: `${student.full_name} - ${student.subject}, ${student.grade} класс`, callback_data: `student:${student.id}` }]) },
        });
      }

      const [action, rawId] = query.data.split(":");
      const id = Number(rawId);
      if (!Number.isInteger(id)) return bot.sendMessage(chatId, "Некорректное действие.");

      if (action === "analyze") {
        const transcript = await database.getTranscript(id, tutor.id);
        if (!transcript) return bot.sendMessage(chatId, "Расшифровка не найдена.");
        const student = await database.getStudent(transcript.studentId, tutor.id);
        const analysis = await analyzer.analyze({ transcript, student });
        const draft = await database.saveAnalysis(transcript.id, tutor.id, analysis);
        const gaps = draft.changes.gaps?.map((item) => `- ${item}`).join("\n") || "Не выявлены";
        const recommendations = draft.changes.recommendations?.map((item) => `- ${item}`).join("\n") || "Нет";
        return bot.sendMessage(chatId, `<b>Черновик обновления</b>\nТема: ${draft.changes.lessonTopic}\n\nПробелы:\n${gaps}\n\nРекомендации:\n${recommendations}`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Подтвердить", callback_data: `approve:${draft.id}` }]] },
        });
      }

      if (action === "approve") {
        const draft = await database.approveDraft(id, tutor.id);
        return bot.sendMessage(chatId, draft ? "Карточка обновлена. Изменение сохранено в истории." : "Черновик уже обработан или не найден.");
      }

      const student = await database.getStudent(id, tutor.id);
      if (!student) return bot.sendMessage(chatId, "Ученик не найден.");
      if (action === "student") {
        return bot.sendMessage(chatId, studentText(student, await database.getCard(id)), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "Карточка", callback_data: `card:${id}` }, { text: "Добавить расшифровку", callback_data: `addTranscript:${id}` }],
            [{ text: "Расшифровки", callback_data: `transcripts:${id}` }],
          ] },
        });
      }
      if (action === "card") return bot.sendMessage(chatId, studentText(student, await database.getCard(id)), { parse_mode: "HTML" });
      if (action === "addTranscript") {
        sessions.set(query.from.id, { action: "transcript", studentId: id });
        return bot.sendMessage(chatId, "Отправьте краткую расшифровку урока одним сообщением. Дата будет установлена сегодняшней.");
      }
      if (action === "transcripts") {
        const transcripts = await database.listTranscripts(id, tutor.id);
        if (!transcripts.length) return bot.sendMessage(chatId, "Расшифровок пока нет.");
        return bot.sendMessage(chatId, "Расшифровки:", {
          reply_markup: { inline_keyboard: transcripts.map((item) => [{ text: `${item.lessonDate}: ${item.status}`, callback_data: `analyze:${item.id}` }]) },
        });
      }
    } catch (error) {
      console.error(error);
      return bot.sendMessage(chatId, error.code === "AI_NOT_CONFIGURED" ? "ИИ-анализ недоступен: настройте OPENAI_API_KEY на сервере." : "Не удалось обработать действие.");
    } finally {
      bot.answerCallbackQuery(query.id).catch(() => {});
    }
  });

  bot.on("message", async (message) => {
    if (!message.text || message.text.startsWith("/")) return;
    const session = sessions.get(message.from.id);
    if (!session) return;

    if (session.action === "identity") {
      const tutor = await database.getTutorByIdentity(message.text);
      if (!tutor) return bot.sendMessage(message.chat.id, "Профиль не найден. Проверьте email или номер телефона в Мой Класс и обратитесь к администратору.");
      const linkedTutor = await database.bindTutorTelegramId(tutor.id, message.from.id);
      if (!linkedTutor) return bot.sendMessage(message.chat.id, "Этот Telegram уже привязан к другому профилю. Обратитесь к администратору.");
      sessions.delete(message.from.id);
      return menu(message.chat.id);
    }

    if (session.action === "transcript") {
      const tutor = await database.getTutorByTelegramId(message.from.id);
      if (!tutor) return bot.sendMessage(message.chat.id, "Авторизация не найдена. Выполните /start.");
      await database.createTranscript({ studentId: session.studentId, tutorId: tutor.id, lessonDate: new Date().toISOString().slice(0, 10), text: message.text });
      sessions.delete(message.from.id);
      return bot.sendMessage(message.chat.id, "Расшифровка сохранена. Откройте «Расшифровки» у ученика и нажмите на неё для анализа.");
    }
  });

  return bot;
}

module.exports = { createBot };

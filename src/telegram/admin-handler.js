const { escapeHtml } = require("./text");

// Admin panel (spec section 20). Every screen is gated on tutor.is_admin by the
// caller and again here, so a stale button from a demoted admin cannot act.
const PAGE_SIZE = 20;
const STALE_DAYS = 14;

const MATERIAL_FIELDS = {
  name: { label: "Название" },
  subject: { label: "Предмет" },
  grade: { label: "Класс", numeric: true },
  topic: { label: "Тема" },
  materialType: { label: "Тип материала" },
  url: { label: "Ссылка" },
};

function formatDateTime(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function formatDate(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

// "adm" + screen keeps the admin namespace separate from tutor callbacks.
const cb = (...parts) => ["adm", ...parts].join(":");

// One consistent footer: back to the admin menu and out to the main menu.
const adminFooter = () => [
  { text: "⬅️ Админ-панель", callback_data: cb("menu") },
  { text: "🏠 Меню", callback_data: "menu" },
];

// Adds a "показать ещё" row when a full page came back (we fetch PAGE_SIZE, so a
// full page means there may be more). `screen` is the callback screen to page.
function withPaging(rows, items, screen, offset) {
  if (items.length >= PAGE_SIZE) rows.push([{ text: "Показать ещё", callback_data: cb(screen, String(offset + PAGE_SIZE)) }]);
  rows.push(adminFooter());
  return rows;
}

function createAdminHandler({ bot, database, sessions }) {
  const adminMenu = (chatId) => bot.sendMessage(chatId, "🛠 <b>Админ-панель</b>\nВыберите раздел:", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "👤 Репетиторы", callback_data: cb("tutors") }],
      [{ text: "🎓 Ученики", callback_data: cb("students") }],
      [{ text: "🗂 Устаревшие карточки", callback_data: cb("stale") }],
      [{ text: "⚠️ Ошибки интеграции", callback_data: cb("errors") }],
      [{ text: "📄 Логи генераций", callback_data: cb("gens") }],
      [{ text: "📚 Материалы", callback_data: cb("materials") }],
      [{ text: "➕ Выдать доступ по номеру", callback_data: cb("grant") }],
      [{ text: "🏠 Меню", callback_data: "menu" }],
    ] },
  });

  const sendTutors = async (chatId, offset = 0) => {
    const tutors = await database.listTutors({ limit: PAGE_SIZE, offset });
    if (!tutors.length) {
      return bot.sendMessage(chatId, offset ? "Больше репетиторов нет." : "Репетиторов пока нет.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    }
    const rows = tutors.map((tutor) => {
      const marks = [tutor.isAdmin ? "🛠" : null, tutor.isActive ? null : "🚫", tutor.telegramId ? "📱" : null].filter(Boolean).join(" ");
      const label = `${tutor.fullName}${marks ? ` ${marks}` : ""}`;
      return [{ text: label.slice(0, 60), callback_data: cb("tutor", String(tutor.id)) }];
    });
    return bot.sendMessage(chatId, "Репетиторы (🛠 админ · 🚫 отключён · 📱 привязан TG):", {
      reply_markup: { inline_keyboard: withPaging(rows, tutors, "tutors", offset) },
    });
  };

  const sendTutorCard = async (chatId, tutorId) => {
    const row = await database.getTutorForAdmin(tutorId);
    if (!row) return bot.sendMessage(chatId, "Репетитор не найден.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    const lines = [
      `<b>${escapeHtml(row.fullName)}</b>`,
      `Телефон: ${escapeHtml(row.phone || "не указан")}`,
      `Email: ${escapeHtml(row.email || "не указан")}`,
      `Мой Класс ID: ${escapeHtml(row.myKlassId || "не связан")}`,
      `Учеников: ${row.studentCount}`,
      `Telegram: ${row.telegramId ? "привязан" : "не привязан"}`,
      `Статус: ${row.isActive ? "активен" : "отключён"}`,
      `Админ: ${row.isAdmin ? "да" : "нет"}`,
    ];
    return bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: row.isAdmin ? "Снять админа" : "Сделать админом", callback_data: cb("setAdmin", String(row.id), row.isAdmin ? "0" : "1") }],
        [{ text: row.isActive ? "Отключить доступ" : "Включить доступ", callback_data: cb("setActive", String(row.id), row.isActive ? "0" : "1") }],
        [{ text: "⬅️ К репетиторам", callback_data: cb("tutors") }],
        adminFooter(),
      ] },
    });
  };

  const sendStudents = async (chatId, offset = 0) => {
    const students = await database.listAllStudents({ limit: PAGE_SIZE, offset });
    if (!students.length) {
      return bot.sendMessage(chatId, offset ? "Больше учеников нет." : "Учеников пока нет.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    }
    const rows = students.map((student) => {
      const grade = student.grade != null ? `${student.grade} кл.` : "";
      const label = [student.fullName, [student.subject, grade].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
      return [{ text: label.slice(0, 60), callback_data: cb("student", String(student.id)) }];
    });
    return bot.sendMessage(chatId, "Ученики:", {
      reply_markup: { inline_keyboard: withPaging(rows, students, "students", offset) },
    });
  };

  const sendStudentCard = async (chatId, studentId) => {
    const student = await database.getStudentForAdmin(studentId);
    if (!student) return bot.sendMessage(chatId, "Ученик не найден.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    const card = await database.getCard(studentId);
    const listOrNone = (items) => Array.isArray(items) && items.length ? items.map((item) => `- ${escapeHtml(item)}`).join("\n") : "—";
    const lines = [
      `<b>${escapeHtml(student.fullName)}</b>`,
      `${escapeHtml(student.subject || "предмет не указан")}, ${student.grade != null ? `${student.grade} класс` : "класс не указан"}`,
      `Статус: ${escapeHtml(student.status || "—")}`,
      `Последнее занятие: ${formatDate(student.lastLessonAt)}`,
      "",
      `<b>Уровень:</b> ${escapeHtml(card?.currentLevel || "не указан")}`,
      `<b>Обновлена:</b> ${formatDateTime(card?.updatedAt)}`,
      "",
      "<b>Сильные стороны</b>", listOrNone(card?.strengths),
      "",
      "<b>Слабые стороны</b>", listOrNone(card?.weaknesses),
      "",
      "<b>Пробелы</b>", listOrNone(card?.gaps),
      "",
      "<b>Рекомендации</b>", listOrNone(card?.recommendations),
    ];
    return bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "⬅️ К ученикам", callback_data: cb("students") }], adminFooter()] },
    });
  };

  const sendStaleCards = async (chatId, offset = 0) => {
    const cards = await database.listStaleCards(STALE_DAYS, { limit: PAGE_SIZE, offset });
    if (!cards.length) {
      return bot.sendMessage(chatId, offset ? "Больше нет." : `Все карточки обновлялись за последние ${STALE_DAYS} дней.`, { reply_markup: { inline_keyboard: [adminFooter()] } });
    }
    const rows = cards.map((card) => {
      const label = `${card.fullName} — ${formatDate(card.cardUpdatedAt)}`;
      return [{ text: label.slice(0, 60), callback_data: cb("student", String(card.id)) }];
    });
    return bot.sendMessage(chatId, `Карточки без обновлений более ${STALE_DAYS} дней (дата — последнее обновление):`, {
      reply_markup: { inline_keyboard: withPaging(rows, cards, "stale", offset) },
    });
  };

  const sendErrors = async (chatId, offset = 0) => {
    const errors = await database.listIntegrationErrors({ limit: PAGE_SIZE, offset });
    if (!errors.length) {
      return bot.sendMessage(chatId, offset ? "Больше ошибок нет." : "Ошибок интеграции нет.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    }
    const text = errors.map((error) => {
      const reason = error.status === "unmapped" ? "не сопоставлено с уроком" : (error.errorMessage || "ошибка обработки");
      return `• ${formatDateTime(error.updatedAt)} — транскрипт ${escapeHtml(String(error.transcriptId))}\n  ${escapeHtml(error.status)}: ${escapeHtml(reason)}`;
    }).join("\n");
    const rows = [];
    if (errors.length >= PAGE_SIZE) rows.push([{ text: "Показать ещё", callback_data: cb("errors", String(offset + PAGE_SIZE)) }]);
    rows.push(adminFooter());
    return bot.sendMessage(chatId, `<b>Ошибки интеграции МТС Линк</b>\n${text}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  };

  const sendGenerations = async (chatId, offset = 0) => {
    const generations = await database.listGenerationsForAdmin({ limit: PAGE_SIZE, offset });
    if (!generations.length) {
      return bot.sendMessage(chatId, offset ? "Больше записей нет." : "Генераций пока нет.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    }
    const typeLabels = { homework: "ДЗ", test: "Тест", tasks: "Задачи" };
    const text = generations.map((generation) => {
      const type = typeLabels[generation.type] || generation.type;
      const topic = generation.topic ? ` · ${generation.topic}` : "";
      return `• ${formatDateTime(generation.createdAt)} · ${escapeHtml(type)} · ${escapeHtml(generation.tutorName)} → ${escapeHtml(generation.studentName)}${escapeHtml(topic)} · ${escapeHtml(generation.status)}`;
    }).join("\n");
    const rows = [];
    if (generations.length >= PAGE_SIZE) rows.push([{ text: "Показать ещё", callback_data: cb("gens", String(offset + PAGE_SIZE)) }]);
    rows.push(adminFooter());
    return bot.sendMessage(chatId, `<b>Логи генераций</b>\n${text}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  };

  const sendMaterials = async (chatId, offset = 0) => {
    const materials = await database.listMaterialsForAdmin({ limit: PAGE_SIZE, offset });
    if (!materials.length) {
      return bot.sendMessage(chatId, offset ? "Больше материалов нет." : "Материалов пока нет. Синхронизируйте базу МТС Линк.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    }
    const rows = materials.map((material) => {
      const grade = material.category === "ct_ce" ? "ЦТ/ЦЭ" : (material.grade != null ? `${material.grade} кл.` : "");
      const label = [material.name || material.topic, [material.subject, grade].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
      return [{ text: label.slice(0, 60), callback_data: cb("material", String(material.id)) }];
    });
    return bot.sendMessage(chatId, "Материалы (нажмите, чтобы отредактировать метаданные):", {
      reply_markup: { inline_keyboard: withPaging(rows, materials, "materials", offset) },
    });
  };

  const sendMaterialCard = async (chatId, materialId) => {
    const material = await database.getMaterial(materialId);
    if (!material) return bot.sendMessage(chatId, "Материал не найден.", { reply_markup: { inline_keyboard: [adminFooter()] } });
    const lines = [
      `<b>${escapeHtml(material.name || "(без названия)")}</b>`,
      `Предмет: ${escapeHtml(material.subject || "—")}`,
      `Класс: ${material.grade != null ? material.grade : (material.category === "ct_ce" ? "ЦТ/ЦЭ" : "—")}`,
      `Тема: ${escapeHtml(material.topic || "—")}`,
      `Тип: ${escapeHtml(material.materialType || "—")}`,
      `Ссылка: ${escapeHtml(material.url || "—")}`,
    ];
    const editRows = Object.entries(MATERIAL_FIELDS).map(([field, meta]) => [{ text: `✏️ ${meta.label}`, callback_data: cb("matEdit", String(material.id), field) }]);
    return bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [...editRows, [{ text: "⬅️ К материалам", callback_data: cb("materials") }], adminFooter()] },
    });
  };

  // Handles every "adm:*" callback. Returns true if it consumed the event so the
  // main callback handler can stop. `tutor` is already loaded and verified.
  const handleCallback = async (query, tutor, chatId) => {
    const parts = query.data.split(":");
    if (parts[0] !== "adm") return false;
    if (!tutor?.is_admin) {
      await bot.sendMessage(chatId, "Доступ к админ-панели закрыт.");
      return true;
    }
    const [, screen, arg, arg2] = parts;
    const offset = Number(arg) || 0;
    switch (screen) {
      case "menu": await adminMenu(chatId); return true;
      case "tutors": await sendTutors(chatId, offset); return true;
      case "tutor": await sendTutorCard(chatId, Number(arg)); return true;
      case "students": await sendStudents(chatId, offset); return true;
      case "student": await sendStudentCard(chatId, Number(arg)); return true;
      case "stale": await sendStaleCards(chatId, offset); return true;
      case "errors": await sendErrors(chatId, offset); return true;
      case "gens": await sendGenerations(chatId, offset); return true;
      case "materials": await sendMaterials(chatId, offset); return true;
      case "material": await sendMaterialCard(chatId, Number(arg)); return true;
      case "grant":
        await sessions.set(query.from.id, { action: "adminGrantPhone" });
        await bot.sendMessage(chatId, "Отправьте номер телефона репетитора (как в Мой Класс), которому выдать доступ администратора. Можно с +, пробелами или скобками.");
        return true;
      case "setAdmin": {
        const row = await database.getTutorForAdmin(Number(arg));
        if (!row) { await bot.sendMessage(chatId, "Репетитор не найден."); return true; }
        if (!row.phone) { await bot.sendMessage(chatId, "У репетитора нет номера телефона — флаг выдаётся по номеру. Сначала свяжите профиль с Мой Класс."); return true; }
        // Guard against a self-demotion that would leave nobody able to manage
        // access, and reuse setAdminByPhone so the code path stays single.
        if (arg2 === "0" && Number(row.id) === Number(tutor.id)) { await bot.sendMessage(chatId, "Нельзя снять админ-доступ с самого себя."); return true; }
        // A stale card (double tap, or opened before someone else changed the
        // flag) must not silently re-apply the same value.
        if (Boolean(row.isAdmin) === (arg2 === "1")) {
          await bot.sendMessage(chatId, row.isAdmin ? `${row.fullName} уже администратор.` : `${row.fullName} и так не администратор.`);
          await sendTutorCard(chatId, Number(arg));
          return true;
        }
        await database.setTutorAdminByPhone(row.phone, arg2 === "1");
        await bot.sendMessage(chatId, arg2 === "1" ? `${row.fullName} теперь администратор.` : `${row.fullName} больше не администратор.`);
        await sendTutorCard(chatId, Number(arg));
        return true;
      }
      case "setActive": {
        const updated = await database.setTutorActive(Number(arg), arg2 === "1");
        if (!updated) { await bot.sendMessage(chatId, "Репетитор не найден."); return true; }
        await bot.sendMessage(chatId, arg2 === "1" ? `Доступ ${updated.fullName} включён.` : `Доступ ${updated.fullName} отключён.`);
        await sendTutorCard(chatId, Number(arg));
        return true;
      }
      case "matEdit": {
        const field = arg2;
        if (!MATERIAL_FIELDS[field]) { await bot.sendMessage(chatId, "Неизвестное поле."); return true; }
        const material = await database.getMaterial(Number(arg));
        if (!material) { await bot.sendMessage(chatId, "Материал не найден."); return true; }
        await sessions.set(query.from.id, { action: "adminEditMaterialField", materialId: Number(arg), field });
        const hint = MATERIAL_FIELDS[field].numeric ? "Отправьте число (или «-», чтобы очистить)." : "Отправьте новое значение (или «-», чтобы очистить).";
        await bot.sendMessage(chatId, `<b>${MATERIAL_FIELDS[field].label}</b>\nТекущее: ${escapeHtml(String(material[field] ?? "—"))}\n\n${hint}`, { parse_mode: "HTML" });
        return true;
      }
      default:
        await bot.sendMessage(chatId, "Неизвестное действие админ-панели.");
        return true;
    }
  };

  // Handles the two admin text-entry sessions. Returns true if consumed.
  const handleTextSession = async (message, session, tutor) => {
    if (session.action === "adminGrantPhone") {
      await sessions.delete(message.from.id);
      if (!tutor?.is_admin) return bot.sendMessage(message.chat.id, "Доступ к админ-панели закрыт."), true;
      const digits = String(message.text || "").replace(/\D/g, "");
      if (!digits) return bot.sendMessage(message.chat.id, "Не разобрал номер. Откройте админ-панель и попробуйте снова."), true;
      const found = await database.getTutorForAdminByPhone(digits);
      if (!found) {
        await bot.sendMessage(message.chat.id, "Репетитор с таким номером не найден в базе. Проверьте номер (как в Мой Класс) — доступ выдаётся по существующему профилю.");
        return true;
      }
      // Show the tutor's card so the admin confirms with a button instead of
      // granting blind on a typed phone number; the card's own button already
      // reads "Снять админа" when the tutor already has the flag, so a repeat
      // submission of the same number can't silently re-grant it.
      if (found.isAdmin) {
        await bot.sendMessage(message.chat.id, `${found.fullName} уже администратор.`);
      }
      await sendTutorCard(message.chat.id, found.id);
      return true;
    }
    if (session.action === "adminEditMaterialField") {
      await sessions.delete(message.from.id);
      if (!tutor?.is_admin) return bot.sendMessage(message.chat.id, "Доступ к админ-панели закрыт."), true;
      const { materialId, field } = session;
      if (!MATERIAL_FIELDS[field]) return bot.sendMessage(message.chat.id, "Неизвестное поле."), true;
      const raw = message.text.trim();
      let value = raw === "-" ? "" : raw;
      if (MATERIAL_FIELDS[field].numeric && value !== "") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) return bot.sendMessage(message.chat.id, "Класс должен быть целым числом. Попробуйте снова из карточки материала."), true;
        value = parsed;
      }
      const material = await database.updateMaterialMetadata(materialId, { [field]: value });
      if (!material) return bot.sendMessage(message.chat.id, "Материал не найден."), true;
      await bot.sendMessage(message.chat.id, `<b>${MATERIAL_FIELDS[field].label}</b> обновлено.`, { parse_mode: "HTML" });
      await sendMaterialCard(message.chat.id, materialId);
      return true;
    }
    return false;
  };

  return { adminMenu, handleCallback, handleTextSession };
}

module.exports = { createAdminHandler, PAGE_SIZE, STALE_DAYS, MATERIAL_FIELDS };

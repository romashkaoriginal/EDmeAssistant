const MOSCOW_TIME_ZONE = "Europe/Moscow";
const DAY_MS = 86_400_000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDateParts(value) {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function toMoscowDateString(value = new Date()) {
  const parts = getDateParts(value);
  if (!parts) return String(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysMoscowDateString(days, value = new Date()) {
  const date = toDate(value);
  if (!date) return String(value);
  return toMoscowDateString(new Date(date.getTime() + days * DAY_MS));
}

function formatMoscowDate(value) {
  const date = toDate(value);
  if (!date) return String(value);
  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
  });
}

function formatMoscowDateTime(value) {
  const date = toDate(value);
  if (!date) return String(value);
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
  });
}

function toMoscowIsoString(value = new Date()) {
  const date = toDate(value);
  if (!date) return String(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}+03:00`;
}

module.exports = {
  MOSCOW_TIME_ZONE,
  addDaysMoscowDateString,
  formatMoscowDate,
  formatMoscowDateTime,
  toMoscowDateString,
  toMoscowIsoString,
};

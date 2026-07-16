const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;

// In-memory guards for LLM calls: a sliding-window rate limit per user plus a
// busy flag that blocks concurrent generations (double-tapped buttons).
// In-memory is enough while the bot runs as a single process.
class AiCallGuard {
  constructor({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.calls = new Map();
    this.busy = new Set();
  }

  isAllowed(userId) {
    const key = String(userId);
    const cutoff = this.now() - this.windowMs;
    const recent = (this.calls.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length) this.calls.set(key, recent); else this.calls.delete(key);
    return recent.length < this.limit;
  }

  record(userId) {
    const key = String(userId);
    const cutoff = this.now() - this.windowMs;
    const recent = (this.calls.get(key) || []).filter((timestamp) => timestamp > cutoff);
    recent.push(this.now());
    this.calls.set(key, recent);
  }

  isBusy(userId) {
    return this.busy.has(String(userId));
  }

  // Runs `task` with the busy flag held; returns null without calling `task`
  // when the user already has a generation in flight or hit the rate limit.
  async run(userId, task) {
    const key = String(userId);
    if (this.busy.has(key)) return { blocked: "busy" };
    if (!this.isAllowed(key)) return { blocked: "rate_limit" };
    this.busy.add(key);
    this.record(key);
    try {
      return { value: await task() };
    } finally {
      this.busy.delete(key);
    }
  }
}

function blockedMessage(blocked) {
  return blocked === "busy"
    ? "Предыдущий запрос к ИИ ещё выполняется. Дождитесь результата."
    : "Слишком много запросов подряд. Подождите минуту и попробуйте снова.";
}

module.exports = { AiCallGuard, blockedMessage, DEFAULT_LIMIT, DEFAULT_WINDOW_MS };

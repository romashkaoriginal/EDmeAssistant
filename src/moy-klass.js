const https = require("node:https");

const API_URL = "https://api.moyklass.com/v1/company";

// Moy Klass clientStatuses dictionary IDs (company-specific, confirmed via API):
// 179145 "Клиент", 186173 "Временно прекратил заниматься".
// Students in any other status (new lead, trial not attended, cancelled, etc.)
// are noise for a tutor's active student list.
const ALLOWED_CLIENT_STATE_IDS = new Set([179145, 186173]);

function isAllowedClientState(user) {
  return ALLOWED_CLIENT_STATE_IDS.has(Number(user?.clientStateId));
}

function listFromResponse(body, path = "") {
  if (Array.isArray(body)) return body;
  const collection = String(path || "").replace(/^\//, "");
  if (collection && Array.isArray(body?.[collection])) return body[collection];
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.users)) return body.users;
  if (Array.isArray(body?.joins)) return body.joins;
  if (Array.isArray(body?.managers)) return body.managers;
  if (Array.isArray(body?.classes)) return body.classes;
  if (Array.isArray(body?.courses)) return body.courses;
  if (Array.isArray(body?.lessons)) return body.lessons;
  if (Array.isArray(body?.lessonRecords)) return body.lessonRecords;
  return [];
}

function gradeFromName(name) {
  const match = String(name || "").match(/\b(1[01]|[1-9])\s*(?:класс|кл\.?)/i);
  return match ? Number(match[1]) : null;
}

function gradeFromUser(user) {
  const attributes = Array.isArray(user?.attributes) ? user.attributes : [];
  const gradeAttr = attributes.find((item) =>
    item.attributeAlias === "klass_uchenika"
    || /класс\s+ученика/i.test(String(item.attributeName || ""))
  );
  if (gradeAttr?.value == null || String(gradeAttr.value).trim() === "") return null;
  const match = String(gradeAttr.value).match(/\b(1[01]|[1-9])\b/);
  return match ? Number(match[1]) : null;
}

function isGenericCourseName(name) {
  return !name || /^индивидуальное обучение$/i.test(name) || /^тестовое$/i.test(name);
}

function looksLikeSubjectName(name) {
  if (!name) return false;
  const compact = String(name).replace(/\s+/g, "");
  if (/^\d{1,2}[А-ЯA-Z]{1,4}\d*$/i.test(compact)) return false;
  if (/^\d{1,2}\s*класс/i.test(name)) return false;
  return true;
}

function resolveSubject(group, course) {
  const className = String(group?.name || "").trim();
  const courseName = String(course?.name || "").trim();
  if (!isGenericCourseName(courseName) && !looksLikeSubjectName(className)) return courseName;
  if (looksLikeSubjectName(className)) return className;
  if (!isGenericCourseName(courseName)) return courseName;
  return className || "Не указан";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15_000);
  return Math.min(1000 * (2 ** attempt), 15_000);
}

function requestViaIpv4(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body || "";
    const request = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      family: 4,
      timeout: 20_000,
      headers: { ...options.headers, ...(body && { "Content-Length": Buffer.byteLength(body) }) },
    }, (response) => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { payload += chunk; });
      response.on("end", () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: { get: (name) => response.headers[String(name).toLowerCase()] },
        json: async () => JSON.parse(payload || "null"),
      }));
    });
    request.once("timeout", () => request.destroy(new Error("Moy Klass IPv4 request timed out")));
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

class MoyKlassService {
  constructor({ apiKey, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  isConfigured() { return Boolean(this.apiKey); }

  async request(url, options) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
        const payload = await response.text();
        if (response.ok) {
          return {
            ok: true,
            status: response.status,
            headers: response.headers,
            json: async () => JSON.parse(payload || "null"),
          };
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Moy Klass request failed with HTTP ${response.status}`);
          const delayMs = retryDelayMs(response, attempt);
          console.warn(`Moy Klass HTTP ${response.status} on ${url}; retry ${attempt + 1}/5 in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }
        return {
          ok: false,
          status: response.status,
          headers: response.headers,
          json: async () => JSON.parse(payload || "null"),
        };
      } catch (error) {
        lastError = error;
        await sleep(500 * (attempt + 1));
      }
    }
    try {
      const fallback = await requestViaIpv4(url, options);
      if (fallback.ok || (fallback.status !== 429 && fallback.status < 500)) return fallback;
      throw lastError || new Error(`Moy Klass request failed with HTTP ${fallback.status}`);
    } catch (ipv4Error) {
      if (lastError) ipv4Error.cause = lastError;
      throw ipv4Error;
    }
  }

  async getAccessToken() {
    if (!this.apiKey) {
      const error = new Error("MOYKLASS_API_KEY is not configured");
      error.code = "MOYKLASS_NOT_CONFIGURED";
      throw error;
    }
    const response = await this.request(`${API_URL}/auth/getToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: this.apiKey }),
    });
    if (!response.ok) throw new Error(`Moy Klass authentication failed with HTTP ${response.status}`);
    const body = await response.json();
    if (!body.accessToken) throw new Error("Moy Klass did not return an access token");
    return body.accessToken;
  }

  async getAll(path, token, params = {}) {
    const items = [];
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({ ...params, limit: String(limit), offset: String(offset) });
      const response = await this.request(`${API_URL}${path}?${query}`, { headers: { "x-access-token": token } });
      if (!response.ok) throw new Error(`Moy Klass ${path} failed with HTTP ${response.status}`);
      const page = listFromResponse(await response.json(), path);
      // Some Moy Klass list endpoints ignore limit/offset and dump the full collection.
      if (page.length !== limit) {
        items.push(...page);
        console.log(`Moy Klass ${path}: ${items.length} records`);
        return items;
      }
      if (offset > 0 && page[0] && items[0] && String(page[0].id) === String(items[0].id)) {
        console.log(`Moy Klass ${path}: ${items.length} records`);
        return items;
      }
      items.push(...page);
      console.log(`Moy Klass ${path}: ${items.length}+...`);
    }
  }

  async sync(database) {
    const token = await this.getAccessToken();
    // Sequential on purpose: Moy Klass rate-limits parallel list calls (HTTP 429).
    const managers = await this.getAll("/managers", token);
    const users = await this.getAll("/users", token);
    const joins = await this.getAll("/joins", token);
    const classes = await this.getAll("/classes", token);
    const courses = await this.getAll("/courses", token);
    const tutors = new Map();
    for (const manager of managers) tutors.set(String(manager.id), await database.upsertMoyKlassTutor(manager));
    const usersById = new Map(users.map((item) => [String(item.id), item]));
    const classesById = new Map(classes.map((item) => [String(item.id), item]));
    const coursesById = new Map(courses.map((item) => [String(item.id), item]));
    let linkedStudents = 0;
    const linkedPairs = new Set();
    for (const join of joins) {
      const tutor = tutors.get(String(join.managerId));
      const user = usersById.get(String(join.userId));
      if (!tutor || !user) continue;
      const pairKey = `${tutor.id}:${user.id}`;
      if (linkedPairs.has(pairKey)) continue;
      linkedPairs.add(pairKey);
      const group = classesById.get(String(join.classId));
      const course = coursesById.get(String(group?.courseId));
      const subject = course?.name || group?.name || "Не указан";
      const grade = gradeFromName(group?.name);
      const student = await database.upsertMoyKlassStudent(user, { subject, grade, tutorId: tutor.id });
      await database.linkTutorStudent(tutor.id, student.id, { subject, grade });
      linkedStudents += 1;
    }
    return { tutors: tutors.size, students: users.length, tutorStudentLinks: linkedStudents };
  }

  async getUser(userId, token) {
    const response = await this.request(`${API_URL}/users/${userId}`, { headers: { "x-access-token": token } });
    if (!response.ok) return null;
    return response.json();
  }

  async getLessonRecords(lessonId, token) {
    const items = [];
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({ lessonId: String(lessonId), limit: String(limit), offset: String(offset) });
      const response = await this.request(`${API_URL}/lessonRecords?${query}`, { headers: { "x-access-token": token } });
      if (!response.ok) throw new Error(`Moy Klass /lessonRecords failed with HTTP ${response.status}`);
      const page = listFromResponse(await response.json(), "/lessonRecords");
      items.push(...page);
      if (page.length < limit) return items;
      await sleep(50);
    }
  }

  async syncTeacherStudents(database, tutor, { lookBackDays = 180, lookAheadDays = 60 } = {}) {
    if (!tutor?.my_klass_id) return { lessons: 0, students: 0, lessonsSynced: 0, transcripts: 0 };
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - lookBackDays * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + lookAheadDays * 86_400_000).toISOString().slice(0, 10);
    // Sequential on purpose: Moy Klass rate-limits parallel list calls (HTTP 429).
    // The date window keeps login-time sync bounded for long-running tutors and
    // pulls upcoming lessons so the card can show the next one.
    const lessons = await this.getAll("/lessons", token, { teacherId: String(tutor.my_klass_id), "date[0]": from, "date[1]": to });
    const classes = await this.getAll("/classes", token);
    const courses = await this.getAll("/courses", token);
    const classesById = new Map(classes.map((item) => [String(item.id), item]));
    const coursesById = new Map(courses.map((item) => [String(item.id), item]));
    const metaByUserId = new Map();
    const lessonsByUserId = new Map();

    for (const lesson of lessons) {
      const group = classesById.get(String(lesson.classId));
      const course = coursesById.get(String(group?.courseId ?? lesson.courseId));
      const subject = resolveSubject(group, course);
      const classGrade = gradeFromName(group?.name);
      const records = await this.getLessonRecords(lesson.id, token);
      for (const record of records) {
        // Only count a lesson for a student if they actually attended it.
        // A record with visit=false is a booking that never happened (lesson
        // not yet held, or a no-show) and should not surface the student or
        // pollute their lesson history.
        if (!record.userId || record.visit !== true) continue;
        const key = String(record.userId);
        if (!metaByUserId.has(key)) metaByUserId.set(key, { subject, classGrade, group });
        if (!lessonsByUserId.has(key)) lessonsByUserId.set(key, []);
        lessonsByUserId.get(key).push(lesson);
      }
      await sleep(40);
    }

    let linked = 0;
    let lessonsSynced = 0;
    let transcriptsSynced = 0;
    const keepStudentIds = [];
    for (const [userId, meta] of metaByUserId) {
      const user = await this.getUser(userId, token);
      // Drop leads, trial no-shows, and cancelled/inactive clients: only
      // students in an active-ish status belong in the tutor's list. This
      // also retroactively removes a link created by an earlier sync, before
      // the status filter existed, or from a status change since then.
      if (!user || !isAllowedClientState(user)) {
        await database.unlinkTutorStudentByMyKlassId(tutor.id, userId);
        continue;
      }
      const grade = gradeFromUser(user) ?? meta.classGrade;
      const student = await database.upsertMoyKlassStudent(user, {
        subject: meta.subject,
        grade,
        tutorId: tutor.id,
      });
      await database.linkTutorStudent(tutor.id, student.id, { subject: meta.subject, grade });
      keepStudentIds.push(student.id);
      linked += 1;
      for (const lesson of lessonsByUserId.get(userId) || []) {
        const result = await database.syncMoyKlassLesson({
          myKlassLessonId: String(lesson.id),
          tutorId: tutor.id,
          studentId: student.id,
          lessonDate: lesson.date,
          topic: lesson.topic || null,
          description: lesson.description || null,
          payload: lesson,
        });
        if (result?.created) lessonsSynced += 1;
        if (result?.transcriptCreated) transcriptsSynced += 1;
      }
      await sleep(20);
    }
    // Students who fell out of the attended window (or changed status when no
    // longer visited) are never seen in the loop above — prune them explicitly.
    if (typeof database.pruneTutorStudents === "function") {
      await database.pruneTutorStudents(tutor.id, keepStudentIds);
    }
    return { lessons: lessons.length, students: linked, lessonsSynced, transcripts: transcriptsSynced };
  }
}

module.exports = { MoyKlassService, gradeFromName, gradeFromUser, resolveSubject, isAllowedClientState, ALLOWED_CLIENT_STATE_IDS };

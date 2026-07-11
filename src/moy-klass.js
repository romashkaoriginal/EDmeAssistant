const https = require("node:https");

const API_URL = "https://api.moyklass.com/v1/company";

function listFromResponse(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function gradeFromName(name) {
  const match = String(name || "").match(/\b(1[01]|[1-9])\s*(?:класс|кл\.?)/i);
  return match ? Number(match[1]) : null;
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
        if (response.ok || response.status < 500) return response;
        lastError = new Error(`Moy Klass request failed with HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    try {
      return await requestViaIpv4(url, options);
    } catch (ipv4Error) {
      ipv4Error.cause = lastError;
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
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({ ...params, limit: String(limit), offset: String(offset) });
      const response = await this.request(`${API_URL}${path}?${query}`, { headers: { "x-access-token": token } });
      if (!response.ok) throw new Error(`Moy Klass ${path} failed with HTTP ${response.status}`);
      const page = listFromResponse(await response.json());
      items.push(...page);
      if (page.length < limit) return items;
    }
  }

  async sync(database) {
    const token = await this.getAccessToken();
    const [managers, users, joins, classes, courses] = await Promise.all([
      this.getAll("/managers", token), this.getAll("/users", token), this.getAll("/joins", token),
      this.getAll("/classes", token), this.getAll("/courses", token),
    ]);
    const tutors = new Map();
    for (const manager of managers) tutors.set(String(manager.id), await database.upsertMoyKlassTutor(manager));
    const classesById = new Map(classes.map((item) => [String(item.id), item]));
    const coursesById = new Map(courses.map((item) => [String(item.id), item]));
    let linkedStudents = 0;
    for (const join of joins) {
      const tutor = tutors.get(String(join.managerId));
      const user = users.find((item) => String(item.id) === String(join.userId));
      if (!tutor || !user) continue;
      const group = classesById.get(String(join.classId));
      const course = coursesById.get(String(group?.courseId));
      const student = await database.upsertMoyKlassStudent(user, {
        subject: course?.name || group?.name || "Не указан",
        grade: gradeFromName(group?.name),
        tutorId: tutor.id,
      });
      await database.linkTutorStudent(tutor.id, student.id);
      linkedStudents += 1;
    }
    return { tutors: tutors.size, students: users.length, tutorStudentLinks: linkedStudents };
  }
}

module.exports = { MoyKlassService, gradeFromName };

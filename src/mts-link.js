const crypto = require("node:crypto");

const KNOWLEDGE_BASE_FOLDER_NAME = "База Знаний";
const CT_CE_FOLDER_NAME = "ЦТ/ЦЭ";
const FILE_EXTENSION_LABELS = {
  pdf: "документ", ppt: "презентация", pptx: "презентация",
  doc: "документ", docx: "документ", xls: "таблица", xlsx: "таблица",
};

function gradeFromFolderName(name) {
  const match = String(name || "").match(/^(\d{1,2})\s*кл/i);
  return match ? Number(match[1]) : null;
}

function materialTypeFromName(name) {
  const extension = String(name || "").split(".").pop()?.toLowerCase();
  return FILE_EXTENSION_LABELS[extension] || "файл";
}

function topicFromFileName(name) {
  const withoutExtension = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  const withoutLeadingOrdinal = withoutExtension.replace(/^\d+_/, "");
  return withoutLeadingOrdinal.trim() || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MtsLinkService {
  constructor({ database, apiToken, webhookSecret, fetchImpl = fetch, throttleMs = 500 }) {
    this.database = database;
    this.apiToken = apiToken;
    this.webhookSecret = webhookSecret;
    this.fetch = fetchImpl;
    this.throttleMs = throttleMs;
  }

  isConfigured() {
    return Boolean(this.apiToken && this.webhookSecret);
  }

  async listFiles(parentId) {
    if (!this.apiToken) {
      const error = new Error("MTS_LINK_API_TOKEN is not configured");
      error.code = "MTS_LINK_NOT_CONFIGURED";
      throw error;
    }
    const query = parentId ? `?parent=${encodeURIComponent(parentId)}` : "";
    const response = await this.fetch(`https://userapi.mts-link.ru/v3/fileSystem/files${query}`, {
      headers: { "x-auth-token": this.apiToken, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) throw new Error(`MTS Link fileSystem/files request failed with HTTP ${response.status}`);
    return response.json();
  }

  async collectMaterials(folderId, { category, grade, subject }) {
    const entries = await this.listFiles(folderId);
    await sleep(this.throttleMs);
    const materials = [];
    for (const entry of entries) {
      if (entry.type === "folder") {
        materials.push(...await this.collectMaterials(entry.id, { category, grade, subject: subject || entry.name }));
      } else {
        materials.push({
          mtsFileId: String(entry.id),
          name: entry.name,
          category,
          grade,
          subject: subject || "Не указан",
          topic: topicFromFileName(entry.name),
          materialType: materialTypeFromName(entry.name),
          url: entry.downloadUrl || entry.url,
        });
      }
    }
    return materials;
  }

  async syncMaterials(database = this.database) {
    const roots = await this.listFiles(null);
    const knowledgeBase = roots.find((item) => item.type === "folder" && item.name === KNOWLEDGE_BASE_FOLDER_NAME);
    if (!knowledgeBase) throw new Error(`MTS Link folder "${KNOWLEDGE_BASE_FOLDER_NAME}" not found`);

    const sections = await this.listFiles(knowledgeBase.id);
    await sleep(this.throttleMs);
    const materials = [];
    for (const section of sections) {
      if (section.type !== "folder") continue;
      if (section.name === CT_CE_FOLDER_NAME) {
        for (const subjectFolder of (await this.listFiles(section.id)).filter((item) => item.type === "folder")) {
          materials.push(...await this.collectMaterials(subjectFolder.id, { category: "ct_ce", grade: null, subject: subjectFolder.name }));
          await sleep(this.throttleMs);
        }
      } else {
        const grade = gradeFromFolderName(section.name);
        for (const subjectFolder of (await this.listFiles(section.id)).filter((item) => item.type === "folder")) {
          materials.push(...await this.collectMaterials(subjectFolder.id, { category: "grade", grade, subject: subjectFolder.name }));
          await sleep(this.throttleMs);
        }
      }
    }

    let synced = 0;
    for (const material of materials) {
      await database.upsertMaterial(material);
      synced += 1;
    }
    return { materials: synced };
  }

  verifyWebhook(request) {
    if (!this.webhookSecret || !request.rawBody) return false;
    const header = request.get("x-webhook-signature") || "";
    const signature = header.replace(/^sha256=/i, "");
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(request.rawBody).digest("hex");
    if (!/^[0-9a-f]{64}$/i.test(signature) || signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  }

  async fetchTranscript(transcriptId) {
    if (!this.apiToken) {
      const error = new Error("MTS_LINK_API_TOKEN is not configured");
      error.code = "MTS_LINK_NOT_CONFIGURED";
      throw error;
    }
    const response = await this.fetch(`https://userapi.mts-link.ru/v3/transcript/${encodeURIComponent(transcriptId)}`, {
      headers: { "x-auth-token": this.apiToken, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) throw new Error(`MTS Link transcript request failed with HTTP ${response.status}`);
    const body = await response.json();
    return body.data;
  }

  static toLocalTranscript(data) {
    const summary = data.summary?.status === "completed" ? data.summary.text?.trim() : "";
    const dialogue = (data.items || [])
      .map((item) => `${item.participant || "Участник"}: ${item.text || ""}`.trim())
      .filter(Boolean)
      .join("\n");
    const text = (summary || dialogue).slice(0, 20000);
    if (!text) throw new Error("MTS Link returned an empty transcript");
    return { lessonDate: (data.eventSessionEndsAt || new Date().toISOString()).slice(0, 10), text };
  }

  async processTranscriptReady(transcriptId) {
    const webhook = await this.database.getMtsWebhook(transcriptId);
    if (!webhook || webhook.status === "synced") return webhook;
    const session = await this.database.getMtsSession(webhook.eventSessionId);
    if (!session) return this.database.updateMtsWebhook(transcriptId, { status: "unmapped", errorMessage: "No student mapping for eventSessionId" });

    try {
      const externalTranscript = await this.fetchTranscript(transcriptId);
      const local = await this.database.createTranscript({
        studentId: session.studentId,
        tutorId: session.tutorId,
        ...MtsLinkService.toLocalTranscript(externalTranscript),
      });
      return this.database.updateMtsWebhook(transcriptId, { status: "synced", localTranscriptId: local.id, errorMessage: null });
    } catch (error) {
      return this.database.updateMtsWebhook(transcriptId, { status: "failed", errorMessage: error.message });
    }
  }
}

module.exports = { MtsLinkService, gradeFromFolderName, materialTypeFromName, topicFromFileName };

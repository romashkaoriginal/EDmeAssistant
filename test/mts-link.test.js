const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MtsLinkService, gradeFromFolderName, materialTypeFromName, topicFromFileName } = require("../src/mts-link");

test("MTS Link prefers completed summary over a full dialogue", () => {
  const transcript = MtsLinkService.toLocalTranscript({
    eventSessionEndsAt: "2026-07-11T12:00:00+03:00",
    summary: { status: "completed", text: "Ученик понял дискриминант." },
    items: [{ participant: "Иван", text: "Полная реплика" }],
  });
  assert.equal(transcript.lessonDate, "2026-07-11");
  assert.equal(transcript.text, "Ученик понял дискриминант.");
});

test("MTS Link webhook validates the HMAC signature of the original payload", () => {
  const secret = "test-webhook-secret";
  const rawBody = Buffer.from('{"event":"transcript.ready"}');
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const service = new MtsLinkService({ database: {}, webhookSecret: secret });
  const request = { rawBody, get: (name) => name === "x-webhook-signature" ? `sha256=${signature}` : undefined };

  assert.equal(service.verifyWebhook(request), true);
  assert.equal(service.verifyWebhook({ ...request, get: () => "sha256=bad" }), false);
});

test("gradeFromFolderName parses the leading grade number", () => {
  assert.equal(gradeFromFolderName("8 класс"), 8);
  assert.equal(gradeFromFolderName("11 класс"), 11);
  assert.equal(gradeFromFolderName("ЦТ/ЦЭ"), null);
});

test("materialTypeFromName maps known extensions", () => {
  assert.equal(materialTypeFromName("Урок.pdf"), "документ");
  assert.equal(materialTypeFromName("Слайды.pptx"), "презентация");
  assert.equal(materialTypeFromName("Данные.xlsx"), "таблица");
  assert.equal(materialTypeFromName("Архив.zip"), "файл");
});

test("topicFromFileName strips extension and leading ordinal", () => {
  assert.equal(topicFromFileName("3_Формулы корней квадратного уравнения(2 урок).pdf"), "Формулы корней квадратного уравнения(2 урок)");
  assert.equal(topicFromFileName("8 кл Алгебра на 6 вариантов_Арефьева, Пирютко.pdf"), "8 кл Алгебра на 6 вариантов_Арефьева, Пирютко");
  assert.equal(topicFromFileName(".pdf"), null);
});

test("syncMaterials walks Класс -> Предмет and ЦТ/ЦЭ -> Предмет trees and upserts files", async () => {
  const upserts = [];
  const database = { upsertMaterial: async (material) => { upserts.push(material); } };
  const filesByParent = {
    null: [{ id: "root-kb", name: "База Знаний", type: "folder" }],
    "root-kb": [
      { id: "grade-8", name: "8 класс", type: "folder" },
      { id: "ct-ce", name: "ЦТ/ЦЭ", type: "folder" },
    ],
    "grade-8": [{ id: "math-8", name: "Математика", type: "folder" }],
    "math-8": [{ id: 42, name: "1_Квадратные уравнения.pdf", type: "file", downloadUrl: "https://files/42.pdf" }],
    "ct-ce": [{ id: "math-ce", name: "Математика", type: "folder" }],
    "math-ce": [{ id: 99, name: "Тренировочный тест.pdf", type: "file", url: "https://files/99.pdf" }],
  };
  const service = new MtsLinkService({
    apiToken: "token", webhookSecret: "secret", throttleMs: 0,
    fetchImpl: async (url) => {
      const parent = new URL(url).searchParams.get("parent");
      return { ok: true, status: 200, json: async () => filesByParent[parent || "null"] };
    },
  });

  const result = await service.syncMaterials(database);
  assert.deepEqual(result, { materials: 2 });
  assert.deepEqual(upserts, [
    { mtsFileId: "42", name: "1_Квадратные уравнения.pdf", category: "grade", grade: 8, subject: "Математика", topic: "Квадратные уравнения", materialType: "документ", url: "https://files/42.pdf" },
    { mtsFileId: "99", name: "Тренировочный тест.pdf", category: "ct_ce", grade: null, subject: "Математика", topic: "Тренировочный тест", materialType: "документ", url: "https://files/99.pdf" },
  ]);
});

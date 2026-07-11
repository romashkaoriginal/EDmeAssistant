const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MtsLinkService } = require("../src/mts-link");

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

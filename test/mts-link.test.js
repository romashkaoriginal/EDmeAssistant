const test = require("node:test");
const assert = require("node:assert/strict");
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

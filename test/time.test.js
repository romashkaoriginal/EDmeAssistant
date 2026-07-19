const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatMoscowDate,
  toMoscowDateString,
  toMoscowIsoString,
} = require("../src/time");

test("Moscow date helpers convert UTC evening to the next Moscow day", () => {
  const value = new Date("2026-07-10T22:30:00Z");

  assert.equal(toMoscowDateString(value), "2026-07-11");
  assert.equal(formatMoscowDate(value), "11.07.2026");
  assert.equal(toMoscowIsoString(value), "2026-07-11T01:30:00+03:00");
});

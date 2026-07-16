const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = ["src", "db", "test"];
const MOJIBAKE = /(?:\u0420|\u0421)[\u0080-\u00bf\u0400-\u040f]|\u0432\u0402/;

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(fullPath) : [fullPath];
  });
}

test("source files do not contain UTF-8/Windows-1251 mojibake", () => {
  const files = ROOTS.flatMap((root) => filesIn(path.join(__dirname, "..", root)));
  const invalidFiles = files.filter((file) => MOJIBAKE.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(invalidFiles, []);
});

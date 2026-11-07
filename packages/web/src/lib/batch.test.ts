import assert from "node:assert/strict";
import { test } from "node:test";
import { csvRows, itemsOf } from "./batch";

test("csv rows become column: value inputs, quotes and CRLF included", () => {
  assert.deepEqual(csvRows('name,review\r\nAna,"good, fast"\r\n\r\nBo,"said ""meh"""\n'), ["name: Ana\nreview: good, fast", 'name: Bo\nreview: said "meh"']);
  assert.deepEqual(csvRows(""), []);
  assert.deepEqual(csvRows("only,header"), []);
});

test("items per file, line and row", () => {
  const files = [{ name: "a.txt", text: "one\n\ntwo" }];
  assert.deepEqual(itemsOf("file", files, ""), ["--- a.txt ---\none\n\ntwo"]);
  assert.deepEqual(itemsOf("file", files, " extra "), ["--- a.txt ---\none\n\ntwo", "extra"]);
  assert.deepEqual(itemsOf("line", files, "three"), ["one", "two", "three"]);
  assert.deepEqual(itemsOf("row", [], "q\nx\ny"), ["q: x", "q: y"]);
});

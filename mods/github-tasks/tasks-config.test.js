import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskSource, serializeTaskSource, tasksConfigPath, makeTasksConfig } from "./tasks-config.js";

test("local and github are read from tasks.json", () => {
  assert.equal(parseTaskSource('{"taskSource":"local"}'), "local");
  assert.equal(parseTaskSource('{"taskSource":"github"}'), "github");
  assert.equal(parseTaskSource('{\n  "taskSource": "local",\n  "other": 1\n}\n'), "local");
});

test("anything else counts as github", () => {
  for (const text of [null, undefined, "", "   ", "{", "not json", "[]", "null", "7", '"local"', "{}",
    '{"taskSource":"Local"}', '{"taskSource":"jira"}', '{"taskSource":null}', '{"taskSource":["local"]}']) {
    assert.equal(parseTaskSource(text), "github", JSON.stringify(text));
  }
});

test("the file says exactly the source", () => {
  assert.equal(serializeTaskSource("local"), '{"taskSource":"local"}');
  assert.equal(serializeTaskSource("github"), '{"taskSource":"github"}');
  assert.equal(serializeTaskSource("jira"), '{"taskSource":"github"}');
  assert.equal(parseTaskSource(serializeTaskSource("local")), "local");
});

test("tasks.json is in the main checkout's .herdr/tasks folder", () => {
  assert.equal(tasksConfigPath("/code/app"), "/code/app/.herdr/tasks/tasks.json");
  assert.equal(tasksConfigPath("/code/app/"), "/code/app/.herdr/tasks/tasks.json");
});

function disk(files = {}) {
  const fs = new Map(Object.entries(files)), calls = [];
  return {
    fs, calls,
    io: {
      read: async (p) => { if (p.includes("boom")) throw new Error("unreadable"); return fs.get(p) ?? null; },
      write: async (p, text) => { calls.push(["write", p]); fs.set(p, text); },
      mkdir: async (d) => { calls.push(["mkdir", d]); },
    },
  };
}

test("the adapter reads the source, github when the file is missing or unreadable", async () => {
  const d = disk({ "/a/.herdr/tasks/tasks.json": '{"taskSource":"local"}' });
  const config = makeTasksConfig(d.io);
  assert.equal(await config.read("/a"), "local");
  assert.equal(await config.read("/b"), "github");
  assert.equal(await makeTasksConfig(d.io).read("/boom"), "github");
});

test("the adapter writes the file, making its folder first", async () => {
  const d = disk();
  const config = makeTasksConfig(d.io);
  await config.write("/a", "local");
  assert.deepEqual(d.calls, [["mkdir", "/a/.herdr/tasks"], ["write", "/a/.herdr/tasks/tasks.json"]]);
  assert.equal(d.fs.get("/a/.herdr/tasks/tasks.json"), '{"taskSource":"local"}');
  await config.write("/a", "github");
  assert.equal(await config.read("/a"), "github");
});

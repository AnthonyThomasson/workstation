// Which source a repo's tasks come from: .herdr/tasks/tasks.json in its main checkout, {"taskSource":"local"|"github"}.
// Pure; the file operations come in as `io` (local-tasks-env.js passes Herdr's). Tasks never runs git on this file:
// it is only read and written, and shows up as a change for the person to commit.
//   io.read(path) -> text | null    io.write(path, text)    io.mkdir(dir)

export const SOURCES = ["local", "github"];

// The file's text as a source. A missing or unreadable file, invalid JSON or any other value is github.
export function parseTaskSource(text) {
  try {
    const source = JSON.parse(String(text ?? ""))?.taskSource;
    return SOURCES.includes(source) ? source : "github";
  } catch { return "github"; }
}

export const serializeTaskSource = (source) => JSON.stringify({ taskSource: source === "local" ? "local" : "github" });

const trimmed = (root) => String(root).replace(/\/+$/, "");
export const tasksConfigDir = (mainRoot) => `${trimmed(mainRoot)}/.herdr/tasks`;
export const tasksConfigPath = (mainRoot) => `${tasksConfigDir(mainRoot)}/tasks.json`;

// read(root) -> "local" | "github", never rejects. write(root, source) makes the folder if it is not there.
export function makeTasksConfig(io) {
  return {
    read: async (mainRoot) => {
      try { return parseTaskSource(await io.read(tasksConfigPath(mainRoot))); } catch { return "github"; }
    },
    write: async (mainRoot, source) => {
      await io.mkdir(tasksConfigDir(mainRoot));
      await io.write(tasksConfigPath(mainRoot), serializeTaskSource(source));
    },
  };
}

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const port = 47653;
const cwd = resolve(process.argv[2] || process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const paths = {
  directory: join(cwd, ".pi", "pi-fallback.json"),
  global: join(agentDir, "extensions", "pi-fallback.json"),
};

function normalize(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => {
      const slash = value.indexOf("/");
      if (
        slash <= 0 ||
        slash === value.length - 1 ||
        /[\r\n\t ]/.test(value) ||
        seen.has(value)
      )
        return false;
      seen.add(value);
      return true;
    })
    .slice(0, 50);
}

function read(scope) {
  const file = paths[scope];
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return normalize(value?.fallbacks);
  } catch {
    return [];
  }
}

function write(scope, fallbacks) {
  const file = paths[scope];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ version: 1, fallbacks: normalize(fallbacks) }, null, 2)}\n`,
    "utf8",
  );
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi fallback settings</title>
<style>
  :root { color-scheme: dark; font: 16px system-ui, sans-serif; background: #101318; color: #e8edf2; }
  body { max-width: 760px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 1.5rem; margin-bottom: .35rem; }
  p, small { color: #9ba8b5; }
  .tabs { display: flex; gap: 8px; margin: 24px 0 14px; }
  button { border: 1px solid #526170; border-radius: 6px; background: #1b222b; color: inherit; padding: 9px 13px; cursor: pointer; }
  button.active { border-color: #78b7ff; background: #243b55; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  textarea { box-sizing: border-box; width: 100%; min-height: 240px; resize: vertical; border: 1px solid #526170; border-radius: 6px; background: #0b0e12; color: inherit; padding: 12px; font: 14px ui-monospace, monospace; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
  #status { color: #8bd49c; }
  code { color: #b9d6ff; }
</style>
</head>
<body>
<h1>Pi ordered fallback settings</h1>
<p>One model reference per line. Pi tries them from top to bottom. The interactive <code>/fallback</code> command is the model picker.</p>
<div class="tabs">
  <button data-scope="session">Session</button>
  <button data-scope="directory">Current dir</button>
  <button data-scope="global">Global</button>
</div>
<p id="scope-help"></p>
<textarea id="fallbacks" spellcheck="false"></textarea>
<div class="row"><button id="save">Save</button><span id="status"></span></div>
<script>
const state = { directory: undefined, global: undefined };
let scope = "directory";
const textarea = document.querySelector("#fallbacks");
const save = document.querySelector("#save");
const help = document.querySelector("#scope-help");
const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("[data-scope]")];
function render() {
  buttons.forEach((button) => button.classList.toggle("active", button.dataset.scope === scope));
  const session = scope === "session";
  textarea.disabled = session;
  save.disabled = session;
  textarea.value = session ? "Use /fallback inside Pi to edit current-session settings." : (state[scope] || []).join("\\n");
  help.textContent = session ? "Session settings live in the open Pi session and cannot be changed from this standalone page." : (scope === "directory" ? "Current directory: ${cwd.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}" : "Global settings apply wherever no narrower scope overrides them.");
}
async function load() {
  const response = await fetch("/api/config");
  const data = await response.json();
  state.directory = data.directory;
  state.global = data.global;
  render();
}
buttons.forEach((button) => button.addEventListener("click", () => { scope = button.dataset.scope; render(); }));
save.addEventListener("click", async () => {
  const fallbacks = textarea.value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
  const response = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, fallbacks }) });
  status.textContent = response.ok ? "Saved." : await response.text();
  if (response.ok) state[scope] = fallbacks;
});
load().catch((error) => { status.textContent = error.message; });
</script>
</body>
</html>`;

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/")
    return send(res, 200, "text/html; charset=utf-8", page);
  if (req.method === "GET" && req.url === "/api/config") {
    return send(
      res,
      200,
      "application/json",
      JSON.stringify({
        cwd,
        directory: read("directory"),
        global: read("global"),
      }),
    );
  }
  if (req.method === "POST" && req.url === "/api/config") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000)
        return send(res, 413, "text/plain", "Request too large");
    }
    try {
      const value = JSON.parse(body);
      if (value.scope !== "directory" && value.scope !== "global")
        return send(
          res,
          400,
          "text/plain",
          "Only directory and global settings are editable here",
        );
      write(value.scope, value.fallbacks);
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    } catch (error) {
      return send(
        res,
        400,
        "text/plain",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  send(res, 404, "text/plain", "Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Pi fallback settings: http://127.0.0.1:${port}/`);
  console.log(`Editing directory: ${cwd}`);
});

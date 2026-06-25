#!/usr/bin/env node

// src/post-commit-telemetry-ho.ts
import { execSync as execSync3, execFileSync as execFileSync5 } from "child_process";
import * as fs4 from "fs";
import * as path4 from "path";

// src/post-commit-agent-readers-ho.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
var EXTERNAL_READER_WINDOW_MS = 24 * 60 * 60 * 1e3;
function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
function cursorCheckpointsDir() {
  const platform = process.platform;
  let base;
  if (platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  } else if (platform === "linux") {
    base = path.join(os.homedir(), ".config", "Cursor", "User");
  } else {
    return null;
  }
  return path.join(base, "globalStorage", "anysphere.cursor-commits", "checkpoints");
}
function extractCodeBlockLines(text) {
  const lines = [];
  const fencePattern = /^`{3,}[a-zA-Z0-9_.-]*\s*$([\s\S]*?)^`{3,}\s*$/gm;
  let m;
  while ((m = fencePattern.exec(text)) !== null) {
    const blockContent = m[1] ?? "";
    for (const line of blockContent.split("\n")) {
      if (!line.trim()) continue;
      if (/[{}()=;:\/\*#\[\]<>|\\"]/.test(line) || /^\s+\S/.test(line) || /^\s*[A-Z_][A-Z0-9_]{2,}/.test(line)) {
        lines.push(line);
      }
    }
  }
  return lines;
}
function readCursorAiLines(repoRoot, commitSha, commitTime, parentSha) {
  const result = /* @__PURE__ */ new Map();
  try {
    const checkpointsDir = cursorCheckpointsDir();
    if (!checkpointsDir || !exists(checkpointsDir)) return result;
    const localRoot = path.resolve(repoRoot);
    const commitMs = (commitTime ?? /* @__PURE__ */ new Date()).getTime();
    const windowMs = EXTERNAL_READER_WINDOW_MS;
    for (const agentId of safeReaddir(checkpointsDir)) {
      const cpDir = path.join(checkpointsDir, agentId);
      const metaPath = path.join(cpDir, "metadata.json");
      const metaText = safeReadFile(metaPath);
      if (!metaText) continue;
      let meta;
      try {
        meta = JSON.parse(metaText);
      } catch {
        continue;
      }
      const metaRoot = path.resolve(meta.gitRoot ?? "");
      if (metaRoot !== localRoot) continue;
      const hashMatched = !!meta.commitHash && (meta.commitHash === commitSha || !!parentSha && meta.commitHash === parentSha);
      if (meta.commitHash && !hashMatched) continue;
      if (!hashMatched && meta.timestamp) {
        const cpMs = typeof meta.timestamp === "number" ? meta.timestamp : new Date(String(meta.timestamp)).getTime();
        if (!isNaN(cpMs) && Math.abs(cpMs - commitMs) > windowMs) continue;
      }
      const diffsDir = path.join(cpDir, "diffs");
      if (!exists(diffsDir)) continue;
      const fileMap = meta.files ?? {};
      for (const [fileUuid, fileInfo] of Object.entries(fileMap)) {
        const diffPath = path.join(diffsDir, fileUuid);
        const diffText = safeReadFile(diffPath);
        if (!diffText) continue;
        let diff;
        try {
          diff = JSON.parse(diffText);
        } catch {
          continue;
        }
        const addedLines = (diff.addedLines ?? []).map(
          (l) => l.content ?? ""
        ).filter(Boolean);
        if (addedLines.length === 0) continue;
        const absPath = fileInfo.path ?? "";
        const relPath = path.isAbsolute(absPath) ? path.relative(repoRoot, absPath) : absPath;
        if (!relPath || relPath.startsWith("..")) continue;
        const existing = result.get(relPath) ?? [];
        result.set(relPath, [...existing, ...addedLines]);
      }
    }
  } catch {
  }
  return result;
}
function walkFilesShallow(dir, maxDepth) {
  const out = [];
  if (maxDepth < 0) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkFilesShallow(full, maxDepth - 1));
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}
function parseCodexSessionFile(sessionFilePath, repoRoot) {
  const result = /* @__PURE__ */ new Map();
  const sessionText = safeReadFile(sessionFilePath);
  if (!sessionText) return result;
  for (const rawLine of sessionText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const msgType = msg["type"];
    if (msgType === "function_call" && msg["name"] === "apply_patch") {
      try {
        const argsRaw = msg["arguments"];
        if (!argsRaw) continue;
        const args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
        const patch = args.patch ?? "";
        let currentFile = null;
        for (const patchLine of patch.split("\n")) {
          const fileMatch = patchLine.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
          if (fileMatch) {
            const fp = fileMatch[1].trim();
            const relPath = path.isAbsolute(fp) ? path.relative(repoRoot, fp) : fp;
            currentFile = relPath.startsWith("..") ? null : relPath;
            continue;
          }
          if (!currentFile) continue;
          if (patchLine.startsWith("+") && !patchLine.startsWith("+++")) {
            const content = patchLine.slice(1);
            if (!content.trim()) continue;
            const existing = result.get(currentFile) ?? [];
            existing.push(content);
            result.set(currentFile, existing);
          }
        }
      } catch {
      }
      continue;
    }
    if (msgType === "function_call" && (msg["name"] === "write_file" || msg["name"] === "create_file")) {
      try {
        const argsRaw = msg["arguments"];
        if (!argsRaw) continue;
        const args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
        const filePath = args.path ?? "";
        const content = args.content ?? "";
        const relPath = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
        if (!relPath || relPath.startsWith("..")) continue;
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length === 0) continue;
        const existing = result.get(relPath) ?? [];
        result.set(relPath, [...existing, ...lines]);
      } catch {
      }
      continue;
    }
    if (msgType === "response_item") {
      try {
        const content = msg["content"];
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part.type !== "output_text" || !part.text) continue;
          const codeLines = extractCodeBlockLines(part.text);
          if (codeLines.length === 0) continue;
          const existing = result.get("__codex_unknown__") ?? [];
          result.set("__codex_unknown__", [...existing, ...codeLines]);
        }
      } catch {
      }
    }
  }
  return result;
}
function readCodexAiLines(repoRoot, _commitSha, commitTime) {
  const result = /* @__PURE__ */ new Map();
  try {
    const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
    if (!exists(sessionsDir)) return result;
    const localRoot = path.resolve(repoRoot);
    const commitMs = commitTime.getTime();
    const windowMs = EXTERNAL_READER_WINDOW_MS;
    for (const filePath of walkFilesShallow(sessionsDir, 6)) {
      const base = path.basename(filePath);
      if (!base.startsWith("rollout-") || !base.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(filePath);
        if (Math.abs(stat.mtimeMs - commitMs) > windowMs) continue;
      } catch {
        continue;
      }
      const text = safeReadFile(filePath);
      if (!text) continue;
      let metaCwd = null;
      let metaMs = NaN;
      for (const rawLine of text.split("\n").slice(0, 5)) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== "session_meta") continue;
          metaCwd = obj.payload?.cwd ?? null;
          const ts = obj.timestamp ?? obj.payload?.timestamp;
          metaMs = ts ? new Date(ts).getTime() : NaN;
          break;
        } catch {
          continue;
        }
      }
      if (!metaCwd || path.resolve(metaCwd) !== localRoot) continue;
      if (!isNaN(metaMs) && Math.abs(metaMs - commitMs) > windowMs) continue;
      const sessionLines = parseCodexSessionFile(filePath, repoRoot);
      for (const [file, lines] of sessionLines) {
        const existing = result.get(file) ?? [];
        result.set(file, [...existing, ...lines]);
      }
    }
  } catch {
  }
  return result;
}
function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function mergeOpenCodeFile(result, repoRoot, filePath, lines) {
  if (lines.length === 0) return;
  const relPath = path.isAbsolute(filePath) ? path.relative(realpathOrResolve(repoRoot), realpathOrResolve(filePath)) : filePath;
  if (!relPath || relPath.startsWith("..")) return;
  const existing = result.get(relPath) ?? [];
  result.set(relPath, [...existing, ...lines]);
}
function addedLinesFromUnifiedDiff(diff) {
  const out = [];
  for (const dl of diff.split("\n")) {
    if (!dl.startsWith("+") || dl.startsWith("+++")) continue;
    const content = dl.slice(1);
    if (content.trim()) out.push(content);
  }
  return out;
}
function parseOpenCodeApplyPatch(repoRoot, patchText) {
  const byFile = /* @__PURE__ */ new Map();
  let current = null;
  for (const raw of patchText.split("\n")) {
    const fileMatch = raw.match(/^\*\*\*\s+(?:Update|Add|Create)\s+File:\s+(.+)$/);
    if (fileMatch) {
      const fp = fileMatch[1].trim();
      const rel = path.isAbsolute(fp) ? path.relative(repoRoot, fp) : fp;
      current = rel.startsWith("..") ? null : rel;
      continue;
    }
    if (raw.startsWith("*** ")) {
      if (/End Patch/.test(raw)) current = null;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      const content = raw.slice(1);
      if (content.trim()) {
        const arr = byFile.get(current) ?? [];
        arr.push(content);
        byFile.set(current, arr);
      }
    }
  }
  return byFile;
}
function extractOpenCodePartLines(repoRoot, data, into) {
  if (data["type"] !== "tool") return;
  const tool = data["tool"];
  const state = data["state"];
  const input = state?.input ?? {};
  const meta = state?.metadata ?? {};
  if (tool === "write") {
    const fp = input["filePath"] ?? input["path"];
    const content = input["content"];
    if (fp && content) {
      mergeOpenCodeFile(into, repoRoot, fp, content.split("\n").filter((l) => l.trim().length > 0));
    }
    return;
  }
  if (tool === "edit") {
    const fp = input["filePath"] ?? input["path"];
    const diff = meta["diff"];
    if (fp && diff) {
      mergeOpenCodeFile(into, repoRoot, fp, addedLinesFromUnifiedDiff(diff));
    }
    return;
  }
  if (tool === "apply_patch" || tool === "patch") {
    const patchText = input["patchText"] ?? input["patch"];
    if (patchText) {
      for (const [rel, lines] of parseOpenCodeApplyPatch(repoRoot, patchText)) {
        mergeOpenCodeFile(into, repoRoot, rel, lines);
      }
    }
  }
}
function openCodeDbPath() {
  const candidates = [
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    path.join(os.homedir(), ".opencode", "opencode.db")
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}
function readOpenCodeFromSqlite(repoRoot, dbPath, commitMs, windowMs) {
  const result = /* @__PURE__ */ new Map();
  const lo = Math.floor(commitMs - windowMs);
  const hi = Math.ceil(commitMs + windowMs);
  const sql = `SELECT p.data AS data, s.directory AS directory FROM part p JOIN session s ON s.id = p.session_id WHERE p.time_created BETWEEN ${lo} AND ${hi} AND json_extract(p.data, '$.type') = 'tool';`;
  let raw;
  try {
    raw = execFileSync("sqlite3", ["-json", "-readonly", dbPath, sql], {
      encoding: "utf-8",
      timeout: 8e3,
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    return result;
  }
  if (!raw.trim()) return result;
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return result;
  }
  const localRoot = realpathOrResolve(repoRoot);
  for (const row of rows) {
    if (!row.data) continue;
    if (row.directory && realpathOrResolve(row.directory) !== localRoot) continue;
    let parsed;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    try {
      extractOpenCodePartLines(repoRoot, parsed, result);
    } catch {
    }
  }
  return result;
}
function readOpenCodeFromLegacyStorage(repoRoot, commitMs, windowMs) {
  const result = /* @__PURE__ */ new Map();
  const msgRoot = path.join(os.homedir(), ".local", "share", "opencode", "storage", "message");
  if (!exists(msgRoot)) return result;
  for (const sessionId of safeReaddir(msgRoot)) {
    const sessionDir = path.join(msgRoot, sessionId);
    for (const file of safeReaddir(sessionDir)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(sessionDir, file);
      try {
        const stat = fs.statSync(full);
        if (Math.abs(stat.mtimeMs - commitMs) > windowMs) continue;
      } catch {
        continue;
      }
      const text = safeReadFile(full);
      if (!text) continue;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      const parts = msg["parts"] ?? msg["data"];
      const partArr = Array.isArray(parts) ? parts : [parts];
      for (const part of partArr) {
        if (part && typeof part === "object") {
          try {
            extractOpenCodePartLines(repoRoot, part, result);
          } catch {
          }
        }
      }
    }
  }
  return result;
}
function readOpenCodeAiLines(repoRoot, _commitSha, commitTime) {
  const result = /* @__PURE__ */ new Map();
  try {
    const commitMs = commitTime.getTime();
    const windowMs = EXTERNAL_READER_WINDOW_MS;
    const dbPath = openCodeDbPath();
    if (dbPath) {
      const fromDb = readOpenCodeFromSqlite(repoRoot, dbPath, commitMs, windowMs);
      for (const [file, lines] of fromDb) {
        const existing = result.get(file) ?? [];
        result.set(file, [...existing, ...lines]);
      }
    }
    if (result.size === 0) {
      const fromLegacy = readOpenCodeFromLegacyStorage(repoRoot, commitMs, windowMs);
      for (const [file, lines] of fromLegacy) {
        const existing = result.get(file) ?? [];
        result.set(file, [...existing, ...lines]);
      }
    }
  } catch {
  }
  return result;
}

// src/commit-survival-ho.ts
import * as fs3 from "fs";
import * as path3 from "path";
import { execSync as execSync2, execFileSync as execFileSync3 } from "child_process";

// src/telemetry-core-ho.ts
import { execSync, execFileSync as execFileSync2, spawn } from "child_process";
import * as fs2 from "fs";
import * as path2 from "path";
import * as os2 from "os";
import { createHash } from "crypto";
var GENERATED_PATH_PREFIXES = ["dist/", "build/", "out/", ".next/", "node_modules/"];
var GENERATED_BASENAMES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "uv.lock"
]);
var GENERATED_SUFFIXES = [".min.js", ".min.css", ".snap", ".map"];
var isGeneratedFile = (p) => {
  if (GENERATED_PATH_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`))) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (GENERATED_BASENAMES.has(base)) return true;
  return GENERATED_SUFFIXES.some((suffix) => base.endsWith(suffix));
};
var AGENT_CAPABILITIES = {
  claude: { session_id_source: "resolved", token_capture: "measured", edit_matcher: "Write|Edit|MultiEdit|NotebookEdit", subagent_signal: true, tab_capture: false },
  codex: { session_id_source: "resolved", token_capture: "measured", edit_matcher: "apply_patch|Edit|Write", subagent_signal: true, tab_capture: false },
  cursor: { session_id_source: "resolved", token_capture: "partial", edit_matcher: "afterFileEdit", subagent_signal: true, tab_capture: true },
  opencode: { session_id_source: "plugin_root", token_capture: "measured", edit_matcher: "write|edit|apply_patch", subagent_signal: true, tab_capture: false },
  factory: { session_id_source: "env", token_capture: "partial", edit_matcher: "Write|Edit", subagent_signal: false, tab_capture: false },
  // No hooks runtime — config (rules/skills) only, so no telemetry surface.
  windsurf: { session_id_source: "none", token_capture: "none", edit_matcher: "", subagent_signal: false, tab_capture: false },
  antigravity: { session_id_source: "none", token_capture: "none", edit_matcher: "", subagent_signal: false, tab_capture: false },
  agent: { session_id_source: "none", token_capture: "none", edit_matcher: "", subagent_signal: false, tab_capture: false },
  unknown: { session_id_source: "none", token_capture: "none", edit_matcher: "", subagent_signal: false, tab_capture: false }
};
var AGENT_TOKEN_CAPABILITY = Object.fromEntries(
  Object.entries(AGENT_CAPABILITIES).map(([k, v]) => [k, v.token_capture])
);
var OMNISCIENT_URL = (process.env.HAC_OMNISCIENT_URL ?? "").trim() || "https://omniscient.test-headout.com/api/v1/events";
var CURL_TIMEOUT_SECONDS = 5;
var _cachedRepoRoot = null;
var _cachedGitDir = null;
var _cachedMainGitDir = null;
var _cachedDeveloper = null;
var _cachedRepo = null;
var _cachedWorkstreamId = null;
var _cachedTelemetryBaseDir = null;
var _cachedHeadSha = null;
var _headShaResolved = false;
var HOOK_HEAL_INTERVAL_MS = 5 * 60 * 1e3;
function getDeveloperContext() {
  if (_cachedDeveloper) return _cachedDeveloper;
  let email = "unknown";
  let name = "unknown";
  try {
    email = execSync("git config user.email", { encoding: "utf-8", timeout: 5e3 }).trim();
  } catch {
    email = os2.userInfo().username || "unknown";
  }
  try {
    name = execSync("git config user.name", { encoding: "utf-8", timeout: 5e3 }).trim();
  } catch {
    name = os2.userInfo().username || "unknown";
  }
  _cachedDeveloper = { email, name };
  return _cachedDeveloper;
}
function getRepoContext() {
  if (_cachedRepo) return _cachedRepo;
  let remote_url = "unknown";
  let branch = "unknown";
  let local_path = process.cwd();
  let name = "unknown";
  try {
    remote_url = execSync("git remote get-url origin", { encoding: "utf-8", timeout: 5e3 }).trim();
  } catch {
  }
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8", timeout: 5e3 }).trim();
  } catch {
  }
  try {
    local_path = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 5e3 }).trim();
  } catch {
  }
  name = extractRepoName(remote_url);
  _cachedRepo = { name, branch, remote_url, local_path };
  return _cachedRepo;
}
function extractRepoName(remote_url) {
  if (!remote_url || remote_url === "unknown") return "unknown";
  let cleaned = remote_url.replace(/\.git$/, "");
  const sshMatch = cleaned.match(/[:/]([^/]+)$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = cleaned.match(/\/([^/]+)$/);
  if (httpsMatch) return httpsMatch[1];
  return "unknown";
}
function detectAiTool() {
  const env = process.env;
  if (Object.keys(env).some((k) => k.startsWith("CURSOR_"))) return "cursor";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return "codex";
  if (Object.keys(env).some((k) => k.startsWith("FACTORY_"))) return "factory";
  if (Object.keys(env).some((k) => k.startsWith("OPENCODE_"))) return "opencode";
  if (env.CLAUDE_PROJECT_DIR) return "claude";
  return "unknown";
}
function aiToolFromHookEnv() {
  const raw = process.env.HOOK_AGENT?.toLowerCase().trim();
  if (!raw) return null;
  const allowed = ["claude", "cursor", "codex", "factory", "opencode", "unknown"];
  return allowed.includes(raw) ? raw : null;
}
function buildContext(sessionId, model, opts) {
  const internalRepo = getRepoContext();
  const ctx = {
    user: getDeveloperContext(),
    repo: { name: internalRepo.name, branch: internalRepo.branch },
    ai_tool: opts?.ai_tool ?? aiToolFromHookEnv() ?? detectAiTool(),
    ai_session_id: sessionId
  };
  if (model) {
    ctx.ai_model = model;
  }
  if (opts?.concurrent_ai_sessions && opts.concurrent_ai_sessions.length > 0) {
    ctx.concurrent_ai_sessions = opts.concurrent_ai_sessions;
  }
  return ctx;
}
function installHookWatchdog(ms = 8e3) {
  const timer = setTimeout(() => {
    try {
      process.stderr.write("[hac-telemetry] watchdog fired after " + ms + "ms\n");
    } catch {
    }
    try {
      incrementDropCounter("watchdog_timeout");
    } catch {
    }
    try {
      process.exit(0);
    } catch {
    }
  }, ms);
  return timer;
}
var BREAKER_DIR = path2.join(os2.homedir(), ".cache", "hac-telemetry");
var BREAKER_FILE = path2.join(BREAKER_DIR, "breaker.json");
var BREAKER_LOCK_FILE = BREAKER_FILE + ".lock";
var CURL_SUCCESS_DIR = path2.join(os2.tmpdir(), "hac-curl-ok");
var BREAKER_FAILURE_WINDOW_MS = 30 * 60 * 1e3;
var BREAKER_COOLDOWN_MS = 5 * 60 * 1e3;
var BREAKER_ATTEMPT_THRESHOLD = 10;
var BREAKER_ATTEMPT_DECAY_MS = 10 * 60 * 1e3;
function readBreaker() {
  try {
    const raw = fs2.readFileSync(BREAKER_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      attempts: Number(parsed.attempts) || 0,
      last_success: Number(parsed.last_success) || 0,
      cooldown_until: Number(parsed.cooldown_until) || 0,
      last_attempt: Number(parsed.last_attempt) || 0
    };
  } catch {
    return { attempts: 0, last_success: 0, cooldown_until: 0, last_attempt: 0 };
  }
}
function writeBreaker(state) {
  try {
    if (!fs2.existsSync(BREAKER_DIR)) fs2.mkdirSync(BREAKER_DIR, { recursive: true });
    const tmp = BREAKER_FILE + ".tmp." + process.pid;
    fs2.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs2.renameSync(tmp, BREAKER_FILE);
  } catch {
  }
}
function withBreakerLock(fn) {
  return withFileLock(BREAKER_LOCK_FILE, fn);
}
var _heldLocks = /* @__PURE__ */ new Set();
function withFileLock(lockFile, fn) {
  if (_heldLocks.has(lockFile)) {
    return fn();
  }
  let acquired = false;
  const STALE_MS = 6e4;
  for (let i = 0; i < 10; i++) {
    try {
      const fd = fs2.openSync(lockFile, "wx");
      try {
        fs2.writeSync(fd, String(process.pid));
      } catch {
      }
      fs2.closeSync(fd);
      acquired = true;
      _heldLocks.add(lockFile);
      break;
    } catch {
      try {
        const pidStr = fs2.readFileSync(lockFile, "utf-8").trim();
        const pid = parseInt(pidStr, 10);
        let stale = false;
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if (e.code === "ESRCH") stale = true;
          }
        } else {
          try {
            const st = fs2.statSync(lockFile);
            if (Date.now() - st.mtimeMs > STALE_MS) stale = true;
          } catch {
          }
        }
        if (stale) {
          try {
            fs2.unlinkSync(lockFile);
          } catch {
          }
          continue;
        }
      } catch {
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      } catch {
      }
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      _heldLocks.delete(lockFile);
      try {
        fs2.unlinkSync(lockFile);
      } catch {
      }
    }
  }
}
function isDispatchAllowed() {
  const now = Date.now();
  const s = readBreaker();
  if (s.cooldown_until && now >= s.cooldown_until) return true;
  if (s.cooldown_until && now < s.cooldown_until) return false;
  if (s.attempts > 0 && s.last_attempt > 0 && now - s.last_attempt > BREAKER_ATTEMPT_DECAY_MS) {
    return true;
  }
  if (s.attempts >= BREAKER_ATTEMPT_THRESHOLD && now - s.last_success > BREAKER_FAILURE_WINDOW_MS) {
    return false;
  }
  return true;
}
function shouldDispatch() {
  const now = Date.now();
  const s = readBreaker();
  if (s.cooldown_until && now >= s.cooldown_until) {
    withBreakerLock(() => writeBreaker({ ...readBreaker(), attempts: 0, cooldown_until: 0 }));
    return true;
  }
  if (s.cooldown_until && now < s.cooldown_until) return false;
  if (s.attempts > 0 && s.last_attempt > 0 && now - s.last_attempt > BREAKER_ATTEMPT_DECAY_MS) {
    withBreakerLock(() => writeBreaker({ ...readBreaker(), attempts: 0 }));
    return true;
  }
  if (s.attempts >= BREAKER_ATTEMPT_THRESHOLD && now - s.last_success > BREAKER_FAILURE_WINDOW_MS) {
    withBreakerLock(() => writeBreaker({ ...readBreaker(), cooldown_until: now + BREAKER_COOLDOWN_MS, attempts: 0 }));
    return false;
  }
  return true;
}
function recordAttempt() {
  withBreakerLock(() => {
    const s = readBreaker();
    writeBreaker({ ...s, attempts: s.attempts + 1, last_attempt: Date.now() });
  });
}
function checkAndRecordAttempt() {
  return withBreakerLock(() => {
    const now = Date.now();
    const s = readBreaker();
    if (s.cooldown_until && now >= s.cooldown_until) {
      writeBreaker({ ...s, attempts: 1, cooldown_until: 0, last_attempt: now });
      return true;
    }
    if (s.cooldown_until && now < s.cooldown_until) return false;
    if (s.attempts > 0 && s.last_attempt > 0 && now - s.last_attempt > BREAKER_ATTEMPT_DECAY_MS) {
      writeBreaker({ ...s, attempts: 1, last_attempt: now });
      return true;
    }
    if (s.attempts >= BREAKER_ATTEMPT_THRESHOLD && now - s.last_success > BREAKER_FAILURE_WINDOW_MS) {
      writeBreaker({ ...s, cooldown_until: now + BREAKER_COOLDOWN_MS, attempts: 0 });
      return false;
    }
    writeBreaker({ ...s, attempts: s.attempts + 1, last_attempt: now });
    return true;
  });
}
function recordAttemptRollback() {
  withBreakerLock(() => {
    const s = readBreaker();
    writeBreaker({ ...s, attempts: Math.max(0, s.attempts - 1) });
  });
}
function recordTelemetrySuccess() {
  withBreakerLock(() => {
    const s = readBreaker();
    writeBreaker({ ...s, attempts: 0, last_success: Date.now(), cooldown_until: 0 });
  });
}
function drainAsyncSuccessMarkers() {
  try {
    if (!fs2.existsSync(CURL_SUCCESS_DIR)) return;
    const files = fs2.readdirSync(CURL_SUCCESS_DIR);
    if (files.length === 0) return;
    recordTelemetrySuccess();
    for (const f of files) {
      try {
        fs2.unlinkSync(path2.join(CURL_SUCCESS_DIR, f));
      } catch {
      }
    }
  } catch {
  }
}
function recordClientReject(code, body) {
  if ((process.env.HAC_DEBUG_HOOKS ?? "").trim() !== "") {
    try {
      process.stderr.write(`[hac-telemetry] client reject ${code} payload=${body.slice(0, 200)}
`);
    } catch {
    }
  }
  try {
    const baseDir = getTelemetryBaseDir();
    const dir = path2.join(baseDir, ".telemetry");
    if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
    const rejectPath = path2.join(dir, "reject.log");
    const entry = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      code,
      payload: body.slice(0, 2048)
    }) + "\n";
    withFileLock(rejectPath + ".lock", () => {
      try {
        if (fs2.existsSync(rejectPath)) {
          const st = fs2.statSync(rejectPath);
          if (st.size + entry.length > 1024 * 1024) {
            try {
              fs2.renameSync(rejectPath, rejectPath + ".1");
            } catch {
            }
          }
        }
      } catch {
      }
      try {
        fs2.appendFileSync(rejectPath, entry, "utf-8");
      } catch {
      }
    });
  } catch {
  }
}
function isValidAuthorEmail(email) {
  if (typeof email !== "string" || !email) return false;
  if (email.includes("[bot]")) return false;
  const at = email.indexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.endsWith(".")) return false;
  return true;
}
function extractEventAuthorEmail(event) {
  const e = event;
  if (e?.author?.email !== void 0) return e.author.email;
  if (e?.payload?.context?.user?.email !== void 0) return e.payload.context.user.email;
  return void 0;
}
function extractEventRepoName(event) {
  const e = event;
  if (e?.repo?.name !== void 0) return e.repo.name;
  if (e?.payload?.context?.repo?.name !== void 0) return e.payload.context.repo.name;
  return void 0;
}
function classifyEmission(event) {
  if (!isValidAuthorEmail(extractEventAuthorEmail(event))) return "drop_invalid_email";
  const repo = extractEventRepoName(event);
  if (typeof repo !== "string" || !repo || repo.toLowerCase() === "unknown") return "skip_unknown_repo";
  return "emit";
}
function incrementDropCounter(reason, by = 1) {
  if (!Number.isFinite(by) || by <= 0) return;
  try {
    const baseDir = getTelemetryBaseDir();
    if (!fs2.existsSync(baseDir)) fs2.mkdirSync(baseDir, { recursive: true });
    const p = path2.join(baseDir, "drop_counters.json");
    withFileLock(p + ".lock", () => {
      let counts = {};
      try {
        if (fs2.existsSync(p)) counts = JSON.parse(fs2.readFileSync(p, "utf-8"));
      } catch {
        counts = {};
      }
      counts[reason] = (typeof counts[reason] === "number" ? counts[reason] : 0) + by;
      try {
        fs2.writeFileSync(p, JSON.stringify(counts), "utf-8");
      } catch {
      }
    });
  } catch {
  }
}
function emitDropBreadcrumb(reason, event) {
  if ((process.env.HAC_DEBUG_HOOKS ?? "").trim() === "") return;
  try {
    const kind = event?.event ?? "unknown_event";
    process.stderr.write(`[hac-telemetry] dropped ${kind}: ${reason}
`);
  } catch {
  }
}
function sendEvent(event) {
  drainAsyncSuccessMarkers();
  const decision = classifyEmission(event);
  if (decision === "drop_invalid_email") {
    incrementDropCounter("dropped_invalid_email");
    emitDropBreadcrumb("invalid_email", event);
    return false;
  }
  let wire;
  if ("payload" in event) {
    wire = event;
  } else {
    const { event: eventName, timestamp, ...rest } = event;
    wire = { event: eventName, payload: rest, timestamp };
  }
  const body = JSON.stringify(wire);
  {
    const target = (process.env.HAC_DEBUG_DUMP_EVENTS ?? "").trim();
    if (target && target !== "0" && target.toLowerCase() !== "false") try {
      const dumpPath = target === "1" || target.toLowerCase() === "true" ? "/tmp/hac-telemetry-events.ndjson" : target;
      const ROTATE_AT = 50 * 1024 * 1024;
      try {
        const st = fs2.statSync(dumpPath);
        if (st.size > ROTATE_AT) {
          try {
            fs2.renameSync(dumpPath, dumpPath + ".1");
          } catch {
          }
        }
      } catch {
      }
      fs2.appendFileSync(dumpPath, body + "\n");
    } catch {
    }
  }
  try {
    const baseDir = getTelemetryBaseDir();
    fs2.mkdirSync(baseDir, { recursive: true });
    const localPath = path2.join(baseDir, "events.jsonl");
    const ROTATE_AT = 2 * 1024 * 1024;
    try {
      const st = fs2.statSync(localPath);
      if (st.size > ROTATE_AT) {
        try {
          fs2.renameSync(localPath, localPath + ".1");
        } catch {
        }
      }
    } catch {
    }
    fs2.appendFileSync(localPath, body + "\n");
  } catch {
  }
  if (decision === "skip_unknown_repo") {
    incrementDropCounter("dropped_unknown_repo");
    emitDropBreadcrumb("unknown_repo", event);
    return false;
  }
  const dispatched = checkAndRecordAttempt();
  if (!dispatched) {
    enqueueRetry(event);
    return false;
  }
  try {
    const rand = Math.random().toString(36).slice(2, 10);
    const tmpFile = path2.join(os2.tmpdir(), `hac-event-${process.pid}-${rand}.json`);
    try {
      fs2.writeFileSync(tmpFile, body, "utf-8");
    } catch {
      enqueueRetry(event);
      return false;
    }
    const sqEsc = (s) => "'" + s.replace(/'/g, `'\\''`) + "'";
    const sqUrl = sqEsc(OMNISCIENT_URL);
    const sqTmp = sqEsc(tmpFile);
    const sqOkDir = sqEsc(CURL_SUCCESS_DIR);
    const okMarker = `${CURL_SUCCESS_DIR}/${process.pid}-${rand}`;
    const sqOkMarker = sqEsc(okMarker);
    const cmd = `HTTP=$(curl -sS -w '%{http_code}' -o /dev/null --max-time ${CURL_TIMEOUT_SECONDS} -X POST ${sqUrl} -H 'Content-Type: application/json' --data-binary @${sqTmp}); rm -f ${sqTmp}; [ "$HTTP" -ge 200 ] 2>/dev/null && [ "$HTTP" -lt 300 ] 2>/dev/null && mkdir -p ${sqOkDir} && touch ${sqOkMarker}`;
    const child = spawn("sh", ["-c", cmd], {
      detached: true,
      stdio: "ignore"
    });
    try {
      child.on("error", () => {
      });
    } catch {
    }
    try {
      child.stdin?.on?.("error", () => {
      });
    } catch {
    }
    try {
      child.unref();
    } catch {
    }
    return true;
  } catch {
    enqueueRetry(event);
    return false;
  }
}
var RETRY_QUEUE_MAX_LINES = 500;
function getRetryQueuePath() {
  try {
    const baseDir = getTelemetryBaseDir();
    if (!fs2.existsSync(baseDir)) fs2.mkdirSync(baseDir, { recursive: true });
    return path2.join(baseDir, "retry_queue.jsonl");
  } catch {
    return null;
  }
}
function enqueueRetry(event) {
  try {
    const p = getRetryQueuePath();
    if (!p) return;
    withFileLock(p + ".lock", () => {
      try {
        if (fs2.existsSync(p)) {
          const lines = fs2.readFileSync(p, "utf-8").split("\n").filter(Boolean);
          if (lines.length >= RETRY_QUEUE_MAX_LINES) {
            const drop = lines.slice(0, lines.length - Math.floor(RETRY_QUEUE_MAX_LINES / 2));
            const keep = lines.slice(-Math.floor(RETRY_QUEUE_MAX_LINES / 2));
            try {
              const archivePath = p.replace(/\.jsonl$/, "") + ".archived";
              const ARCHIVE_CAP = 5 * 1024 * 1024;
              const toAppend = drop.join("\n") + (drop.length ? "\n" : "");
              let curSize = 0;
              try {
                curSize = fs2.statSync(archivePath).size;
              } catch {
              }
              if (curSize + Buffer.byteLength(toAppend, "utf-8") > ARCHIVE_CAP) {
                let existing = "";
                try {
                  existing = fs2.readFileSync(archivePath, "utf-8");
                } catch {
                }
                const all = (existing + toAppend).split("\n").filter(Boolean);
                while (all.length > 0 && Buffer.byteLength(all.join("\n") + "\n", "utf-8") > ARCHIVE_CAP) {
                  all.shift();
                }
                fs2.writeFileSync(archivePath, all.join("\n") + (all.length ? "\n" : ""), "utf-8");
              } else {
                fs2.appendFileSync(archivePath, toAppend, "utf-8");
              }
            } catch {
            }
            if ((process.env.HAC_DEBUG_HOOKS ?? "").trim() !== "") {
              try {
                process.stderr.write(`[hac-telemetry] retry-queue archived ${drop.length} oldest events
`);
              } catch {
              }
            }
            fs2.writeFileSync(p, keep.join("\n") + "\n", "utf-8");
          }
        }
      } catch {
      }
      fs2.appendFileSync(p, JSON.stringify(event) + "\n", "utf-8");
    });
  } catch {
  }
}
function retryUnsentEvents(maxPerCall = 3) {
  try {
    const p = getRetryQueuePath();
    if (!p || !fs2.existsSync(p)) return;
    withFileLock(p + ".lock", () => {
      if (!fs2.existsSync(p)) return;
      const raw = fs2.readFileSync(p, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length === 0) {
        try {
          fs2.unlinkSync(p);
        } catch {
        }
        return;
      }
      const remaining = [];
      let processed = 0;
      let consecutive5xx = 0;
      let aborted = false;
      for (let i = 0; i < lines.length; i++) {
        if (aborted || processed >= maxPerCall) {
          remaining.push(...lines.slice(i));
          break;
        }
        processed++;
        let evt = null;
        try {
          evt = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (!evt) continue;
        if (evt.event === "commit_event_trace" && evt.commit_sha) {
          const dedupDir = path2.join(getTelemetryBaseDir(), "emitted_shas");
          const dedupFile = path2.join(dedupDir, evt.commit_sha);
          if (fs2.existsSync(dedupFile)) continue;
        }
        const ok = sendEventNoRetry(evt, true);
        if (!ok) {
          remaining.push(lines[i]);
          consecutive5xx++;
          if (consecutive5xx >= 3) aborted = true;
        } else {
          consecutive5xx = 0;
        }
      }
      const tmp = p + ".tmp." + process.pid;
      if (remaining.length === 0) {
        try {
          fs2.unlinkSync(p);
        } catch {
        }
      } else {
        fs2.writeFileSync(tmp, remaining.join("\n") + "\n", "utf-8");
        fs2.renameSync(tmp, p);
      }
    });
  } catch {
  }
}
function sendEventNoRetry(event, fromRetryQueue) {
  if (classifyEmission(event) !== "emit") return true;
  const body = JSON.stringify(event);
  if (fromRetryQueue) {
    if (!isDispatchAllowed()) return false;
  } else {
    if (!shouldDispatch()) return false;
  }
  if (!fromRetryQueue) recordAttempt();
  try {
    const out = execFileSync2("curl", [
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "1",
      "-X",
      "POST",
      OMNISCIENT_URL,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-"
    ], {
      input: body,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    });
    const codeStr = (out instanceof Buffer ? out.toString("utf-8") : String(out)).trim();
    const code = parseInt(codeStr, 10);
    if (code >= 200 && code < 300) {
      recordTelemetrySuccess();
      return true;
    }
    if (code >= 400 && code < 500) {
      recordClientReject(code, body);
      if (!fromRetryQueue) recordAttemptRollback();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
function getTelemetryBaseDir() {
  if (_cachedTelemetryBaseDir) return _cachedTelemetryBaseDir;
  const toplevel = getRepoRootFromGit(process.cwd());
  const gitDir = toplevel ? getGitDirAbsolute(toplevel) : null;
  if (gitDir) {
    _cachedTelemetryBaseDir = path2.join(gitDir, "hac_telemetry");
  } else {
    _cachedTelemetryBaseDir = path2.join(process.cwd(), ".git", "hac_telemetry");
  }
  return _cachedTelemetryBaseDir;
}
function getMainRepoGitDir() {
  if (_cachedMainGitDir !== null) return _cachedMainGitDir;
  try {
    const repoRoot = getRepoRootFromGit(process.cwd());
    const out = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot ?? process.cwd()
    }).trim();
    if (!out) return null;
    _cachedMainGitDir = path2.isAbsolute(out) ? out : path2.resolve(repoRoot ?? process.cwd(), out);
    return _cachedMainGitDir;
  } catch {
    return null;
  }
}
function getTelemetryBaseDirsForRead() {
  const dirs = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (p) => {
    if (!p) return;
    const norm = path2.resolve(p);
    if (seen.has(norm)) return;
    seen.add(norm);
    dirs.push(norm);
  };
  push(getTelemetryBaseDir());
  const main3 = getMainRepoGitDir();
  if (main3) push(path2.join(main3, "hac_telemetry"));
  return dirs;
}
function getHeadSha() {
  if (_headShaResolved) return _cachedHeadSha;
  try {
    _cachedHeadSha = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
  } catch {
    _cachedHeadSha = null;
  }
  _headShaResolved = true;
  return _cachedHeadSha;
}
function getActiveCommitDir() {
  const base = getTelemetryBaseDir();
  const sha = getHeadSha() ?? "initial";
  return path2.join(base, sha);
}
function getCommitDir(sha) {
  return path2.join(getTelemetryBaseDir(), sha);
}
function commitRecordExistsFor(sha) {
  for (const baseDir of getTelemetryBaseDirsForRead()) {
    const filePath = path2.join(baseDir, "ai_commit_records.jsonl");
    if (!fs2.existsSync(filePath)) continue;
    try {
      for (const line of fs2.readFileSync(filePath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.commit_sha !== sha) continue;
          if ("superseded_by" in rec && !("files" in rec)) continue;
          return true;
        } catch {
        }
      }
    } catch {
    }
  }
  return false;
}
function getTransferCommitNumstat(repoRoot, sha) {
  try {
    const output = execFileSync2("git", ["show", "--format=", "--numstat", sha], {
      encoding: "utf-8",
      timeout: 1e4,
      cwd: repoRoot
    }).trim();
    if (!output) return [];
    const entries = [];
    for (const line of output.split("\n")) {
      const parts = line.split("	");
      if (parts.length < 3) continue;
      const [added2, deleted, ...pathParts] = parts;
      const filePath = pathParts.join("	");
      if (added2 === "-" || deleted === "-") continue;
      const linesAdded = parseInt(added2, 10);
      const linesDeleted = parseInt(deleted, 10);
      if (isNaN(linesAdded) || isNaN(linesDeleted)) continue;
      entries.push({ linesAdded, linesDeleted, filePath });
    }
    return entries;
  } catch {
    return [];
  }
}
function loadCommitRecordsForRead() {
  const bysha = /* @__PURE__ */ new Map();
  const consume = (filePath) => {
    if (!fs2.existsSync(filePath)) return;
    try {
      for (const line of fs2.readFileSync(filePath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!record.commit_sha) continue;
          if ("superseded_by" in record && !("files" in record)) continue;
          bysha.set(record.commit_sha, record);
        } catch {
        }
      }
    } catch {
    }
  };
  for (const baseDir of getTelemetryBaseDirsForRead()) {
    if (!fs2.existsSync(baseDir)) continue;
    consume(path2.join(baseDir, "ai_commit_records.jsonl.1"));
    consume(path2.join(baseDir, "ai_commit_records.jsonl"));
    let dirs = [];
    try {
      dirs = fs2.readdirSync(baseDir).filter((d) => {
        try {
          return fs2.statSync(path2.join(baseDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      consume(path2.join(baseDir, dir, "ai_commit_records.jsonl"));
    }
  }
  return bysha;
}
function mergeAttributions(records) {
  let totalAiAdded = 0;
  let totalAiDeleted = 0;
  const agentTotals = {};
  const fileMap = /* @__PURE__ */ new Map();
  for (const record of records) {
    totalAiAdded += record.ai_authored_lines_added;
    totalAiDeleted += record.ai_authored_lines_deleted;
    if (record.ai_lines_by_tool) {
      for (const [agent, count] of Object.entries(record.ai_lines_by_tool)) {
        agentTotals[agent] = (agentTotals[agent] ?? 0) + count;
      }
    }
    for (const file of record.files) {
      const existing = fileMap.get(file.path);
      if (existing) {
        existing.ai_authored_lines_added += file.ai_authored_lines_added;
        existing.ai_authored_lines_deleted += file.ai_authored_lines_deleted;
        existing.lines_added_total += file.lines_added_total;
        existing.lines_deleted_total += file.lines_deleted_total;
        existing.match_breakdown.checkpoint_matches += file.match_breakdown.checkpoint_matches;
        existing.match_breakdown.trigram_matches += file.match_breakdown.trigram_matches;
        existing.match_breakdown.line_only_matches += file.match_breakdown.line_only_matches;
        existing.match_breakdown.fallback_estimate += file.match_breakdown.fallback_estimate;
        existing.ai_drafted_then_human_edited_lines += file.ai_drafted_then_human_edited_lines;
        if (existing.operation === void 0 && file.operation !== void 0) existing.operation = file.operation;
        if (existing.rename_from === void 0 && file.rename_from !== void 0) existing.rename_from = file.rename_from;
      } else {
        fileMap.set(file.path, {
          path: file.path,
          ai_authored_lines_added: file.ai_authored_lines_added,
          ai_authored_lines_deleted: file.ai_authored_lines_deleted,
          ai_drafted_then_human_edited_lines: file.ai_drafted_then_human_edited_lines,
          lines_added_total: file.lines_added_total,
          lines_deleted_total: file.lines_deleted_total,
          operation: file.operation,
          rename_from: file.rename_from,
          match_breakdown: {
            checkpoint_matches: file.match_breakdown.checkpoint_matches,
            trigram_matches: file.match_breakdown.trigram_matches,
            line_only_matches: file.match_breakdown.line_only_matches,
            fallback_estimate: file.match_breakdown.fallback_estimate
          }
        });
      }
    }
  }
  return {
    ai_authored_lines_added: totalAiAdded,
    ai_authored_lines_deleted: totalAiDeleted,
    ai_lines_by_tool: agentTotals,
    files: Array.from(fileMap.values())
  };
}
function clampToActualDiff(merged, actualDiff) {
  const actualByFile = /* @__PURE__ */ new Map();
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const entry of actualDiff) {
    actualByFile.set(entry.filePath, entry);
    totalAdded += entry.linesAdded;
    totalDeleted += entry.linesDeleted;
  }
  const clampedFiles = [];
  for (const file of merged.files) {
    const actual = actualByFile.get(file.path);
    if (!actual) continue;
    clampedFiles.push({
      path: file.path,
      ai_authored_lines_added: Math.min(file.ai_authored_lines_added, actual.linesAdded),
      ai_authored_lines_deleted: Math.min(file.ai_authored_lines_deleted, actual.linesDeleted),
      ai_drafted_then_human_edited_lines: file.ai_drafted_then_human_edited_lines,
      lines_added_total: actual.linesAdded,
      lines_deleted_total: actual.linesDeleted,
      operation: file.operation,
      rename_from: file.rename_from,
      match_breakdown: file.match_breakdown
    });
  }
  for (const entry of actualDiff) {
    if (!merged.files.some((f) => f.path === entry.filePath)) {
      clampedFiles.push({
        path: entry.filePath,
        ai_authored_lines_added: 0,
        ai_authored_lines_deleted: 0,
        ai_drafted_then_human_edited_lines: 0,
        lines_added_total: entry.linesAdded,
        lines_deleted_total: entry.linesDeleted,
        match_breakdown: { checkpoint_matches: 0, trigram_matches: 0, line_only_matches: 0, fallback_estimate: 0 }
      });
    }
  }
  const clampedAiAdded = Math.min(merged.ai_authored_lines_added, totalAdded);
  const clampedAiDeleted = Math.min(merged.ai_authored_lines_deleted, totalDeleted);
  const clampedAgents = {};
  const agentTotal = Object.values(merged.ai_lines_by_tool).reduce((s, v) => s + v, 0);
  if (agentTotal > 0 && agentTotal > clampedAiAdded) {
    const scale = clampedAiAdded / agentTotal;
    for (const [agent, count] of Object.entries(merged.ai_lines_by_tool)) {
      clampedAgents[agent] = Math.round(count * scale);
    }
  } else {
    Object.assign(clampedAgents, merged.ai_lines_by_tool);
  }
  return {
    ai_authored_lines_added: clampedAiAdded,
    ai_authored_lines_deleted: clampedAiDeleted,
    lines_added_total: totalAdded,
    lines_deleted_total: totalDeleted,
    ai_lines_by_tool: clampedAgents,
    files: clampedFiles
  };
}
function transferAttribution(oldShas, newSha, method, opts) {
  try {
    if (!newSha || oldShas.length === 0) return null;
    const repoRoot = opts.repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!repoRoot) return null;
    const all = loadCommitRecordsForRead();
    const oldRecords = [];
    for (const sha of oldShas) {
      const rec = all.get(sha);
      if (rec) oldRecords.push(rec);
    }
    if (oldRecords.length === 0) return null;
    const merged = mergeAttributions(oldRecords);
    const actualDiff = getTransferCommitNumstat(repoRoot, newSha).filter((d) => !isGeneratedFile(d.filePath));
    let finalAttribution;
    if (actualDiff.length > 0) {
      finalAttribution = clampToActualDiff(merged, actualDiff);
    } else {
      const totalAdded = merged.files.reduce((s, f) => s + f.lines_added_total, 0);
      const totalDeleted = merged.files.reduce((s, f) => s + f.lines_deleted_total, 0);
      finalAttribution = { ...merged, lines_added_total: totalAdded, lines_deleted_total: totalDeleted };
    }
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const newRecord = {
      commit_sha: newSha,
      ai_authored_lines_added: finalAttribution.ai_authored_lines_added,
      ai_authored_lines_deleted: finalAttribution.ai_authored_lines_deleted,
      lines_added_total: finalAttribution.lines_added_total,
      lines_deleted_total: finalAttribution.lines_deleted_total,
      ai_lines_by_tool: finalAttribution.ai_lines_by_tool,
      files: finalAttribution.files,
      timestamp: nowIso,
      ...opts.concurrentSessions && opts.concurrentSessions.length > 0 ? { concurrent_ai_sessions: opts.concurrentSessions } : {}
    };
    try {
      const newShaDir = path2.join(getTelemetryBaseDir(), newSha);
      fs2.mkdirSync(newShaDir, { recursive: true });
      const recordPath = path2.join(newShaDir, "ai_commit_records.jsonl");
      withFileLock(recordPath + ".lock", () => {
        const already = fs2.existsSync(recordPath) && fs2.readFileSync(recordPath, "utf-8").split("\n").some((l) => {
          if (!l.trim()) return false;
          try {
            const r = JSON.parse(l);
            return r.commit_sha === newSha && "files" in r;
          } catch {
            return false;
          }
        });
        if (!already) fs2.appendFileSync(recordPath, JSON.stringify(newRecord) + "\n", "utf-8");
      });
    } catch {
    }
    try {
      const basePath = path2.join(getTelemetryBaseDir(), "ai_commit_records.jsonl");
      withFileLock(basePath + ".lock", () => {
        const already = fs2.existsSync(basePath) && fs2.readFileSync(basePath, "utf-8").split("\n").some((l) => {
          if (!l.trim()) return false;
          try {
            const r = JSON.parse(l);
            return r.commit_sha === newSha && "files" in r;
          } catch {
            return false;
          }
        });
        if (!already) fs2.appendFileSync(basePath, JSON.stringify(newRecord) + "\n", "utf-8");
      });
    } catch {
    }
    for (const oldSha of oldShas) {
      const tombstone = { commit_sha: oldSha, superseded_by: newSha, timestamp: nowIso };
      try {
        const basePath = path2.join(getTelemetryBaseDir(), "ai_commit_records.jsonl");
        withFileLock(basePath + ".lock", () => {
          fs2.mkdirSync(getTelemetryBaseDir(), { recursive: true });
          fs2.appendFileSync(basePath, JSON.stringify(tombstone) + "\n", "utf-8");
        });
      } catch {
      }
    }
    if (!opts.emitEvent) return null;
    const totalChanged = finalAttribution.lines_added_total + finalAttribution.lines_deleted_total;
    const totalAiChanged = finalAttribution.ai_authored_lines_added + finalAttribution.ai_authored_lines_deleted;
    const aiPercentage = totalChanged > 0 ? Math.round(totalAiChanged / totalChanged * 100) : 0;
    const pureHumanLinesAdded = Math.max(0, finalAttribution.lines_added_total - finalAttribution.ai_authored_lines_added);
    const pureHumanLinesDeleted = Math.max(0, finalAttribution.lines_deleted_total - finalAttribution.ai_authored_lines_deleted);
    const context = buildContext(opts.sessionId ?? `remap-${computeWorkstreamId().slice(0, 12)}`, opts.model, {
      ...opts.aiTool ? { ai_tool: opts.aiTool } : {},
      ...opts.concurrentSessions && opts.concurrentSessions.length > 0 ? { concurrent_ai_sessions: opts.concurrentSessions } : {}
    });
    const filesChanged = finalAttribution.files.map((f) => f.path);
    const sizeBucket = totalChanged <= 10 ? "small" : totalChanged <= 100 ? "medium" : totalChanged <= 500 ? "large" : "huge";
    const triggeredBy = method === "cherry-pick" ? "cherry-pick" : method === "squash-merge" ? "squash-merge" : method;
    const event = {
      event: "commit_event_trace",
      commit_sha: newSha,
      repo: { name: context.repo.name, branch: context.repo.branch },
      author: { email: context.user.email, name: context.user.name },
      timestamp: nowIso,
      ai_per: aiPercentage,
      triggered_by: triggeredBy,
      commit_size_bucket: sizeBucket,
      supersedes_commit_sha: oldShas.length > 1 ? oldShas.join(",") : oldShas[0],
      attribution_method: "remapped",
      remap_kind: method,
      exclude_from_metrics: true,
      overall: {
        files: { changed: filesChanged.length, created: 0, deleted: 0 },
        lines: {
          changed: totalChanged,
          added: finalAttribution.lines_added_total,
          deleted: finalAttribution.lines_deleted_total
        },
        changed_files_count: filesChanged.length
      },
      ai: {
        lines: {
          added: finalAttribution.ai_authored_lines_added,
          deleted: finalAttribution.ai_authored_lines_deleted
        },
        ...Object.keys(finalAttribution.ai_lines_by_tool ?? {}).length > 0 ? { by_tool: finalAttribution.ai_lines_by_tool } : {},
        sessions: {
          count: opts.toolsUsedDetailed ? opts.toolsUsedDetailed.reduce((s, t) => s + t.sessions, 0) : opts.concurrentSessions?.length ?? 0,
          ...opts.primarySessionId ?? context.ai_session_id ? { primary_session_id: opts.primarySessionId ?? context.ai_session_id } : {},
          tools_used: opts.toolsUsedDetailed ?? []
        },
        activity: { line_writes: 0, files_touched: filesChanged.length }
      },
      human: { lines: { added: pureHumanLinesAdded, deleted: pureHumanLinesDeleted } }
    };
    sendEvent(event);
    return event;
  } catch {
    return null;
  }
}
function getSessionLogDir(_workstreamId) {
  return getActiveCommitDir();
}
function computeWorkstreamId() {
  if (_cachedWorkstreamId) return _cachedWorkstreamId;
  const repo = getRepoContext();
  const dev = getDeveloperContext();
  const raw = `${repo.local_path}::${repo.branch}::${dev.email}`;
  _cachedWorkstreamId = createHash("sha256").update(raw, "utf-8").digest("hex");
  return _cachedWorkstreamId;
}
function appendSessionLog(workstreamId, filename, data) {
  try {
    const dir = getSessionLogDir(workstreamId);
    fs2.mkdirSync(dir, { recursive: true });
    const filePath = path2.join(dir, filename);
    const line = JSON.stringify(data) + "\n";
    withFileLock(filePath + ".lock", () => {
      fs2.appendFileSync(filePath, line, "utf-8");
    });
  } catch {
    try {
      incrementDropCounter("capture_exception");
    } catch {
    }
  }
}
function normalizeLine(line) {
  return line.replace(/\r/g, "").trimEnd();
}
function sha1(input) {
  return createHash("sha1").update(input, "utf-8").digest("hex");
}
function trigramHash(prevLine, currentLine, nextLine) {
  return sha1(normalizeLine(prevLine) + "\0" + normalizeLine(currentLine) + "\0" + normalizeLine(nextLine));
}
function lineHash(line) {
  return sha1(normalizeLine(line));
}
function lineHashWsNorm(line) {
  const normalized = normalizeLine(line);
  const wsNormalized = normalized.replace(/^\s+/, " ");
  return sha1(wsNormalized);
}
function readAllFromSessionLog(_workstreamId, filename, commitSha) {
  const baseDirs = getTelemetryBaseDirsForRead();
  const subdir = commitSha ?? (getHeadSha() ?? "initial");
  const all = [];
  const seen = /* @__PURE__ */ new Set();
  const dedupKey = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj;
    const fp = typeof o.file_path === "string" ? o.file_path : null;
    const editId = typeof o.edit_id === "string" && o.edit_id ? o.edit_id : null;
    if (editId) {
      const lh2 = typeof o.line_content_hash === "string" ? o.line_content_hash : typeof o.line_hash === "string" ? o.line_hash : null;
      if (fp && lh2) return `del|${fp}|${lh2}|${editId}`;
      return null;
    }
    const ctx = typeof o.line_context_hash === "string" ? o.line_context_hash : null;
    if (fp && ctx) return `ins|${fp}|${ctx}`;
    const lh = typeof o.line_content_hash === "string" ? o.line_content_hash : typeof o.line_hash === "string" ? o.line_hash : null;
    if (fp && lh) return `${fp}|${lh}|${typeof o.edit_id === "string" ? o.edit_id : ""}`;
    return null;
  };
  for (const base of baseDirs) {
    const filePath = path2.join(base, subdir, filename);
    if (!fs2.existsSync(filePath)) continue;
    try {
      const content = fs2.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const key = dedupKey(obj);
        if (key !== null) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        all.push(obj);
      }
    } catch {
    }
  }
  return all;
}
function rotateCommitDir() {
  const newSha = getHeadSha();
  if (!newSha) return getActiveCommitDir();
  const newDir = path2.join(getTelemetryBaseDir(), newSha);
  fs2.mkdirSync(newDir, { recursive: true });
  return newDir;
}
function buildUncommittedHashSets(uncommittedFiles, repoRoot) {
  const result = /* @__PURE__ */ new Map();
  try {
    const shortstat = execSync("git diff --shortstat HEAD 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim();
    const filesMatch = shortstat.match(/(\d+)\s+files?\s+changed/);
    const insertionsMatch = shortstat.match(/(\d+)\s+insertions?/);
    const deletionsMatch = shortstat.match(/(\d+)\s+deletions?/);
    const fileCount = filesMatch ? parseInt(filesMatch[1], 10) : 0;
    const lineCount = (insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0) + (deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0);
    if (fileCount > 500 || lineCount > 13e4) {
      if ((process.env.HAC_DEBUG_HOOKS ?? "").trim() !== "") {
        try {
          process.stderr.write(
            `[hac-telemetry] buildUncommittedHashSets: skipping carry-forward \u2014 files=${fileCount} lines=${lineCount}
`
          );
        } catch {
        }
      }
      return result;
    }
  } catch {
  }
  for (const absPath of uncommittedFiles) {
    const relPath = path2.relative(repoRoot, absPath);
    const uncommitted = /* @__PURE__ */ new Set();
    let inHead = true;
    try {
      execFileSync2("git", ["cat-file", "-e", `HEAD:${relPath}`], {
        timeout: 5e3,
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      inHead = false;
    }
    if (inHead) {
      try {
        const diffOut = execFileSync2("git", ["diff", "HEAD", "--", relPath], {
          encoding: "utf-8",
          timeout: 5e3,
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "ignore"]
        });
        for (const line of diffOut.split("\n")) {
          if (!line.startsWith("+") || line.startsWith("+++")) continue;
          const content = line.slice(1);
          if (!normalizeLine(content)) continue;
          uncommitted.add(lineHash(content));
        }
      } catch {
      }
    }
    if (!inHead) {
      try {
        const workingLines = fs2.readFileSync(absPath, "utf-8").split("\n");
        for (const line of workingLines) {
          if (!normalizeLine(line)) continue;
          uncommitted.add(lineHash(line));
        }
      } catch {
        continue;
      }
    }
    result.set(absPath, uncommitted);
  }
  return result;
}
function carryForwardUncommittedFingerprints(oldSha, repoRoot, sourceDir) {
  try {
    const uncommittedRaw = execSync(
      "git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
      { encoding: "utf-8", timeout: 5e3, cwd: repoRoot }
    ).trim();
    if (!uncommittedRaw) return;
    const uncommittedFiles = new Set(
      uncommittedRaw.split("\n").filter(Boolean).map((f) => path2.resolve(repoRoot, f))
    );
    if (uncommittedFiles.size === 0) return;
    const oldDir = sourceDir ?? getCommitDir(oldSha);
    const newDir = getActiveCommitDir();
    if (oldDir === newDir || !fs2.existsSync(oldDir)) return;
    const uncommittedHashes = buildUncommittedHashSets(uncommittedFiles, repoRoot);
    carryForwardFromSourceDir(oldDir, newDir, repoRoot, uncommittedHashes);
  } catch {
  }
}
function carryForwardUncommittedFingerprintsMultiHop(repoRoot, sourceDirs) {
  try {
    if (sourceDirs.length === 0) return;
    const uncommittedRaw = execSync(
      "git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
      { encoding: "utf-8", timeout: 5e3, cwd: repoRoot }
    ).trim();
    if (!uncommittedRaw) return;
    const uncommittedFiles = new Set(
      uncommittedRaw.split("\n").filter(Boolean).map((f) => path2.resolve(repoRoot, f))
    );
    if (uncommittedFiles.size === 0) return;
    const newDir = getActiveCommitDir();
    const uncommittedHashes = buildUncommittedHashSets(uncommittedFiles, repoRoot);
    const seenAiKeys = /* @__PURE__ */ new Set();
    for (const oldDir of sourceDirs) {
      if (oldDir === newDir || !fs2.existsSync(oldDir)) continue;
      const sha = path2.basename(oldDir);
      if (/^[0-9a-f]{40}$/.test(sha)) {
        let isAncestor = false;
        try {
          execFileSync2("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
            timeout: 5e3,
            cwd: repoRoot,
            stdio: "ignore"
          });
          isAncestor = true;
        } catch {
          isAncestor = false;
        }
        if (!isAncestor) continue;
      }
      carryForwardFromSourceDir(oldDir, newDir, repoRoot, uncommittedHashes, seenAiKeys);
    }
  } catch {
  }
}
function carryForwardFromSourceDir(oldDir, newDir, repoRoot, uncommittedHashes, seenAiKeys) {
  try {
    const toAbs = (fp) => path2.isAbsolute(fp) ? fp : path2.resolve(repoRoot, fp);
    const keptAiEditIds = /* @__PURE__ */ new Set();
    const aiCarried = [];
    const aiSrc = path2.join(oldDir, "ai_line_fingerprints.jsonl");
    if (fs2.existsSync(aiSrc)) {
      for (const line of fs2.readFileSync(aiSrc, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.file_path || !entry.line_content_hash) continue;
          const abs = toAbs(entry.file_path);
          const set = uncommittedHashes.get(abs);
          if (!set || !set.has(entry.line_content_hash)) continue;
          if (seenAiKeys) {
            const dedupKey = `${abs}::${entry.line_content_hash}::${entry.edit_id ?? ""}`;
            if (seenAiKeys.has(dedupKey)) {
              if (entry.edit_id) keptAiEditIds.add(entry.edit_id);
              continue;
            }
            seenAiKeys.add(dedupKey);
          }
          aiCarried.push(line);
          if (entry.edit_id) keptAiEditIds.add(entry.edit_id);
        } catch {
        }
      }
    }
    const oldCarried = [];
    const oldLinesSrc = path2.join(oldDir, "deleted_line_fingerprints.jsonl");
    if (fs2.existsSync(oldLinesSrc)) {
      for (const line of fs2.readFileSync(oldLinesSrc, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.edit_id || !keptAiEditIds.has(entry.edit_id)) continue;
          oldCarried.push(line);
        } catch {
        }
      }
    }
    const ckptCarried = [];
    const ckptSrc = path2.join(oldDir, "file_snapshots.jsonl");
    const SNAPSHOT_READ_CAP = 10 * 1024 * 1024;
    if (fs2.existsSync(ckptSrc) && fs2.statSync(ckptSrc).size <= SNAPSHOT_READ_CAP) {
      const groups = /* @__PURE__ */ new Map();
      for (const line of fs2.readFileSync(ckptSrc, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (!e.snapshot_phase || !e.tool_invocation_id || !e.file_path || !e.line_hashes) continue;
          if (e.snapshot_phase !== "pre_ai_edit" && e.snapshot_phase !== "post_ai_edit") continue;
          const key = `${e.tool_invocation_id}::${e.file_path}`;
          const slot = groups.get(key) ?? {};
          const ckpt = {
            raw: line,
            type: e.snapshot_phase,
            file_path: e.file_path,
            line_hashes: e.line_hashes
          };
          if (ckpt.type === "pre_ai_edit") slot.before = ckpt;
          else slot.after = ckpt;
          groups.set(key, slot);
        } catch {
        }
      }
      for (const { before, after } of groups.values()) {
        if (!before || !after) continue;
        const abs = toAbs(after.file_path);
        const uncommitted = uncommittedHashes.get(abs);
        if (!uncommitted || uncommitted.size === 0) continue;
        const beforeSet = new Set(before.line_hashes);
        let hasLive = false;
        for (const h of after.line_hashes) {
          if (beforeSet.has(h)) continue;
          if (uncommitted.has(h)) {
            hasLive = true;
            break;
          }
        }
        if (!hasLive) continue;
        ckptCarried.push(before.raw);
        ckptCarried.push(after.raw);
      }
    }
    if (aiCarried.length + oldCarried.length + ckptCarried.length === 0) return;
    fs2.mkdirSync(newDir, { recursive: true });
    if (aiCarried.length > 0) {
      fs2.appendFileSync(
        path2.join(newDir, "ai_line_fingerprints.jsonl"),
        aiCarried.join("\n") + "\n",
        "utf-8"
      );
    }
    if (oldCarried.length > 0) {
      fs2.appendFileSync(
        path2.join(newDir, "deleted_line_fingerprints.jsonl"),
        oldCarried.join("\n") + "\n",
        "utf-8"
      );
    }
    if (ckptCarried.length > 0) {
      fs2.appendFileSync(
        path2.join(newDir, "file_snapshots.jsonl"),
        ckptCarried.join("\n") + "\n",
        "utf-8"
      );
    }
  } catch {
  }
}
function carryForwardSessionLogs(oldSha, repoRoot) {
  try {
    const oldDir = getCommitDir(oldSha);
    const newDir = getActiveCommitDir();
    if (oldDir === newDir || !fs2.existsSync(oldDir)) return;
    fs2.mkdirSync(newDir, { recursive: true });
    const sessionScopedFiles = [
      "prompt_context.jsonl",
      "task_tool_invocations.jsonl",
      "edits.jsonl",
      "skills.jsonl"
    ];
    for (const name of sessionScopedFiles) {
      const src = path2.join(oldDir, name);
      if (!fs2.existsSync(src)) continue;
      try {
        const content = fs2.readFileSync(src, "utf-8");
        if (!content) continue;
        const toAppend = content.endsWith("\n") ? content : content + "\n";
        fs2.appendFileSync(path2.join(newDir, name), toAppend, "utf-8");
      } catch {
      }
    }
  } catch {
  }
}
function pruneOldCommitDirs(keepCount = 10) {
  const baseDir = getTelemetryBaseDir();
  if (!fs2.existsSync(baseDir)) return;
  const SHA_RE = /^[0-9a-f]{40}$/;
  const dirs = fs2.readdirSync(baseDir).filter((d) => SHA_RE.test(d) && fs2.statSync(path2.join(baseDir, d)).isDirectory()).sort((a, b) => {
    const aTime = fs2.statSync(path2.join(baseDir, a)).mtimeMs;
    const bTime = fs2.statSync(path2.join(baseDir, b)).mtimeMs;
    return bTime - aTime;
  });
  let repoRoot = null;
  try {
    repoRoot = getRepoRootFromGit();
  } catch {
    repoRoot = null;
  }
  for (const dir of dirs.slice(keepCount)) {
    let salvaged = false;
    try {
      if (repoRoot) {
        let isAncestor = false;
        try {
          execFileSync2("git", ["merge-base", "--is-ancestor", dir, "HEAD"], {
            timeout: 5e3,
            cwd: repoRoot,
            stdio: "ignore"
          });
          isAncestor = true;
        } catch {
          isAncestor = false;
        }
        if (isAncestor) {
          try {
            carryForwardUncommittedFingerprints(dir, repoRoot, path2.join(baseDir, dir));
            salvaged = true;
          } catch {
          }
        }
      }
    } catch {
    }
    if (!salvaged) {
      try {
        const emitMarker = path2.join(baseDir, "emitted_shas", dir);
        if (!fs2.existsSync(emitMarker)) {
          const fpFile = path2.join(baseDir, dir, "ai_line_fingerprints.jsonl");
          if (fs2.existsSync(fpFile)) {
            const lost = fs2.readFileSync(fpFile, "utf-8").split("\n").filter((l) => l.trim()).length;
            if (lost > 0) incrementDropCounter("prune_evicted_unemitted", lost);
          }
          const ckptFile = path2.join(baseDir, dir, "file_snapshots.jsonl");
          if (fs2.existsSync(ckptFile)) {
            let lostCkpt = 0;
            for (const line of fs2.readFileSync(ckptFile, "utf-8").split("\n")) {
              if (!line.trim()) continue;
              try {
                const e = JSON.parse(line);
                if (e.snapshot_phase === "post_ai_edit") lostCkpt++;
              } catch {
              }
            }
            if (lostCkpt > 0) incrementDropCounter("prune_evicted_unemitted_snapshots", lostCkpt);
          }
        }
      } catch {
      }
    }
    try {
      fs2.rmSync(path2.join(baseDir, dir), { recursive: true });
    } catch {
    }
  }
}
function getRepoRootFromGit(cwd) {
  if (_cachedRepoRoot !== null) return _cachedRepoRoot;
  try {
    _cachedRepoRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd
    }).trim();
    return _cachedRepoRoot;
  } catch {
    return null;
  }
}
function getGitDirAbsolute(repoRoot) {
  if (_cachedGitDir !== null) return _cachedGitDir;
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim();
    _cachedGitDir = path2.isAbsolute(gitDir) ? gitDir : path2.join(repoRoot, gitDir);
    return _cachedGitDir;
  } catch {
    return null;
  }
}
var CONCURRENT_SESSION_STALE_MS = 45 * 60 * 1e3;
var POINTER_DEBOUNCE_MS = 30 * 1e3;
function getConcurrentSessionsFromPointer(pointer) {
  if (!pointer) return [];
  const out = [];
  if (pointer.concurrent_ai_sessions && pointer.concurrent_ai_sessions.length > 0) {
    for (const e of pointer.concurrent_ai_sessions) {
      if (e?.session_id) out.push(e);
    }
  } else if (pointer.session_id) {
    out.push({
      session_id: pointer.session_id,
      ai_tool: pointer.ai_tool,
      updated_at: pointer.updated_at,
      ai_model: pointer.ai_model
    });
  }
  return out;
}
function pickActiveAiSessionForCommit(pointer) {
  const entries = getConcurrentSessionsFromPointer(pointer);
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  const now = Date.now();
  const fresh = sorted.filter((e) => now - new Date(e.updated_at).getTime() < CONCURRENT_SESSION_STALE_MS);
  const pick = fresh.length > 0 ? fresh[0] : sorted[0];
  return { sessionId: pick.session_id, ai_model: pick.ai_model, ai_tool: pick.ai_tool };
}
function isPidFallback(sessionId) {
  return /^\d+$/.test(sessionId);
}
function listConcurrentSessionsForPayload(pointer) {
  return getConcurrentSessionsFromPointer(pointer).filter((e) => !isPidFallback(e.session_id)).map((e) => ({
    session_id: e.session_id,
    ai_tool: e.ai_tool,
    ...e.ai_model ? { ai_model: e.ai_model } : {}
  }));
}
function readActiveSessionPointerFromPath(pointerPath) {
  try {
    if (!fs2.existsSync(pointerPath)) return null;
    return JSON.parse(fs2.readFileSync(pointerPath, "utf-8"));
  } catch {
    return null;
  }
}
function pruneStaleConcurrentSessions() {
  try {
    const baseDir = getTelemetryBaseDir();
    const pointerPath = path2.join(baseDir, "concurrent_ai_sessions.json");
    if (!fs2.existsSync(pointerPath)) return 0;
    const lockPath = pointerPath + ".lock";
    return withFileLock(lockPath, () => {
      const prev = readActiveSessionPointerFromPath(pointerPath);
      if (!prev) return 0;
      const entries = getConcurrentSessionsFromPointer(prev);
      const now = Date.now();
      const fresh = entries.filter((e) => {
        const ts = new Date(e.updated_at).getTime();
        return Number.isFinite(ts) && now - ts < CONCURRENT_SESSION_STALE_MS;
      });
      if (fresh.length === entries.length) return 0;
      const pointer = {
        session_id: prev.session_id,
        workstream_id: prev.workstream_id,
        ai_tool: prev.ai_tool,
        updated_at: prev.updated_at,
        ...prev.ai_model ? { ai_model: prev.ai_model } : {},
        concurrent_ai_sessions: fresh
      };
      const tmpPath = pointerPath + ".tmp." + process.pid;
      fs2.writeFileSync(tmpPath, JSON.stringify(pointer, null, 2) + "\n", "utf-8");
      fs2.renameSync(tmpPath, pointerPath);
      return entries.length - fresh.length;
    });
  } catch {
    return 0;
  }
}
function readConcurrentSessionPointerForRepo(repoRoot) {
  const gitDir = getGitDirAbsolute(repoRoot);
  if (!gitDir) return null;
  const localPointer = readActiveSessionPointerFromPath(
    path2.join(gitDir, "hac_telemetry", "concurrent_ai_sessions.json")
  );
  const mainGitDir = getMainRepoGitDir();
  if (!mainGitDir || path2.resolve(mainGitDir) === path2.resolve(gitDir)) {
    return localPointer;
  }
  const mainPointer = readActiveSessionPointerFromPath(
    path2.join(mainGitDir, "hac_telemetry", "concurrent_ai_sessions.json")
  );
  if (!mainPointer) return localPointer;
  const localEntries = getConcurrentSessionsFromPointer(localPointer);
  const isUsable = (e) => !!e.session_id && e.ai_tool !== "unknown" && !isPidFallback(e.session_id);
  const localUsable = localEntries.some(isUsable);
  if (localUsable) return localPointer;
  const mainEntries = getConcurrentSessionsFromPointer(mainPointer);
  const mergedById = /* @__PURE__ */ new Map();
  for (const e of [...localEntries, ...mainEntries]) {
    const prev = mergedById.get(e.session_id);
    if (!prev || new Date(e.updated_at).getTime() > new Date(prev.updated_at).getTime()) {
      mergedById.set(e.session_id, e);
    }
  }
  const merged = Array.from(mergedById.values());
  return {
    session_id: mainPointer.session_id || localPointer?.session_id || "",
    workstream_id: mainPointer.workstream_id || localPointer?.workstream_id || computeWorkstreamId(),
    ai_tool: mainPointer.ai_tool || localPointer?.ai_tool || "unknown",
    updated_at: mainPointer.updated_at || localPointer?.updated_at || (/* @__PURE__ */ new Date()).toISOString(),
    ...mainPointer.ai_model ? { ai_model: mainPointer.ai_model } : {},
    concurrent_ai_sessions: merged
  };
}
function resolveSessionId(payload) {
  const p = payload ?? {};
  const resolved = typeof p.conversation_id === "string" && p.conversation_id || typeof p.session_id === "string" && p.session_id || typeof p.thread_id === "string" && p.thread_id || process.env.HOOK_SESSION_ID || process.env.CLAUDE_PPID || process.env.CLAUDE_SESSION_ID || process.env.CURSOR_CONVERSATION_ID || process.env.FACTORY_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.OPENCODE_SESSION_ID || process.env.OPENCODE_SESSIONID || process.env.OPENCODE_CONVERSATION_ID || null;
  if (resolved) return resolved;
  if ((process.env.HAC_DEBUG_HOOKS ?? "").trim() !== "") {
    const checked = [
      "payload.conversation_id",
      "payload.session_id",
      "payload.thread_id",
      "HOOK_SESSION_ID",
      "CLAUDE_PPID",
      "CLAUDE_SESSION_ID",
      "CURSOR_CONVERSATION_ID",
      "FACTORY_SESSION_ID",
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
      "OPENCODE_SESSION_ID",
      "OPENCODE_SESSIONID",
      "OPENCODE_CONVERSATION_ID"
    ];
    try {
      process.stderr.write(`[hac-telemetry] resolveSessionId pid-fallback (none set: ${checked.join(",")})
`);
    } catch {
    }
  }
  return String(process.pid);
}

// src/commit-survival-ho.ts
var DEFAULT_WINDOWS_DAYS = [7, 30];
var MAX_EMITS_PER_RUN = 8;
var MAX_RECORDS_SCANNED = 500;
var GIT_TIMEOUT_MS = 5e3;
var DAY_MS = 24 * 60 * 60 * 1e3;
function git(repoRoot, args) {
  try {
    return execSync2(`git ${args}`, { cwd: repoRoot, encoding: "utf-8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function gitArgs(repoRoot, args) {
  try {
    return execFileSync3("git", args, { cwd: repoRoot, encoding: "utf-8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function isAncestorOfHead(repoRoot, sha) {
  try {
    execFileSync3("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: repoRoot,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "ignore"]
    });
    return "yes";
  } catch (e) {
    const status = e.status;
    return status === 1 ? "no" : "error";
  }
}
function resolveWindows() {
  const raw = (process.env.HAC_SURVIVAL_WINDOWS_DAYS ?? "").trim();
  if (!raw) return DEFAULT_WINDOWS_DAYS;
  const parsed = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : DEFAULT_WINDOWS_DAYS;
}
function readMeasuredState(baseDir) {
  try {
    const p = path3.join(baseDir, "survival_measured.json");
    if (!fs3.existsSync(p)) return {};
    return JSON.parse(fs3.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}
function writeMeasuredState(baseDir, state) {
  try {
    const p = path3.join(baseDir, "survival_measured.json");
    withFileLock(p + ".lock", () => {
      let cur = {};
      try {
        if (fs3.existsSync(p)) cur = JSON.parse(fs3.readFileSync(p, "utf-8"));
      } catch {
        cur = {};
      }
      for (const [sha, windows] of Object.entries(state)) {
        const merged = /* @__PURE__ */ new Set([...cur[sha] ?? [], ...windows]);
        cur[sha] = Array.from(merged).sort((a, b) => a - b);
      }
      try {
        fs3.writeFileSync(p, JSON.stringify(cur), "utf-8");
      } catch {
      }
    });
  } catch {
  }
}
function readCommitRecords() {
  const byShas = /* @__PURE__ */ new Map();
  const tsOf = (r) => {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  for (const baseDir of getTelemetryBaseDirsForRead()) {
    for (const fp of [path3.join(baseDir, "ai_commit_records.jsonl.1"), path3.join(baseDir, "ai_commit_records.jsonl")]) {
      try {
        if (!fs3.existsSync(fp)) continue;
        const lines = fs3.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
        for (const line of lines.slice(-MAX_RECORDS_SCANNED)) {
          try {
            const rec = JSON.parse(line);
            if (!rec.commit_sha) continue;
            if (rec.superseded_by && !("files" in rec)) continue;
            const prior = byShas.get(rec.commit_sha);
            if (!prior || tsOf(rec) >= tsOf(prior)) byShas.set(rec.commit_sha, rec);
          } catch {
          }
        }
      } catch {
      }
    }
  }
  return Array.from(byShas.values());
}
function measureSurviving(repoRoot, commitSha, files) {
  let surviving = 0;
  let anyMeasured = false;
  for (const f of files) {
    if (!f.path || (f.lines_added_total ?? 0) === 0) continue;
    const out = gitArgs(repoRoot, ["blame", "--line-porcelain", "HEAD", "--", f.path]);
    if (out === null) continue;
    anyMeasured = true;
    const prefix = commitSha + " ";
    for (const line of out.split("\n")) {
      if (line.startsWith(prefix)) surviving++;
    }
  }
  return anyMeasured ? surviving : files.some((f) => (f.lines_added_total ?? 0) > 0) ? 0 : null;
}
function commitAuthor(repoRoot, sha) {
  const out = git(repoRoot, `show -s --format=%ae%n%an ${sha}`);
  if (!out) return null;
  const [email, name] = out.split("\n");
  return { email: email ?? "", name: name ?? "" };
}
function runSurvivalSweep(repoRoot) {
  try {
    const baseDir = getTelemetryBaseDir();
    const records = readCommitRecords();
    if (records.length === 0) return;
    const windows = resolveWindows();
    const skipAgeDays = Math.max(...windows, 0) * 2;
    const measured = readMeasuredState(baseDir);
    const newlyMeasured = {};
    const context = buildContext("survival-sweep");
    const now = Date.now();
    let emits = 0;
    for (const rec of records) {
      if (emits >= MAX_EMITS_PER_RUN) break;
      const added2 = rec.lines_added_total ?? 0;
      if (added2 === 0) continue;
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      const daysElapsed = Math.floor((now - ts) / DAY_MS);
      const already = new Set(measured[rec.commit_sha] ?? []);
      for (const window of windows) {
        if (emits >= MAX_EMITS_PER_RUN) break;
        if (already.has(window)) continue;
        if (daysElapsed < window) continue;
        const ancestry = isAncestorOfHead(repoRoot, rec.commit_sha);
        if (ancestry === "error") {
          continue;
        }
        if (ancestry === "no") {
          if (daysElapsed >= skipAgeDays) {
            (newlyMeasured[rec.commit_sha] ??= []).push(window);
          }
          continue;
        }
        const surviving = measureSurviving(repoRoot, rec.commit_sha, rec.files ?? []);
        if (surviving === null) {
          (newlyMeasured[rec.commit_sha] ??= []).push(window);
          continue;
        }
        const clampedSurviving = Math.min(surviving, added2);
        const churned = Math.max(0, added2 - clampedSurviving);
        const aiAdded = rec.ai_authored_lines_added ?? 0;
        const aiPer = added2 > 0 ? aiAdded / added2 : 0;
        const author = commitAuthor(repoRoot, rec.commit_sha);
        if (!author || !isValidAuthorEmail(author.email)) {
          (newlyMeasured[rec.commit_sha] ??= []).push(window);
          continue;
        }
        const event = {
          event: "commit_survival_trace",
          commit_sha: rec.commit_sha,
          repo: { name: context.repo.name, branch: context.repo.branch },
          author,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          window_days: window,
          days_elapsed: daysElapsed,
          ai_per: aiPer,
          lines: {
            added_total: added2,
            ai_authored_added: aiAdded,
            surviving: clampedSurviving,
            churned
          },
          survival_rate: added2 > 0 ? clampedSurviving / added2 : 0
        };
        let alreadySent = false;
        try {
          withFileLock(path3.join(baseDir, "survival_measured.json.lock"), () => {
            const cur = readMeasuredState(baseDir);
            if ((cur[rec.commit_sha] ?? []).includes(window)) alreadySent = true;
          });
        } catch {
        }
        if (alreadySent) continue;
        try {
          sendEvent(event);
        } catch {
        }
        (newlyMeasured[rec.commit_sha] ??= []).push(window);
        emits++;
      }
    }
    if (Object.keys(newlyMeasured).length > 0) writeMeasuredState(baseDir, newlyMeasured);
  } catch {
  }
}
function main() {
  const watchdog = installHookWatchdog(8e3);
  try {
    const repoRoot = process.argv[2] || process.cwd();
    runSurvivalSweep(repoRoot);
  } catch {
  } finally {
    clearTimeout(watchdog);
  }
}
var invokedDirectly = (() => {
  try {
    return process.argv[1] ? process.argv[1].includes("commit-survival-ho") : false;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();

// src/attribution-v3-ho.ts
import { execFileSync as execFileSync4 } from "child_process";
function git2(repoRoot, args) {
  try {
    return execFileSync4("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function objectLines(repoRoot, spec) {
  const out = git2(repoRoot, ["cat-file", "-p", spec]);
  if (out === null) return null;
  const lines = out.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function multiset(lines) {
  const m = /* @__PURE__ */ new Map();
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    m.set(line, (m.get(line) ?? 0) + 1);
  }
  return m;
}
function added(from, to) {
  const out = /* @__PURE__ */ new Map();
  for (const [line, n] of to) {
    const diff = n - (from.get(line) ?? 0);
    if (diff > 0) out.set(line, diff);
  }
  return out;
}
function intersectionSize(a, b) {
  let total = 0;
  for (const [line, n] of a) {
    const m = b.get(line) ?? 0;
    if (m > 0) total += Math.min(n, m);
  }
  return total;
}
function sumCounts(m) {
  let t = 0;
  for (const n of m.values()) t += n;
  return t;
}
function computeBlobAttribution(input) {
  const { repoRoot, files, aiBlobByPath, parentRef } = input;
  const results = [];
  for (const f of files) {
    const op = f.operation ?? "unknown";
    const parentSpec = f.rename_from ? `${parentRef}:${f.rename_from}` : `${parentRef}:${f.path}`;
    const aLines = op === "create" ? [] : objectLines(repoRoot, parentSpec) ?? [];
    const cLines = op === "delete" ? [] : objectLines(repoRoot, `HEAD:${f.path}`) ?? [];
    const A = multiset(aLines);
    const C = multiset(cLines);
    const addedAC = added(A, C);
    const deletedAC = added(C, A);
    const linesAddedTotal = sumCounts(addedAC);
    const linesDeletedTotal = sumCounts(deletedAC);
    const aiSha = aiBlobByPath.get(f.path);
    if (!aiSha) {
      results.push({
        path: f.path,
        operation: op,
        ai_lines_added: 0,
        ai_lines_deleted: 0,
        human_lines_added: linesAddedTotal,
        drafted_then_human_edited: 0,
        lines_added_total: linesAddedTotal,
        lines_deleted_total: linesDeletedTotal,
        ai_per: 0,
        has_ai_blob: false
      });
      continue;
    }
    const bLines = objectLines(repoRoot, aiSha) ?? [];
    const B = multiset(bLines);
    const addedAB = added(A, B);
    const deletedAB = added(B, A);
    const aiLinesAdded = intersectionSize(addedAC, addedAB);
    const aiLinesDeleted = intersectionSize(deletedAC, deletedAB);
    const humanLinesAdded = Math.max(0, linesAddedTotal - aiLinesAdded);
    const draftedThenEdited = Math.max(0, sumCounts(addedAB) - intersectionSize(addedAB, C));
    const aiPer = linesAddedTotal > 0 ? aiLinesAdded / linesAddedTotal : 0;
    results.push({
      path: f.path,
      operation: op,
      ai_lines_added: aiLinesAdded,
      ai_lines_deleted: aiLinesDeleted,
      human_lines_added: humanLinesAdded,
      drafted_then_human_edited: draftedThenEdited,
      lines_added_total: linesAddedTotal,
      lines_deleted_total: linesDeletedTotal,
      ai_per: +aiPer.toFixed(3),
      has_ai_blob: true
    });
  }
  const sum = (k) => results.reduce((s, r) => s + r[k], 0);
  const totalAdded = sum("lines_added_total");
  const totalAiAdded = sum("ai_lines_added");
  return {
    files: results,
    ai_lines_added: totalAiAdded,
    ai_lines_deleted: sum("ai_lines_deleted"),
    human_lines_added: sum("human_lines_added"),
    drafted_then_human_edited: sum("drafted_then_human_edited"),
    lines_added_total: totalAdded,
    lines_deleted_total: sum("lines_deleted_total"),
    ai_per: totalAdded > 0 ? +(totalAiAdded / totalAdded).toFixed(3) : 0
  };
}

// src/post-commit-telemetry-ho.ts
function getRepoRoot() {
  if (process.argv[2]) return process.argv[2];
  try {
    return execSync3("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
  } catch {
    return null;
  }
}
function isCherryPick(repoRoot) {
  const reflogEnv = (process.env.GIT_REFLOG_ACTION ?? "").toLowerCase();
  if (reflogEnv.includes("cherry-pick")) return true;
  try {
    const subj = execFileSync5("git", ["reflog", "-1", "--format=%gs"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    return /^cherry-pick/.test(subj);
  } catch {
    return false;
  }
}
function resolveCherryPickSource(repoRoot, newSha, commitMessage) {
  const xMatch = commitMessage.match(/\(cherry picked from commit ([0-9a-f]{7,40})\)/i);
  if (xMatch?.[1]) {
    const full = resolveToFullSha(repoRoot, xMatch[1]);
    if (full) return full;
  }
  try {
    const subj = execFileSync5("git", ["reflog", "-1", "--format=%gs"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const m = subj.match(/cherry-pick[:\s]+.*?([0-9a-f]{7,40})/i);
    if (m?.[1]) {
      const full = resolveToFullSha(repoRoot, m[1]);
      if (full && full !== newSha) return full;
    }
  } catch {
  }
  return patchIdSourceScan(repoRoot, newSha);
}
function resolveToFullSha(repoRoot, ref) {
  try {
    const out = execFileSync5("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
function patchIdOf(repoRoot, sha) {
  try {
    const diff = execFileSync5("git", ["diff-tree", "-p", "--no-color", sha], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (!diff) return null;
    const out = execFileSync5("git", ["patch-id", "--stable"], {
      cwd: repoRoot,
      input: diff,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    const id = out.split(/\s+/)[0];
    return id || null;
  } catch {
    return null;
  }
}
function patchIdSourceScan(repoRoot, newSha) {
  const deadline = Date.now() + 3e3;
  const target = patchIdOf(repoRoot, newSha);
  if (!target) return null;
  let branches = [];
  try {
    branches = execFileSync5("git", ["for-each-ref", "--format=%(refname)", "refs/heads/"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().split("\n").filter(Boolean).slice(0, 10);
  } catch {
    return null;
  }
  for (const branch of branches) {
    if (Date.now() > deadline) return null;
    let shas = [];
    try {
      shas = execFileSync5("git", ["rev-list", "--max-count=20", branch, `^${newSha}`], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 3e3,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim().split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const sha of shas) {
      if (Date.now() > deadline) return null;
      if (sha === newSha) continue;
      if (patchIdOf(repoRoot, sha) === target) return sha;
    }
  }
  return null;
}
function collectCarryForwardSourceDirs(parentSha) {
  const baseDir = getTelemetryBaseDir();
  if (!fs4.existsSync(baseDir)) return [];
  const SHA_RE = /^[0-9a-f]{40}$/;
  const activeDir = path4.resolve(getActiveCommitDir());
  const parentDir = parentSha && parentSha !== "initial" ? path4.resolve(path4.join(baseDir, parentSha)) : null;
  let shaDirs = [];
  try {
    shaDirs = fs4.readdirSync(baseDir).filter((d) => SHA_RE.test(d)).map((d) => path4.resolve(path4.join(baseDir, d))).filter((p) => {
      try {
        return fs4.statSync(p).isDirectory();
      } catch {
        return false;
      }
    }).sort((a, b) => {
      const at = (() => {
        try {
          return fs4.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      })();
      const bt = (() => {
        try {
          return fs4.statSync(b).mtimeMs;
        } catch {
          return 0;
        }
      })();
      return bt - at;
    });
  } catch {
    return parentDir && parentDir !== activeDir ? [parentDir] : [];
  }
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (p) => {
    if (!p || p === activeDir || seen.has(p)) return;
    seen.add(p);
    ordered.push(p);
  };
  push(parentDir);
  for (const p of shaDirs) push(p);
  return ordered.slice(0, 10);
}
function getHeadSha2(repoRoot) {
  try {
    return execSync3("git rev-parse HEAD", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim();
  } catch {
    return null;
  }
}
function getCommitDiff(repoRoot) {
  try {
    const output = execSync3("git diff-tree --root --no-commit-id --numstat -M -r HEAD", {
      encoding: "utf-8",
      timeout: 1e4,
      cwd: repoRoot
    }).trim();
    if (!output) return null;
    const entries = [];
    for (const line of output.split("\n")) {
      const parts = line.split("	");
      if (parts.length < 3) continue;
      const [added2, deleted, ...pathParts] = parts;
      let filePath = pathParts.join("	");
      if (added2 === "-" || deleted === "-") continue;
      if (filePath.includes(" => ")) {
        const braceMatch = filePath.match(/^(.*?)\{([^}]* => [^}]*)\}(.*)$/);
        if (braceMatch) {
          const newPart = braceMatch[2].split(" => ")[1];
          filePath = (braceMatch[1] + newPart + braceMatch[3]).replace(/\/{2,}/g, "/");
        } else {
          const arrowIdx = filePath.indexOf(" => ");
          if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4);
        }
      }
      const linesAdded = parseInt(added2, 10);
      const linesDeleted = parseInt(deleted, 10);
      if (isNaN(linesAdded) || isNaN(linesDeleted)) continue;
      entries.push({ linesAdded, linesDeleted, filePath });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}
function getCommitRenames(repoRoot, isMerge) {
  const renames = /* @__PURE__ */ new Map();
  try {
    const base = isMerge ? "git diff -M HEAD^1...HEAD" : "git diff-tree --root --no-commit-id -M -r HEAD";
    const out = execSync3(`${base} --diff-filter=R --name-status`, {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim();
    if (!out) return renames;
    for (const line of out.split("\n")) {
      const parts = line.split("	");
      if (parts.length >= 3 && parts[0].startsWith("R")) {
        renames.set(parts[2], parts[1]);
      }
    }
  } catch {
  }
  return renames;
}
function getCommitFileOperations(repoRoot, isMerge) {
  const ops = /* @__PURE__ */ new Map();
  try {
    const base = isMerge ? "git diff -M HEAD^1...HEAD" : "git diff-tree --root --no-commit-id -M -r HEAD";
    const out = execSync3(`${base} --name-status`, {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim();
    if (!out) return ops;
    for (const line of out.split("\n")) {
      const parts = line.split("	");
      const code = parts[0] ?? "";
      if (code.startsWith("R") && parts.length >= 3) {
        ops.set(parts[2], { op: "rename", rename_from: parts[1] });
      } else if (code.startsWith("A") && parts.length >= 2) {
        ops.set(parts[1], { op: "create" });
      } else if (code.startsWith("D") && parts.length >= 2) {
        ops.set(parts[1], { op: "delete" });
      } else if (code.startsWith("M") && parts.length >= 2) {
        ops.set(parts[1], { op: "modify" });
      }
    }
  } catch {
  }
  return ops;
}
function getCommitFileStats(repoRoot, isMerge) {
  try {
    const base = isMerge ? "git diff -M20% HEAD^1...HEAD" : "git diff-tree --root --no-commit-id -M20% -r HEAD";
    const countFilter = (filter) => {
      const out = execSync3(`${base} --diff-filter=${filter} --name-only`, {
        encoding: "utf-8",
        timeout: 5e3,
        cwd: repoRoot
      }).trim();
      return out ? out.split("\n").filter((f) => f && !isGeneratedFile(f)).length : 0;
    };
    return { created: countFilter("A"), deleted: countFilter("D") };
  } catch {
    return { created: 0, deleted: 0 };
  }
}
function isMergeCommit(repoRoot) {
  try {
    const output = execSync3("git rev-list --parents -1 HEAD", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim();
    const parts = output.split(/\s+/);
    return parts.length > 2;
  } catch {
    return false;
  }
}
function getMergeDiff(repoRoot) {
  try {
    const output = execSync3("git diff --numstat HEAD^1...HEAD", {
      encoding: "utf-8",
      timeout: 1e4,
      cwd: repoRoot
    }).trim();
    if (!output) return null;
    const entries = [];
    for (const line of output.split("\n")) {
      const parts = line.split("	");
      if (parts.length < 3) continue;
      const [added2, deleted, ...pathParts] = parts;
      const filePath = pathParts.join("	");
      if (added2 === "-" || deleted === "-") continue;
      const linesAdded = parseInt(added2, 10);
      const linesDeleted = parseInt(deleted, 10);
      if (isNaN(linesAdded) || isNaN(linesDeleted)) continue;
      entries.push({ linesAdded, linesDeleted, filePath });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}
function parseCommitHunks(repoRoot, isMerge) {
  const addedByFile = /* @__PURE__ */ new Map();
  const deletedByFile = /* @__PURE__ */ new Map();
  try {
    const cmd = isMerge ? "git diff --unified=0 --no-color HEAD^1...HEAD" : "git show --format= --unified=0 --no-color HEAD";
    const output = execSync3(cmd, {
      encoding: "utf-8",
      timeout: 1e4,
      cwd: repoRoot
    });
    let currentFile = null;
    let pendingDeleteFile = null;
    let hunkNewStart = 0;
    let hunkOldStart = 0;
    let hunkNewOffset = 0;
    let hunkOldOffset = 0;
    for (const rawLine of output.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("+++ ")) {
        const match = line.match(/^\+\+\+ b\/(.+)$/);
        if (match) {
          currentFile = match[1];
          pendingDeleteFile = null;
        } else if (line === "+++ /dev/null" && pendingDeleteFile) {
          currentFile = pendingDeleteFile;
          pendingDeleteFile = null;
        } else {
          currentFile = null;
          pendingDeleteFile = null;
        }
        continue;
      }
      if (line.startsWith("--- ")) {
        const delMatch = line.match(/^--- a\/(.+)$/);
        pendingDeleteFile = delMatch ? delMatch[1] : null;
        continue;
      }
      if (!currentFile) continue;
      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          hunkOldStart = Math.max(0, parseInt(hunkMatch[1], 10) - 1);
          hunkNewStart = Math.max(0, parseInt(hunkMatch[2], 10) - 1);
          hunkNewOffset = 0;
          hunkOldOffset = 0;
        }
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const arr = addedByFile.get(currentFile) ?? [];
        arr.push({ content: line.slice(1), hunkStart: hunkNewStart + hunkNewOffset });
        addedByFile.set(currentFile, arr);
        hunkNewOffset++;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        const arr = deletedByFile.get(currentFile) ?? [];
        arr.push({ content: line.slice(1), hunkStart: hunkOldStart + hunkOldOffset });
        deletedByFile.set(currentFile, arr);
        hunkOldOffset++;
        continue;
      }
    }
  } catch {
  }
  return { addedByFile, deletedByFile };
}
function readPreLintDiff(repoRoot, commitTime) {
  const addedByFile = /* @__PURE__ */ new Map();
  try {
    let patchPath = null;
    let tsPath = null;
    for (const hacDir of getTelemetryBaseDirsForRead()) {
      const candidate = path4.join(hacDir, "pre_lint_diff.patch");
      if (fs4.existsSync(candidate)) {
        patchPath = candidate;
        tsPath = path4.join(hacDir, "pre_lint_diff.timestamp");
        break;
      }
    }
    if (!patchPath) return addedByFile;
    if (tsPath && fs4.existsSync(tsPath)) {
      try {
        const tsStr = fs4.readFileSync(tsPath, "utf-8").trim();
        const snapTime = new Date(tsStr);
        const ageDiffMs = commitTime.getTime() - snapTime.getTime();
        if (ageDiffMs > 5 * 60 * 1e3) return addedByFile;
      } catch {
        return addedByFile;
      }
    }
    const patch = fs4.readFileSync(patchPath, "utf-8");
    let currentFile = null;
    let hunkNewStart = 0;
    let hunkNewOffset = 0;
    for (const rawLine of patch.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("+++ ")) {
        const match = line.match(/^\+\+\+ b\/(.+)$/);
        currentFile = match ? match[1] : null;
        continue;
      }
      if (line.startsWith("--- ")) continue;
      if (!currentFile) continue;
      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          hunkNewStart = Math.max(0, parseInt(hunkMatch[1], 10) - 1);
          hunkNewOffset = 0;
        }
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const arr = addedByFile.get(currentFile) ?? [];
        arr.push({ content: line.slice(1), hunkStart: hunkNewStart + hunkNewOffset });
        addedByFile.set(currentFile, arr);
        hunkNewOffset++;
      }
    }
  } catch {
  }
  return addedByFile;
}
function buildNormalizedIndex(fileLines) {
  const index = /* @__PURE__ */ new Map();
  for (let i = 0; i < fileLines.length; i++) {
    const norm = normalizeLine(fileLines[i]);
    if (!norm) continue;
    let indices = index.get(norm);
    if (!indices) {
      indices = [];
      index.set(norm, indices);
    }
    indices.push(i);
  }
  return index;
}
function findLineInIndexedFile(index, line, usedIndices, hintPosition) {
  const normalized = normalizeLine(line);
  const candidates = index.get(normalized);
  if (!candidates || candidates.length === 0) return -1;
  const unused = candidates.filter((idx) => !usedIndices.has(idx));
  const pool = unused.length > 0 ? unused : candidates;
  if (hintPosition !== void 0 && pool.length > 1) {
    let best = pool[0];
    let bestDist = Math.abs(pool[0] - hintPosition);
    for (let i = 1; i < pool.length; i++) {
      const dist = Math.abs(pool[i] - hintPosition);
      if (dist < bestDist) {
        best = pool[i];
        bestDist = dist;
      }
    }
    return best;
  }
  return pool[0];
}
function getCachedFileLines(fileCache, repoRoot, ref, filePath) {
  const key = `${ref}:${filePath}`;
  let lines = fileCache.get(key);
  if (!lines) {
    try {
      const content = execFileSync5("git", ["show", `${ref}:${filePath}`], {
        encoding: "utf-8",
        timeout: 1e4,
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"]
      });
      lines = content.split("\n");
    } catch {
      lines = [];
    }
    fileCache.set(key, lines);
  }
  return lines;
}
function resolveSessionFromEnv() {
  const env = process.env;
  const hasEnvSignal = !!env.HOOK_SESSION_ID || !!env.CLAUDE_PPID || !!env.CLAUDE_SESSION_ID || !!env.CURSOR_SESSION_ID || !!env.CURSOR_CONVERSATION_ID || !!env.FACTORY_SESSION_ID || !!env.CODEX_THREAD_ID || !!env.CODEX_SESSION_ID;
  if (!hasEnvSignal) return null;
  const sessionId = resolveSessionId();
  if (!sessionId || sessionId === String(process.pid)) return null;
  return { sessionId, resolution: "env" };
}
function resolveSessionFromPointer(repoRoot) {
  try {
    const pointer = readConcurrentSessionPointerForRepo(repoRoot);
    if (!pointer) return null;
    const entries = getConcurrentSessionsFromPointer(pointer);
    if (entries.length === 0) return null;
    const anyFresh = entries.some(
      (e) => Date.now() - new Date(e.updated_at).getTime() < CONCURRENT_SESSION_STALE_MS
    );
    if (!anyFresh) return null;
    const primary = pickActiveAiSessionForCommit(pointer);
    if (!primary?.sessionId) return null;
    return { sessionId: primary.sessionId, model: primary.ai_model, resolution: "pointer" };
  } catch {
    return null;
  }
}
var CHECKPOINT_LINK_WINDOW_MS = 24 * 60 * 60 * 1e3;
var BLOB_GATE_MAX_LOOKUPS = 16;
function resolveSessionFromCheckpoints(repoRoot, committedFiles) {
  if (committedFiles.size === 0) return null;
  try {
    const now = Date.now();
    const committedBlobCache = /* @__PURE__ */ new Map();
    let blobLookups = 0;
    const committedBlobFor = (relPath) => {
      if (committedBlobCache.has(relPath)) return committedBlobCache.get(relPath);
      if (blobLookups >= BLOB_GATE_MAX_LOOKUPS) return null;
      blobLookups++;
      let blob = null;
      try {
        const out = execFileSync5("git", ["ls-tree", "HEAD", "--", relPath], {
          encoding: "utf-8",
          timeout: 5e3,
          cwd: repoRoot
        }).trim();
        const m = out.match(/^\S+\s+\S+\s+(\S+)\t/);
        blob = m ? m[1] : null;
      } catch {
        blob = null;
      }
      committedBlobCache.set(relPath, blob);
      return blob;
    };
    let best = null;
    for (const hacDir of getTelemetryBaseDirsForRead()) {
      let subdirs;
      try {
        subdirs = fs4.readdirSync(hacDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subdirs) {
        if (!sub.isDirectory()) continue;
        const fpFile = path4.join(hacDir, sub.name, "file_snapshots.jsonl");
        if (!fs4.existsSync(fpFile)) continue;
        let lines;
        try {
          lines = fs4.readFileSync(fpFile, "utf-8").split("\n");
        } catch {
          continue;
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          let cp;
          try {
            cp = JSON.parse(line);
          } catch {
            continue;
          }
          if (cp.snapshot_phase !== "post_ai_edit" || !cp.session_id) continue;
          if (!cp.file_path) continue;
          const relPath = committedFiles.has(cp.file_path) ? cp.file_path : committedFiles.has(path4.relative(repoRoot, cp.file_path)) ? path4.relative(repoRoot, cp.file_path) : null;
          if (!relPath) continue;
          const ts = cp.timestamp ? new Date(cp.timestamp).getTime() : NaN;
          if (!Number.isFinite(ts) || now - ts > CHECKPOINT_LINK_WINDOW_MS) continue;
          if (cp.post_blob_sha) {
            const committedBlob = committedBlobFor(relPath);
            if (committedBlob && committedBlob !== cp.post_blob_sha) continue;
          }
          if (!best || ts > best.ts) best = { sessionId: cp.session_id, ai_tool: cp.ai_tool, ts };
        }
      }
    }
    if (!best) return null;
    return { sessionId: best.sessionId, ai_tool: best.ai_tool, resolution: "checkpoint" };
  } catch {
    return null;
  }
}
function buildAiBlobByPath(repoRoot, committedFiles) {
  const out = /* @__PURE__ */ new Map();
  const tsByPath = /* @__PURE__ */ new Map();
  try {
    for (const hacDir of getTelemetryBaseDirsForRead()) {
      let subdirs;
      try {
        subdirs = fs4.readdirSync(hacDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subdirs) {
        if (!sub.isDirectory()) continue;
        const fpFile = path4.join(hacDir, sub.name, "file_snapshots.jsonl");
        if (!fs4.existsSync(fpFile)) continue;
        let lines;
        try {
          lines = fs4.readFileSync(fpFile, "utf-8").split("\n");
        } catch {
          continue;
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          let cp;
          try {
            cp = JSON.parse(line);
          } catch {
            continue;
          }
          if (cp.snapshot_phase !== "post_ai_edit" || !cp.post_blob_sha || !cp.file_path) continue;
          const rel = committedFiles.has(cp.file_path) ? cp.file_path : committedFiles.has(path4.relative(repoRoot, cp.file_path)) ? path4.relative(repoRoot, cp.file_path) : null;
          if (!rel) continue;
          const ts = cp.timestamp ? new Date(cp.timestamp).getTime() : 0;
          if (ts >= (tsByPath.get(rel) ?? -1)) {
            tsByPath.set(rel, ts);
            out.set(rel, cp.post_blob_sha);
          }
        }
      }
    }
  } catch {
  }
  return out;
}
function resolveSession(repoRoot, committedFiles) {
  const envResult = resolveSessionFromEnv();
  if (envResult) return envResult;
  const pointerResult = resolveSessionFromPointer(repoRoot);
  if (pointerResult) return pointerResult;
  if (committedFiles) {
    const cpResult = resolveSessionFromCheckpoints(repoRoot, committedFiles);
    if (cpResult) return cpResult;
  }
  return null;
}
function buildCarryForwardSet(aiEntries, oldEntries) {
  const carryForward = /* @__PURE__ */ new Set();
  const aiByEditId = /* @__PURE__ */ new Map();
  for (const entry of aiEntries) {
    if (!entry.edit_id) continue;
    let hashes = aiByEditId.get(entry.edit_id);
    if (!hashes) {
      hashes = /* @__PURE__ */ new Set();
      aiByEditId.set(entry.edit_id, hashes);
    }
    hashes.add(entry.line_content_hash);
  }
  const oldByEditId = /* @__PURE__ */ new Map();
  for (const entry of oldEntries) {
    if (!entry.edit_id) continue;
    let hashes = oldByEditId.get(entry.edit_id);
    if (!hashes) {
      hashes = /* @__PURE__ */ new Set();
      oldByEditId.set(entry.edit_id, hashes);
    }
    hashes.add(entry.line_content_hash);
  }
  for (const [editId, aiHashes] of aiByEditId) {
    const oldHashes = oldByEditId.get(editId);
    if (!oldHashes) continue;
    for (const hash of aiHashes) {
      if (oldHashes.has(hash)) {
        carryForward.add(`${editId}:${hash}`);
      }
    }
  }
  return carryForward;
}
function buildAiMultisets(aiEntries, carryForwardSet, repoRoot) {
  const trigramByFile = /* @__PURE__ */ new Map();
  const lineOnlyByFile = /* @__PURE__ */ new Map();
  const lineOnlyWsNormByFile = /* @__PURE__ */ new Map();
  const agentByTrigramByFile = /* @__PURE__ */ new Map();
  const agentByLineHashByFile = /* @__PURE__ */ new Map();
  const agentByLineHashWsNormByFile = /* @__PURE__ */ new Map();
  const kindByTrigramByFile = /* @__PURE__ */ new Map();
  const kindByLineHashByFile = /* @__PURE__ */ new Map();
  const kindByLineHashWsNormByFile = /* @__PURE__ */ new Map();
  for (const entry of aiEntries) {
    if (entry.edit_id && carryForwardSet.has(`${entry.edit_id}:${entry.line_content_hash}`)) continue;
    const relPath = path4.isAbsolute(entry.file_path) ? path4.relative(repoRoot, entry.file_path) : entry.file_path;
    if (!relPath || relPath.startsWith("..")) continue;
    const agent = entry.ai_tool || "unknown";
    const kind = entry.edit_kind || "agent";
    if (entry.line_context_hash) {
      if (!trigramByFile.has(relPath)) trigramByFile.set(relPath, /* @__PURE__ */ new Map());
      const tMap = trigramByFile.get(relPath);
      tMap.set(entry.line_context_hash, (tMap.get(entry.line_context_hash) ?? 0) + 1);
      if (!agentByTrigramByFile.has(relPath)) agentByTrigramByFile.set(relPath, /* @__PURE__ */ new Map());
      const aMap = agentByTrigramByFile.get(relPath);
      if (!aMap.has(entry.line_context_hash)) aMap.set(entry.line_context_hash, /* @__PURE__ */ new Map());
      const trigramAuthorCounts = aMap.get(entry.line_context_hash);
      trigramAuthorCounts.set(agent, (trigramAuthorCounts.get(agent) ?? 0) + 1);
      if (!kindByTrigramByFile.has(relPath)) kindByTrigramByFile.set(relPath, /* @__PURE__ */ new Map());
      const kMap = kindByTrigramByFile.get(relPath);
      if (!kMap.has(entry.line_context_hash)) kMap.set(entry.line_context_hash, /* @__PURE__ */ new Map());
      const trigramKindCounts = kMap.get(entry.line_context_hash);
      trigramKindCounts.set(kind, (trigramKindCounts.get(kind) ?? 0) + 1);
    }
    if (entry.line_content_hash) {
      if (!lineOnlyByFile.has(relPath)) lineOnlyByFile.set(relPath, /* @__PURE__ */ new Map());
      const lMap = lineOnlyByFile.get(relPath);
      lMap.set(entry.line_content_hash, (lMap.get(entry.line_content_hash) ?? 0) + 1);
      if (!agentByLineHashByFile.has(relPath)) agentByLineHashByFile.set(relPath, /* @__PURE__ */ new Map());
      const aMap = agentByLineHashByFile.get(relPath);
      if (!aMap.has(entry.line_content_hash)) aMap.set(entry.line_content_hash, /* @__PURE__ */ new Map());
      const lineAuthorCounts = aMap.get(entry.line_content_hash);
      lineAuthorCounts.set(agent, (lineAuthorCounts.get(agent) ?? 0) + 1);
      if (!kindByLineHashByFile.has(relPath)) kindByLineHashByFile.set(relPath, /* @__PURE__ */ new Map());
      const lkMap = kindByLineHashByFile.get(relPath);
      if (!lkMap.has(entry.line_content_hash)) lkMap.set(entry.line_content_hash, /* @__PURE__ */ new Map());
      const lineKindCounts = lkMap.get(entry.line_content_hash);
      lineKindCounts.set(kind, (lineKindCounts.get(kind) ?? 0) + 1);
      const wsNormHash = entry.ws_norm_content_hash;
      if (wsNormHash) {
        if (!lineOnlyWsNormByFile.has(relPath)) lineOnlyWsNormByFile.set(relPath, /* @__PURE__ */ new Map());
        const wsMap = lineOnlyWsNormByFile.get(relPath);
        wsMap.set(wsNormHash, (wsMap.get(wsNormHash) ?? 0) + 1);
        if (!agentByLineHashWsNormByFile.has(relPath)) agentByLineHashWsNormByFile.set(relPath, /* @__PURE__ */ new Map());
        const wsAMap = agentByLineHashWsNormByFile.get(relPath);
        if (!wsAMap.has(wsNormHash)) wsAMap.set(wsNormHash, /* @__PURE__ */ new Map());
        const wsAuthorCounts = wsAMap.get(wsNormHash);
        wsAuthorCounts.set(agent, (wsAuthorCounts.get(agent) ?? 0) + 1);
        if (!kindByLineHashWsNormByFile.has(relPath)) kindByLineHashWsNormByFile.set(relPath, /* @__PURE__ */ new Map());
        const wsKMap = kindByLineHashWsNormByFile.get(relPath);
        if (!wsKMap.has(wsNormHash)) wsKMap.set(wsNormHash, /* @__PURE__ */ new Map());
        const wsKindCounts = wsKMap.get(wsNormHash);
        wsKindCounts.set(kind, (wsKindCounts.get(kind) ?? 0) + 1);
      }
    }
  }
  return { trigramByFile, lineOnlyByFile, lineOnlyWsNormByFile, agentByTrigramByFile, agentByLineHashByFile, agentByLineHashWsNormByFile, kindByTrigramByFile, kindByLineHashByFile, kindByLineHashWsNormByFile };
}
function loadFailureRecords() {
  const out = [];
  try {
    for (const hacDir of getTelemetryBaseDirsForRead()) {
      let subdirs;
      try {
        subdirs = fs4.readdirSync(hacDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subdirs) {
        if (!sub.isDirectory()) continue;
        const fpFile = path4.join(hacDir, sub.name, "tool_failures.jsonl");
        if (!fs4.existsSync(fpFile)) continue;
        try {
          for (const line of fs4.readFileSync(fpFile, "utf-8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              out.push(o);
            } catch {
            }
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return out;
}
var FAILURE_WINDOW_MS = 12e4;
function applyFailureInvalidation(oldEntries, checkpointEntries, failures, repoRoot) {
  if (failures.length === 0) return { oldEntries, checkpointEntries };
  const failedToolUseIds = /* @__PURE__ */ new Set();
  const failuresByFile = /* @__PURE__ */ new Map();
  const relOf = (p) => p ? path4.isAbsolute(p) ? path4.relative(repoRoot, p) : p : "";
  for (const f of failures) {
    if (f.tool_use_id) failedToolUseIds.add(f.tool_use_id);
    const rel = relOf(f.file_path);
    if (rel) {
      const t = f.timestamp ? new Date(f.timestamp).getTime() : NaN;
      if (Number.isFinite(t)) {
        const arr = failuresByFile.get(rel) ?? [];
        arr.push(t);
        failuresByFile.set(rel, arr);
      }
    }
  }
  const succeededInvocations = /* @__PURE__ */ new Set();
  for (const cp of checkpointEntries) {
    if (cp.snapshot_phase === "post_ai_edit" && cp.tool_invocation_id) {
      succeededInvocations.add(cp.tool_invocation_id);
    }
  }
  const fileWindowMatch = (recPath, recTs) => {
    const rel = relOf(recPath);
    const times = failuresByFile.get(rel);
    if (!times) return false;
    const t = recTs ? new Date(recTs).getTime() : NaN;
    if (!Number.isFinite(t)) return false;
    return times.some((ft) => ft >= t && ft <= t + FAILURE_WINDOW_MS);
  };
  const filteredOld = oldEntries.filter((e) => {
    if (e.tool_use_id && failedToolUseIds.has(e.tool_use_id)) return false;
    if (!e.tool_use_id && fileWindowMatch(e.file_path, e.timestamp)) return false;
    return true;
  });
  const filteredCp = checkpointEntries.filter((cp) => {
    if (cp.snapshot_phase !== "pre_ai_edit") return true;
    if (cp.tool_use_id && failedToolUseIds.has(cp.tool_use_id)) return false;
    if (!cp.tool_use_id && fileWindowMatch(cp.file_path, cp.timestamp) && !succeededInvocations.has(cp.tool_invocation_id)) return false;
    return true;
  });
  return { oldEntries: filteredOld, checkpointEntries: filteredCp };
}
function buildOldMultisets(oldEntries, repoRoot) {
  const trigramByFile = /* @__PURE__ */ new Map();
  const lineOnlyByFile = /* @__PURE__ */ new Map();
  const agentByTrigramByFile = /* @__PURE__ */ new Map();
  const agentByLineHashByFile = /* @__PURE__ */ new Map();
  for (const entry of oldEntries) {
    const relPath = path4.isAbsolute(entry.file_path) ? path4.relative(repoRoot, entry.file_path) : entry.file_path;
    if (!relPath || relPath.startsWith("..")) continue;
    const agent = entry.ai_tool || "unknown";
    if (entry.line_context_hash) {
      if (!trigramByFile.has(relPath)) trigramByFile.set(relPath, /* @__PURE__ */ new Map());
      const tMap = trigramByFile.get(relPath);
      tMap.set(entry.line_context_hash, (tMap.get(entry.line_context_hash) ?? 0) + 1);
      if (!agentByTrigramByFile.has(relPath)) agentByTrigramByFile.set(relPath, /* @__PURE__ */ new Map());
      const aMap = agentByTrigramByFile.get(relPath);
      if (!aMap.has(entry.line_context_hash)) aMap.set(entry.line_context_hash, /* @__PURE__ */ new Map());
      const trigramAuthorCounts = aMap.get(entry.line_context_hash);
      trigramAuthorCounts.set(agent, (trigramAuthorCounts.get(agent) ?? 0) + 1);
    }
    if (entry.line_content_hash) {
      if (!lineOnlyByFile.has(relPath)) lineOnlyByFile.set(relPath, /* @__PURE__ */ new Map());
      const lMap = lineOnlyByFile.get(relPath);
      lMap.set(entry.line_content_hash, (lMap.get(entry.line_content_hash) ?? 0) + 1);
      if (!agentByLineHashByFile.has(relPath)) agentByLineHashByFile.set(relPath, /* @__PURE__ */ new Map());
      const aMap = agentByLineHashByFile.get(relPath);
      if (!aMap.has(entry.line_content_hash)) aMap.set(entry.line_content_hash, /* @__PURE__ */ new Map());
      const lineAuthorCounts = aMap.get(entry.line_content_hash);
      lineAuthorCounts.set(agent, (lineAuthorCounts.get(agent) ?? 0) + 1);
    }
  }
  return { trigramByFile, lineOnlyByFile, agentByTrigramByFile, agentByLineHashByFile };
}
var HIGH_FREQUENCY_LINES = /* @__PURE__ */ new Set([
  "}",
  "{",
  "});",
  "]);",
  "})",
  "};",
  "return;",
  "break;",
  "continue;",
  "return null;",
  "return undefined;",
  "return false;",
  "return true;",
  "export default",
  "module.exports",
  "else {",
  "} else {",
  "} catch {",
  "} finally {"
]);
function isHighFrequencyLine(line) {
  return HIGH_FREQUENCY_LINES.has(normalizeLine(line).trim());
}
function buildCheckpointSetDiffs(checkpoints, repoRoot, fingerprintToTool) {
  const aiAddedByFile = /* @__PURE__ */ new Map();
  const authorByLineHash = /* @__PURE__ */ new Map();
  const sorted = [...checkpoints].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const humanByInvocationFile = /* @__PURE__ */ new Map();
  for (const cp of sorted) {
    if (cp.snapshot_phase === "pre_ai_edit") {
      const key = `${cp.tool_invocation_id}:${cp.file_path}`;
      humanByInvocationFile.set(key, cp);
    }
  }
  for (const cp of sorted) {
    if (cp.snapshot_phase !== "post_ai_edit") continue;
    const relPath = path4.isAbsolute(cp.file_path) ? path4.relative(repoRoot, cp.file_path) : cp.file_path;
    if (!relPath || relPath.startsWith("..")) continue;
    const pairKey = `${cp.tool_invocation_id}:${cp.file_path}`;
    const humanBefore = humanByInvocationFile.get(pairKey);
    const beforeSet = new Set(humanBefore?.line_hashes ?? []);
    const afterSet = new Set(cp.line_hashes);
    const aiOnly = /* @__PURE__ */ new Set();
    for (const hash of afterSet) {
      if (!beforeSet.has(hash)) aiOnly.add(hash);
    }
    if (!aiAddedByFile.has(relPath)) aiAddedByFile.set(relPath, /* @__PURE__ */ new Set());
    for (const hash of aiOnly) aiAddedByFile.get(relPath).add(hash);
    const authorName = fingerprintToTool?.get(cp.ai_session_fingerprint) ?? "unknown";
    if (!authorByLineHash.has(relPath)) authorByLineHash.set(relPath, /* @__PURE__ */ new Map());
    for (const hash of aiOnly) {
      authorByLineHash.get(relPath).set(hash, authorName);
    }
  }
  return { aiAddedByFile, authorByLineHash };
}
function resolveAuthor(authorCounts) {
  if (!authorCounts || authorCounts.size === 0) return "unknown";
  let bestAuthor = "unknown";
  let bestCount = 0;
  for (const [author, count] of authorCounts) {
    if (count > bestCount) {
      bestAuthor = author;
      bestCount = count;
    }
  }
  return bestAuthor;
}
function lookupPriorAiLinesForFile(filePath) {
  try {
    const baseDir = getTelemetryBaseDir();
    const entries = fs4.readdirSync(baseDir, { withFileTypes: true });
    let bestTimestamp = "";
    let bestCount = 0;
    let bestByTool = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordsPath = path4.join(baseDir, entry.name, "ai_commit_records.jsonl");
      if (!fs4.existsSync(recordsPath)) continue;
      const lines = fs4.readFileSync(recordsPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!record.files || !record.timestamp) continue;
          const fileEntry = record.files.find((f) => f.path === filePath);
          if (fileEntry && fileEntry.ai_authored_lines_added > 0) {
            if (!bestTimestamp || record.timestamp > bestTimestamp) {
              bestTimestamp = record.timestamp;
              bestCount = fileEntry.ai_authored_lines_added;
              bestByTool = {};
              const totalForFile = fileEntry.ai_authored_lines_added;
              if (record.ai_lines_by_tool && totalForFile > 0) {
                const totalCommit = record.ai_authored_lines_added;
                if (totalCommit > 0) {
                  for (const [tool, count] of Object.entries(record.ai_lines_by_tool)) {
                    const share = Math.round(count / totalCommit * totalForFile);
                    if (share > 0) bestByTool[tool] = share;
                  }
                }
              }
            }
          }
        } catch {
        }
      }
    }
    return { count: bestCount, byTool: bestByTool };
  } catch {
    return { count: 0, byTool: {} };
  }
}
function computeAttributionV2(diffEntries, addedByFile, deletedByFile, checkpointDiffs, aiMultisets, oldMultisets, repoRoot, preLintByFile, externalAiLines, externalLineAgentMap, operationByFile) {
  let totalLinesAdded = 0;
  let totalLinesDeleted = 0;
  let totalAiLinesAdded = 0;
  let totalAiLinesDeleted = 0;
  const aiLinesByAgent = {};
  const aiLinesAddedByAgent = {};
  const aiLinesDeletedByAgent = {};
  const aiLinesByKind = {};
  const files = [];
  const fileCache = /* @__PURE__ */ new Map();
  for (const diff of diffEntries) {
    totalLinesAdded += diff.linesAdded;
    totalLinesDeleted += diff.linesDeleted;
    const filePath = diff.filePath;
    const addedLines = addedByFile.get(filePath) ?? [];
    const committedFileLines = getCachedFileLines(fileCache, repoRoot, "HEAD", filePath);
    const committedIndex = buildNormalizedIndex(committedFileLines);
    const trigramCounts = new Map(aiMultisets.trigramByFile.get(filePath) ?? /* @__PURE__ */ new Map());
    const lineOnlyCounts = new Map(aiMultisets.lineOnlyByFile.get(filePath) ?? /* @__PURE__ */ new Map());
    const lineOnlyWsNormCounts = new Map(aiMultisets.lineOnlyWsNormByFile.get(filePath) ?? /* @__PURE__ */ new Map());
    const agentByTrigram = aiMultisets.agentByTrigramByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const agentByLineHash = aiMultisets.agentByLineHashByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const agentByLineHashWsNorm = aiMultisets.agentByLineHashWsNormByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const kindByTrigram = aiMultisets.kindByTrigramByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const kindByLineHash = aiMultisets.kindByLineHashByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const kindByLineHashWsNorm = aiMultisets.kindByLineHashWsNormByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const cpAiSet = checkpointDiffs.aiAddedByFile.get(filePath) ?? /* @__PURE__ */ new Set();
    const cpAuthors = checkpointDiffs.authorByLineHash.get(filePath) ?? /* @__PURE__ */ new Map();
    const externalLineHashSet = /* @__PURE__ */ new Set();
    for (const [extFile, extLines] of externalAiLines) {
      if (extFile === filePath || extFile === "__codex_unknown__") {
        for (const l of extLines) {
          if (l.trim()) externalLineHashSet.add(lineHash(l));
        }
      }
    }
    let checkpointMatches = 0;
    let trigramMatches = 0;
    let lineOnlyMatches = 0;
    let aiLinesAdded = 0;
    const perFileAddedByAgent = {};
    const perFileDeletedByAgent = {};
    const usedIndicesAdded = /* @__PURE__ */ new Set();
    for (const diffLine of addedLines) {
      const line = diffLine.content;
      const normalized = normalizeLine(line);
      if (!normalized) continue;
      const lHash = lineHash(line);
      let matched = false;
      let matchAgent = "";
      let matchAuthorId = "";
      let matchKind = "";
      if (cpAiSet.has(lHash)) {
        checkpointMatches++;
        aiLinesAdded++;
        matched = true;
        matchAuthorId = cpAuthors.get(lHash) || "";
        matchAgent = matchAuthorId || "unknown";
      }
      if (!matched && externalLineHashSet.size > 0 && externalLineHashSet.has(lHash)) {
        checkpointMatches++;
        aiLinesAdded++;
        matched = true;
        const agents = externalLineAgentMap?.get(lHash);
        matchAgent = agents?.[0] ?? "external_agent";
      }
      if (!matched) {
        const idx = findLineInIndexedFile(committedIndex, line, usedIndicesAdded, diffLine.hunkStart);
        if (idx >= 0) {
          usedIndicesAdded.add(idx);
          const prev = idx > 0 ? committedFileLines[idx - 1] : "";
          const next = idx < committedFileLines.length - 1 ? committedFileLines[idx + 1] : "";
          const tHash = trigramHash(prev, line, next);
          const trigramRemaining = trigramCounts.get(tHash) ?? 0;
          if (trigramRemaining > 0) {
            trigramMatches++;
            aiLinesAdded++;
            trigramCounts.set(tHash, trigramRemaining - 1);
            matched = true;
            matchAgent = resolveAuthor(agentByTrigram.get(tHash));
            matchKind = resolveAuthor(kindByTrigram.get(tHash));
          }
        }
      }
      if (!matched) {
        const lineRemaining = lineOnlyCounts.get(lHash) ?? 0;
        if (lineRemaining > 0) {
          if (!isHighFrequencyLine(line)) {
            lineOnlyCounts.set(lHash, lineRemaining - 1);
            matched = true;
            matchAgent = resolveAuthor(agentByLineHash.get(lHash));
            matchKind = resolveAuthor(kindByLineHash.get(lHash));
            aiLinesAdded++;
            lineOnlyMatches++;
          }
        }
      }
      if (!matched) {
        try {
          const preLintLines = preLintByFile.get(filePath);
          if (preLintLines && preLintLines.length > 0) {
            const preLintMatch = preLintLines.find((pl) => pl.hunkStart === diffLine.hunkStart);
            if (preLintMatch && !isHighFrequencyLine(preLintMatch.content)) {
              const preLintHash = lineHash(preLintMatch.content);
              const preLintRemaining = lineOnlyCounts.get(preLintHash) ?? 0;
              if (preLintRemaining > 0) {
                lineOnlyCounts.set(preLintHash, preLintRemaining - 1);
                matched = true;
                matchAgent = resolveAuthor(agentByLineHash.get(preLintHash));
                matchKind = resolveAuthor(kindByLineHash.get(preLintHash));
                aiLinesAdded++;
                lineOnlyMatches++;
              }
            }
          }
        } catch {
        }
      }
      if (!matched && !isHighFrequencyLine(line)) {
        const wsHash = lineHashWsNorm(line);
        const wsNormCounts = lineOnlyWsNormCounts;
        const wsRemaining = wsNormCounts.get(wsHash) ?? 0;
        if (wsRemaining > 0) {
          wsNormCounts.set(wsHash, wsRemaining - 1);
          matched = true;
          matchAgent = resolveAuthor(agentByLineHashWsNorm.get(wsHash));
          matchKind = resolveAuthor(kindByLineHashWsNorm.get(wsHash));
          aiLinesAdded++;
          lineOnlyMatches++;
        }
      }
      if (matched && matchAgent) {
        aiLinesByAgent[matchAgent] = (aiLinesByAgent[matchAgent] ?? 0) + 1;
        aiLinesAddedByAgent[matchAgent] = (aiLinesAddedByAgent[matchAgent] ?? 0) + 1;
        perFileAddedByAgent[matchAgent] = (perFileAddedByAgent[matchAgent] ?? 0) + 1;
        let resolvedKind = matchKind && matchKind !== "unknown" ? matchKind : "";
        if (!resolvedKind) {
          const byLine = resolveAuthor(kindByLineHash.get(lHash));
          const byWs = resolveAuthor(kindByLineHashWsNorm.get(lineHashWsNorm(line)));
          if (byLine && byLine !== "unknown") resolvedKind = byLine;
          else if (byWs && byWs !== "unknown") resolvedKind = byWs;
        }
        const kindBucket = resolvedKind || "agent";
        aiLinesByKind[kindBucket] = (aiLinesByKind[kindBucket] ?? 0) + 1;
      }
    }
    const nonBlankAddedCount = addedLines.filter((dl) => normalizeLine(dl.content)).length;
    const blankAddedCount = diff.linesAdded - nonBlankAddedCount;
    if (blankAddedCount > 0 && nonBlankAddedCount > 0) {
      const aiRatio = aiLinesAdded / nonBlankAddedCount;
      const blankAiLines = Math.round(blankAddedCount * aiRatio);
      if (blankAiLines > 0) {
        aiLinesAdded += blankAiLines;
        const dominantAgent = Object.entries(perFileAddedByAgent).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (dominantAgent) {
          aiLinesByAgent[dominantAgent] = (aiLinesByAgent[dominantAgent] ?? 0) + blankAiLines;
          aiLinesAddedByAgent[dominantAgent] = (aiLinesAddedByAgent[dominantAgent] ?? 0) + blankAiLines;
        }
      }
    }
    aiLinesAdded = Math.max(0, Math.min(aiLinesAdded, diff.linesAdded));
    totalAiLinesAdded += aiLinesAdded;
    const deletedLines = deletedByFile.get(filePath) ?? [];
    const parentFileLines = deletedLines.length > 0 ? getCachedFileLines(fileCache, repoRoot, "HEAD^", filePath) : [];
    const parentIndex = deletedLines.length > 0 ? buildNormalizedIndex(parentFileLines) : /* @__PURE__ */ new Map();
    const oldTrigramCounts = new Map(oldMultisets.trigramByFile.get(filePath) ?? /* @__PURE__ */ new Map());
    const oldLineOnlyCounts = new Map(oldMultisets.lineOnlyByFile.get(filePath) ?? /* @__PURE__ */ new Map());
    const oldAgentByTrigram = oldMultisets.agentByTrigramByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const oldAgentByLineHash = oldMultisets.agentByLineHashByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    const aiLineOnlyCountsForDeletion = new Map(aiMultisets.lineOnlyByFile.get(filePath) ?? /* @__PURE__ */ new Map());
    const aiAgentByLineHashForDeletion = aiMultisets.agentByLineHashByFile.get(filePath) ?? /* @__PURE__ */ new Map();
    let aiLinesDeleted = 0;
    const usedIndicesDeleted = /* @__PURE__ */ new Set();
    for (const diffLine of deletedLines) {
      const line = diffLine.content;
      const normalized = normalizeLine(line);
      if (!normalized) continue;
      const idx = findLineInIndexedFile(parentIndex, line, usedIndicesDeleted, diffLine.hunkStart);
      let matched = false;
      if (idx >= 0) {
        usedIndicesDeleted.add(idx);
        const prev = idx > 0 ? parentFileLines[idx - 1] : "";
        const next = idx < parentFileLines.length - 1 ? parentFileLines[idx + 1] : "";
        const tHash = trigramHash(prev, line, next);
        const trigramRemaining = oldTrigramCounts.get(tHash) ?? 0;
        if (trigramRemaining > 0) {
          aiLinesDeleted++;
          oldTrigramCounts.set(tHash, trigramRemaining - 1);
          matched = true;
          const delAgent = resolveAuthor(oldAgentByTrigram.get(tHash));
          aiLinesByAgent[delAgent] = (aiLinesByAgent[delAgent] ?? 0) + 1;
          aiLinesDeletedByAgent[delAgent] = (aiLinesDeletedByAgent[delAgent] ?? 0) + 1;
          perFileDeletedByAgent[delAgent] = (perFileDeletedByAgent[delAgent] ?? 0) + 1;
        }
      }
      if (!matched) {
        const lHash = lineHash(line);
        const lineRemaining = oldLineOnlyCounts.get(lHash) ?? 0;
        if (lineRemaining > 0) {
          aiLinesDeleted++;
          oldLineOnlyCounts.set(lHash, lineRemaining - 1);
          matched = true;
          const delAgent = resolveAuthor(oldAgentByLineHash.get(lHash));
          aiLinesByAgent[delAgent] = (aiLinesByAgent[delAgent] ?? 0) + 1;
          aiLinesDeletedByAgent[delAgent] = (aiLinesDeletedByAgent[delAgent] ?? 0) + 1;
          perFileDeletedByAgent[delAgent] = (perFileDeletedByAgent[delAgent] ?? 0) + 1;
        }
      }
      if (!matched) {
        const lHash = lineHash(line);
        const aiLineRemaining = aiLineOnlyCountsForDeletion.get(lHash) ?? 0;
        if (aiLineRemaining > 0) {
          aiLinesDeleted++;
          aiLineOnlyCountsForDeletion.set(lHash, aiLineRemaining - 1);
          const delAgent = resolveAuthor(aiAgentByLineHashForDeletion.get(lHash));
          aiLinesByAgent[delAgent] = (aiLinesByAgent[delAgent] ?? 0) + 1;
          aiLinesDeletedByAgent[delAgent] = (aiLinesDeletedByAgent[delAgent] ?? 0) + 1;
          perFileDeletedByAgent[delAgent] = (perFileDeletedByAgent[delAgent] ?? 0) + 1;
        }
      }
    }
    const nonBlankDeletedCount = deletedLines.filter((dl) => normalizeLine(dl.content)).length;
    const blankDeletedCount = diff.linesDeleted - nonBlankDeletedCount;
    if (blankDeletedCount > 0 && nonBlankDeletedCount > 0) {
      const delRatio = aiLinesDeleted / nonBlankDeletedCount;
      const blankAiDelLines = Math.round(blankDeletedCount * delRatio);
      if (blankAiDelLines > 0) {
        aiLinesDeleted += blankAiDelLines;
        const dominantDelAgent = Object.entries(perFileDeletedByAgent).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (dominantDelAgent) {
          aiLinesByAgent[dominantDelAgent] = (aiLinesByAgent[dominantDelAgent] ?? 0) + blankAiDelLines;
          aiLinesDeletedByAgent[dominantDelAgent] = (aiLinesDeletedByAgent[dominantDelAgent] ?? 0) + blankAiDelLines;
        }
      }
    }
    aiLinesDeleted = Math.max(0, Math.min(aiLinesDeleted, diff.linesDeleted));
    if (diff.linesAdded === 0 && aiLinesDeleted === 0 && diff.linesDeleted > 0) {
      const priorLookup = lookupPriorAiLinesForFile(filePath);
      aiLinesDeleted = Math.max(0, Math.min(priorLookup.count, diff.linesDeleted));
      for (const [tool, cnt] of Object.entries(priorLookup.byTool)) {
        aiLinesByAgent[tool] = (aiLinesByAgent[tool] ?? 0) + cnt;
        aiLinesDeletedByAgent[tool] = (aiLinesDeletedByAgent[tool] ?? 0) + cnt;
      }
    }
    totalAiLinesDeleted += aiLinesDeleted;
    const fileOp = operationByFile?.get(filePath);
    files.push({
      path: filePath,
      ai_authored_lines_added: aiLinesAdded,
      ai_authored_lines_deleted: aiLinesDeleted,
      ai_drafted_then_human_edited_lines: 0,
      lines_added_total: diff.linesAdded,
      lines_deleted_total: diff.linesDeleted,
      ...fileOp ? { operation: fileOp.op } : {},
      ...fileOp?.rename_from ? { rename_from: fileOp.rename_from } : {},
      match_breakdown: {
        checkpoint_matches: checkpointMatches,
        trigram_matches: trigramMatches,
        line_only_matches: lineOnlyMatches,
        fallback_estimate: 0
      }
    });
  }
  totalAiLinesAdded = Math.max(0, Math.min(totalAiLinesAdded, totalLinesAdded));
  totalAiLinesDeleted = Math.max(0, Math.min(totalAiLinesDeleted, totalLinesDeleted));
  return {
    files,
    totalLinesAdded,
    totalLinesDeleted,
    totalAiLinesAdded,
    totalAiLinesDeleted,
    aiLinesByAgent,
    aiLinesAddedByAgent,
    aiLinesDeletedByAgent,
    aiLinesByKind
  };
}
function writeCommitRecord(workstreamId, record) {
  const shaExistsInFile = (filePath) => {
    try {
      if (!fs4.existsSync(filePath)) return false;
      return fs4.readFileSync(filePath, "utf-8").split("\n").some((l) => {
        if (!l.trim()) return false;
        try {
          return JSON.parse(l).commit_sha === record.commit_sha;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };
  const scopedPath = path4.join(getSessionLogDir(workstreamId), "ai_commit_records.jsonl");
  if (!shaExistsInFile(scopedPath)) {
    appendSessionLog(workstreamId, "ai_commit_records.jsonl", record);
  }
  try {
    const baseDir = getTelemetryBaseDir();
    fs4.mkdirSync(baseDir, { recursive: true });
    const basePath = path4.join(baseDir, "ai_commit_records.jsonl");
    withFileLock(basePath + ".lock", () => {
      if (shaExistsInFile(basePath) || shaExistsInFile(basePath + ".1")) return;
      fs4.appendFileSync(basePath, JSON.stringify(record) + "\n", "utf-8");
      try {
        const st = fs4.statSync(basePath);
        if (st.size > 1024 * 1024) {
          fs4.renameSync(basePath, basePath + ".1");
        }
      } catch {
      }
    });
  } catch {
  }
}
function pruneDedupShas(dedupDir) {
  try {
    const entries = fs4.readdirSync(dedupDir).map((f) => ({ name: f, time: fs4.statSync(path4.join(dedupDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
    for (const e of entries.slice(50)) {
      try {
        fs4.unlinkSync(path4.join(dedupDir, e.name));
      } catch {
      }
    }
  } catch {
  }
}
function main2() {
  const watchdog = installHookWatchdog(8e3);
  try {
    const repoRoot = getRepoRoot();
    if (!repoRoot) process.exit(0);
    const commitSha = getHeadSha2(repoRoot);
    if (!commitSha) process.exit(0);
    const dedupDir = path4.join(getTelemetryBaseDir(), "emitted_shas");
    try {
      fs4.mkdirSync(dedupDir, { recursive: true });
    } catch {
    }
    const dedupFile = path4.join(dedupDir, commitSha);
    try {
      fs4.writeFileSync(dedupFile, String(process.pid), { flag: "wx" });
    } catch {
      clearTimeout(watchdog);
      process.exit(0);
    }
    if (isCherryPick(repoRoot)) {
      try {
        const cpMessage = (() => {
          try {
            return execSync3(`git log -1 --format=%B ${commitSha}`, { cwd: repoRoot, encoding: "utf-8", timeout: 3e3 }).trim();
          } catch {
            return "";
          }
        })();
        const source = resolveCherryPickSource(repoRoot, commitSha, cpMessage);
        if (source && commitRecordExistsFor(source)) {
          const activePointer2 = readConcurrentSessionPointerForRepo(repoRoot);
          const sessionsPayload2 = listConcurrentSessionsForPayload(activePointer2);
          const primary = pickActiveAiSessionForCommit(activePointer2);
          const toolCounts = /* @__PURE__ */ new Map();
          for (const s of sessionsPayload2) {
            if (s.ai_tool) toolCounts.set(s.ai_tool, (toolCounts.get(s.ai_tool) ?? 0) + 1);
          }
          const toolsUsedDetailed2 = Array.from(toolCounts.entries()).map(([tool, sessions]) => ({ tool, sessions })).sort((a, b) => b.sessions - a.sessions);
          const emitted = transferAttribution([source], commitSha, "cherry-pick", {
            emitEvent: true,
            repoRoot,
            aiTool: primary?.ai_tool,
            concurrentSessions: sessionsPayload2.length > 0 ? sessionsPayload2 : void 0,
            toolsUsedDetailed: toolsUsedDetailed2
          });
          if (emitted !== null) {
            pruneDedupShas(dedupDir);
            clearTimeout(watchdog);
            process.exit(0);
          }
        }
      } catch {
      }
    }
    const isMerge = isMergeCommit(repoRoot);
    const fileStats = getCommitFileStats(repoRoot, isMerge);
    const commitRenames = getCommitRenames(repoRoot, isMerge);
    const operationByFile = getCommitFileOperations(repoRoot, isMerge);
    const rawDiffEntries = isMerge ? getMergeDiff(repoRoot) ?? [] : getCommitDiff(repoRoot);
    if (!isMerge && !rawDiffEntries) {
      pruneDedupShas(dedupDir);
      clearTimeout(watchdog);
      process.exit(0);
    }
    const diffEntries = (rawDiffEntries ?? []).filter((d) => !isGeneratedFile(d.filePath));
    const committedFiles = new Set(diffEntries.map((d) => d.filePath));
    const session = resolveSession(repoRoot, committedFiles);
    const sessionId = session?.sessionId ?? `commit-${commitSha}`;
    const model = session?.model;
    const resolution = session?.resolution ?? "skipped";
    const activePointer = readConcurrentSessionPointerForRepo(repoRoot);
    const workstreamId = activePointer?.workstream_id ?? computeWorkstreamId();
    const sessionsPayload = listConcurrentSessionsForPayload(activePointer);
    const primaryFromPointer = pickActiveAiSessionForCommit(activePointer);
    const { addedByFile, deletedByFile } = parseCommitHunks(repoRoot, isMerge);
    let parentSha;
    try {
      parentSha = execSync3("git rev-parse HEAD~1", {
        encoding: "utf-8",
        timeout: 5e3,
        cwd: repoRoot
      }).trim();
    } catch {
      parentSha = "initial";
    }
    let aiLineEntries = [];
    let oldLineEntries = [];
    let checkpointEntries = [];
    if (session) {
      aiLineEntries = readAllFromSessionLog(workstreamId, "ai_line_fingerprints.jsonl", parentSha);
      oldLineEntries = readAllFromSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", parentSha);
      checkpointEntries = readAllFromSessionLog(workstreamId, "file_snapshots.jsonl", parentSha);
      if (aiLineEntries.length === 0 && checkpointEntries.length === 0 && parentSha && parentSha !== "initial") {
        try {
          const ancestorShas = execSync3(`git rev-list --max-count=5 ${parentSha}`, {
            encoding: "utf-8",
            timeout: 5e3,
            cwd: repoRoot
          }).trim().split("\n").filter(Boolean);
          for (const sha of ancestorShas) {
            if (sha === parentSha) continue;
            const ancestorAi = readAllFromSessionLog(workstreamId, "ai_line_fingerprints.jsonl", sha);
            if (ancestorAi.length > 0) {
              aiLineEntries = ancestorAi;
              oldLineEntries = readAllFromSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", sha);
              checkpointEntries = readAllFromSessionLog(workstreamId, "file_snapshots.jsonl", sha);
              break;
            }
          }
        } catch {
        }
      }
      if (aiLineEntries.length === 0 && checkpointEntries.length === 0) {
        const diffFiles = new Set(diffEntries.map((d) => d.filePath));
        try {
          for (const hacDir of getTelemetryBaseDirsForRead()) {
            const subdirs = fs4.readdirSync(hacDir, { withFileTypes: true });
            for (const sub of subdirs) {
              if (!sub.isDirectory()) continue;
              const sha = sub.name;
              if (sha === parentSha || sha === commitSha) continue;
              const fpFile = path4.join(hacDir, sha, "ai_line_fingerprints.jsonl");
              if (!fs4.existsSync(fpFile)) continue;
              try {
                const lines = fs4.readFileSync(fpFile, "utf-8").split("\n");
                let hasRelevant = false;
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const parsed = JSON.parse(line);
                    const rel = parsed.file_path && (diffFiles.has(parsed.file_path) || diffFiles.has(path4.relative(repoRoot, parsed.file_path)));
                    if (rel) hasRelevant = true;
                  } catch {
                  }
                }
                if (hasRelevant) {
                  const allAi = readAllFromSessionLog(workstreamId, "ai_line_fingerprints.jsonl", sha);
                  const allOld = readAllFromSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", sha);
                  const allCp = readAllFromSessionLog(workstreamId, "file_snapshots.jsonl", sha);
                  aiLineEntries = [...aiLineEntries, ...allAi];
                  oldLineEntries = [...oldLineEntries, ...allOld];
                  checkpointEntries = [...checkpointEntries, ...allCp];
                }
              } catch {
              }
            }
          }
        } catch {
        }
      }
    }
    if (commitRenames.size > 0) {
      const oldToNew = /* @__PURE__ */ new Map();
      for (const [newPath, oldPath] of commitRenames) oldToNew.set(oldPath, newPath);
      const remapPath = (p) => {
        const rel = path4.isAbsolute(p) ? path4.relative(repoRoot, p) : p;
        return oldToNew.get(rel) ?? p;
      };
      for (const e of aiLineEntries) e.file_path = remapPath(e.file_path);
      for (const e of oldLineEntries) e.file_path = remapPath(e.file_path);
      for (const e of checkpointEntries) e.file_path = remapPath(e.file_path);
    }
    {
      const failures = loadFailureRecords();
      const filtered = applyFailureInvalidation(oldLineEntries, checkpointEntries, failures, repoRoot);
      oldLineEntries = filtered.oldEntries;
      checkpointEntries = filtered.checkpointEntries;
    }
    const commitTime = (() => {
      try {
        const epochStr = execSync3("git log -1 --format=%ct HEAD", {
          encoding: "utf-8",
          timeout: 3e3,
          cwd: repoRoot
        }).trim();
        const epoch = parseInt(epochStr, 10);
        return Number.isFinite(epoch) ? new Date(epoch * 1e3) : /* @__PURE__ */ new Date();
      } catch {
        return /* @__PURE__ */ new Date();
      }
    })();
    const preLintByFile = readPreLintDiff(repoRoot, commitTime);
    const externalAiLines = /* @__PURE__ */ new Map();
    const externalLineAgentMap = /* @__PURE__ */ new Map();
    try {
      const coveredFiles = /* @__PURE__ */ new Set();
      const addCovered = (fp) => {
        if (!fp) return;
        coveredFiles.add(fp);
        coveredFiles.add(path4.isAbsolute(fp) ? path4.relative(repoRoot, fp) : fp);
      };
      for (const e of aiLineEntries) addCovered(e.file_path);
      for (const e of checkpointEntries) addCovered(e.file_path);
      const committedRel = new Set(diffEntries.map((d) => d.filePath));
      const hasUncovered = [...committedRel].some((f) => !coveredFiles.has(f));
      if (hasUncovered) {
        const commitTimeNow = /* @__PURE__ */ new Date();
        const cursorLines = readCursorAiLines(repoRoot, commitSha ?? "", commitTimeNow, parentSha);
        const codexLines = readCodexAiLines(repoRoot, commitSha ?? "", commitTimeNow);
        const opencodeLines = readOpenCodeAiLines(repoRoot, commitSha ?? "", commitTimeNow);
        const taggedSources = [
          [cursorLines, "cursor"],
          [codexLines, "codex"],
          [opencodeLines, "opencode"]
        ];
        for (const [sourceMap, agentName] of taggedSources) {
          for (const [file, lines] of sourceMap) {
            if (file !== "__codex_unknown__" && coveredFiles.has(file)) continue;
            const existing = externalAiLines.get(file) ?? [];
            externalAiLines.set(file, [...existing, ...lines]);
            for (const l of lines) {
              if (l.trim()) {
                const hash = lineHash(l);
                const agents = externalLineAgentMap.get(hash) ?? [];
                if (!agents.includes(agentName)) agents.push(agentName);
                externalLineAgentMap.set(hash, agents);
              }
            }
          }
        }
      }
    } catch {
    }
    const stats = (() => {
      const emptyResult = (dfEntries) => {
        const files = dfEntries.map((diff) => {
          const fileOp = operationByFile.get(diff.filePath);
          return {
            path: diff.filePath,
            ai_authored_lines_added: 0,
            ai_authored_lines_deleted: 0,
            ai_drafted_then_human_edited_lines: 0,
            lines_added_total: diff.linesAdded,
            lines_deleted_total: diff.linesDeleted,
            ...fileOp ? { operation: fileOp.op } : {},
            ...fileOp?.rename_from ? { rename_from: fileOp.rename_from } : {},
            match_breakdown: {
              checkpoint_matches: 0,
              trigram_matches: 0,
              line_only_matches: 0,
              fallback_estimate: 0
            }
          };
        });
        const totalLinesAdded = dfEntries.reduce((sum, d) => sum + d.linesAdded, 0);
        const totalLinesDeleted = dfEntries.reduce((sum, d) => sum + d.linesDeleted, 0);
        return {
          files,
          totalLinesAdded,
          totalLinesDeleted,
          totalAiLinesAdded: 0,
          totalAiLinesDeleted: 0,
          aiLinesByAgent: {},
          aiLinesAddedByAgent: {},
          aiLinesDeletedByAgent: {},
          aiLinesByKind: {}
        };
      };
      if (!session) {
        const hasWholeDeletions = diffEntries.some((d) => d.linesAdded === 0 && d.linesDeleted > 0);
        if (!hasWholeDeletions) return emptyResult(diffEntries);
        return computeAttributionV2(
          diffEntries,
          addedByFile,
          deletedByFile,
          { aiAddedByFile: /* @__PURE__ */ new Map(), authorByLineHash: /* @__PURE__ */ new Map() },
          { trigramByFile: /* @__PURE__ */ new Map(), lineOnlyByFile: /* @__PURE__ */ new Map(), lineOnlyWsNormByFile: /* @__PURE__ */ new Map(), agentByTrigramByFile: /* @__PURE__ */ new Map(), agentByLineHashByFile: /* @__PURE__ */ new Map(), agentByLineHashWsNormByFile: /* @__PURE__ */ new Map(), kindByTrigramByFile: /* @__PURE__ */ new Map(), kindByLineHashByFile: /* @__PURE__ */ new Map(), kindByLineHashWsNormByFile: /* @__PURE__ */ new Map() },
          { trigramByFile: /* @__PURE__ */ new Map(), lineOnlyByFile: /* @__PURE__ */ new Map(), agentByTrigramByFile: /* @__PURE__ */ new Map(), agentByLineHashByFile: /* @__PURE__ */ new Map() },
          repoRoot,
          preLintByFile,
          externalAiLines,
          externalLineAgentMap,
          operationByFile
        );
      }
      const fingerprintToTool = /* @__PURE__ */ new Map();
      for (const entry of aiLineEntries) {
        if (entry.ai_session_fingerprint && entry.ai_tool) {
          fingerprintToTool.set(entry.ai_session_fingerprint, entry.ai_tool);
        }
      }
      try {
        for (const hacDir of getTelemetryBaseDirsForRead()) {
          const entries = fs4.readdirSync(hacDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fpFile = path4.join(hacDir, entry.name, "ai_line_fingerprints.jsonl");
            if (!fs4.existsSync(fpFile)) continue;
            try {
              const lines = fs4.readFileSync(fpFile, "utf-8").split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.ai_session_fingerprint && parsed.ai_tool && !fingerprintToTool.has(parsed.ai_session_fingerprint)) {
                    fingerprintToTool.set(parsed.ai_session_fingerprint, parsed.ai_tool);
                  }
                } catch {
                }
              }
            } catch {
            }
          }
        }
      } catch {
      }
      const checkpointDiffs = buildCheckpointSetDiffs(checkpointEntries, repoRoot, fingerprintToTool);
      const carryForwardSet = buildCarryForwardSet(aiLineEntries, oldLineEntries);
      const aiMultisets = buildAiMultisets(aiLineEntries, carryForwardSet, repoRoot);
      const oldMultisets = buildOldMultisets(oldLineEntries, repoRoot);
      const hasDeletedFiles = diffEntries.some((d) => d.linesAdded === 0 && d.linesDeleted > 0);
      if (aiLineEntries.length > 0 || checkpointEntries.length > 0 || externalAiLines.size > 0 || hasDeletedFiles) {
        return computeAttributionV2(
          diffEntries,
          addedByFile,
          deletedByFile,
          checkpointDiffs,
          aiMultisets,
          oldMultisets,
          repoRoot,
          preLintByFile,
          externalAiLines,
          externalLineAgentMap,
          operationByFile
        );
      }
      return emptyResult(diffEntries);
    })();
    const totalChanged = stats.totalLinesAdded + stats.totalLinesDeleted;
    const totalAiChanged = stats.totalAiLinesAdded + stats.totalAiLinesDeleted;
    const aiPercentage = totalChanged > 0 ? Math.round(totalAiChanged / totalChanged * 100) : 0;
    let pureHumanLinesAdded = Math.max(0, stats.totalLinesAdded - stats.totalAiLinesAdded);
    let pureHumanLinesDeleted = Math.max(0, stats.totalLinesDeleted - stats.totalAiLinesDeleted);
    const toolSessionCounts = /* @__PURE__ */ new Map();
    const interCommitSummary = (() => {
      const sessionIds = /* @__PURE__ */ new Set();
      const agents = /* @__PURE__ */ new Set();
      const filesTouched = /* @__PURE__ */ new Set();
      let firstEdit;
      let lastEdit;
      let lastAiTool;
      let lastAiSessionId;
      for (const entry of aiLineEntries) {
        if (entry.ai_session_fingerprint) sessionIds.add(entry.ai_session_fingerprint);
        if (entry.ai_tool) agents.add(entry.ai_tool);
        if (entry.ai_tool && entry.ai_session_fingerprint) {
          let s = toolSessionCounts.get(entry.ai_tool);
          if (!s) {
            s = /* @__PURE__ */ new Set();
            toolSessionCounts.set(entry.ai_tool, s);
          }
          s.add(entry.ai_session_fingerprint);
        }
        if (entry.file_path) filesTouched.add(entry.file_path);
        if (entry.timestamp) {
          if (!firstEdit || entry.timestamp < firstEdit) firstEdit = entry.timestamp;
          if (!lastEdit || entry.timestamp > lastEdit) {
            lastEdit = entry.timestamp;
            lastAiTool = entry.ai_tool;
            lastAiSessionId = entry.ai_session_fingerprint;
          }
        }
      }
      for (const entry of checkpointEntries) {
        if (entry.ai_session_fingerprint) sessionIds.add(entry.ai_session_fingerprint);
        if (entry.file_path) filesTouched.add(entry.file_path);
      }
      return {
        ai_sessions_count: sessionIds.size,
        ai_tools_used: Array.from(agents),
        ai_edit_operations: aiLineEntries.length,
        ai_edited_files_count: filesTouched.size,
        ...lastAiTool ? { last_ai_tool: lastAiTool } : {},
        ...lastAiSessionId ? { last_ai_session_id: lastAiSessionId } : {},
        ...firstEdit ? { first_ai_edit_at: firstEdit } : {},
        ...lastEdit ? { last_ai_edit_at: lastEdit } : {}
      };
    })();
    let finalAiPercentage = aiPercentage;
    let finalAiLinesAdded = stats.totalAiLinesAdded;
    let finalAiLinesDeleted = stats.totalAiLinesDeleted;
    if (aiPercentage === 0 && totalChanged > 0) {
      const postEditCps = checkpointEntries.filter((c) => c.snapshot_phase === "post_ai_edit").length;
      const rawOps = Math.max(interCommitSummary.ai_edit_operations, postEditCps);
      if (rawOps > 0) {
        finalAiPercentage = Math.max(1, Math.min(50, Math.round(rawOps / totalChanged * 100)));
        const floorTotal = Math.round(totalChanged * finalAiPercentage / 100);
        finalAiLinesAdded = stats.totalLinesAdded > 0 ? Math.round(floorTotal * stats.totalLinesAdded / totalChanged) : 0;
        finalAiLinesDeleted = floorTotal - finalAiLinesAdded;
        pureHumanLinesAdded = Math.max(0, stats.totalLinesAdded - finalAiLinesAdded);
        pureHumanLinesDeleted = Math.max(0, stats.totalLinesDeleted - finalAiLinesDeleted);
      }
    }
    const filesChanged = stats.files.map((f) => f.path);
    const context = buildContext(sessionId, model, {
      concurrent_ai_sessions: sessionsPayload.length > 0 ? sessionsPayload : void 0,
      ai_tool: primaryFromPointer?.ai_tool
    });
    const commitMessage = (() => {
      try {
        return execSync3(`git log -1 --format=%B ${commitSha}`, { cwd: repoRoot, encoding: "utf-8", timeout: 3e3 }).trim();
      } catch {
        return "";
      }
    })();
    const reflogAction = (process.env.GIT_REFLOG_ACTION ?? "").toLowerCase();
    const triggeredBy = (() => {
      if (reflogAction.includes("rebase")) return "rebase";
      if (reflogAction.includes("cherry-pick")) return "cherry_pick";
      if (reflogAction.includes("revert")) return "revert";
      if (reflogAction.includes("amend")) return "amend";
      if (reflogAction.includes("merge") || isMerge) return "merge";
      if (!isMerge && /\(#\d+\)\s*$/.test(commitMessage.split("\n")[0] ?? "")) return "squash";
      const msgLower = commitMessage.toLowerCase();
      if (/co-authored-by:\s*claude/i.test(commitMessage) || /generated.*claude/i.test(commitMessage) || msgLower.includes("co-authored-by: claude")) return "claude";
      if (/generated by cursor/i.test(commitMessage) || /co-authored-by:\s*cursor/i.test(commitMessage)) return "cursor";
      if (interCommitSummary.last_ai_tool && interCommitSummary.ai_edit_operations > 0) {
        if (interCommitSummary.last_ai_edit_at) {
          const lastEditTime = new Date(interCommitSummary.last_ai_edit_at).getTime();
          const commitTimeMs = commitTime.getTime();
          if (commitTimeMs - lastEditTime < 5 * 60 * 1e3) {
            return interCommitSummary.last_ai_tool;
          }
        }
      }
      return "cli";
    })();
    const totalLinesChanged = stats.totalLinesAdded + stats.totalLinesDeleted;
    const commitSizeBucket = totalLinesChanged <= 10 ? "small" : totalLinesChanged <= 100 ? "medium" : totalLinesChanged <= 500 ? "large" : "huge";
    const sessionResolution = resolution === "env" ? "env" : resolution === "pointer" ? "pointer" : resolution === "checkpoint" ? "checkpoint" : "synthetic";
    const aiSignatureTools = /* @__PURE__ */ new Set(["claude", "cursor", "codex", "opencode", "factory"]);
    const hookGapCause = sessionResolution !== "synthetic" ? null : interCommitSummary.ai_edit_operations > 0 ? "synthetic_session_id" : aiSignatureTools.has(String(triggeredBy)) ? "claude_no_session" : "tool_env_missing";
    const quality = {
      session_resolution: sessionResolution,
      hook_gap_cause: hookGapCause
    };
    const attributedTools = new Set(
      Object.keys(stats.aiLinesByAgent).filter((t) => t && t !== "unknown")
    );
    for (const tool of Array.from(toolSessionCounts.keys())) {
      if (!attributedTools.has(tool)) {
        toolSessionCounts.delete(tool);
      }
    }
    for (const tool of attributedTools) {
      if (!toolSessionCounts.has(tool)) {
        const s = /* @__PURE__ */ new Set();
        s.add(`${tool}-attributed`);
        toolSessionCounts.set(tool, s);
      }
    }
    const toolsUsedDetailed = Array.from(toolSessionCounts.entries()).map(([tool, sessions]) => ({ tool, sessions: sessions.size })).sort((a, b) => b.sessions - a.sessions);
    const fileOps = { created: 0, modified: 0, deleted: 0, renamed: 0 };
    const renames = [];
    for (const [p, info] of operationByFile) {
      if (info.op === "create") fileOps.created++;
      else if (info.op === "modify") fileOps.modified++;
      else if (info.op === "delete") fileOps.deleted++;
      else if (info.op === "rename") {
        fileOps.renamed++;
        if (info.rename_from) renames.push({ from: info.rename_from, to: p });
      }
    }
    let attributionV3;
    if ((process.env.HAC_ATTRIBUTION_V3 ?? "1").trim() !== "0" && !isMerge) {
      try {
        const aiBlobByPath = buildAiBlobByPath(repoRoot, committedFiles);
        attributionV3 = computeBlobAttribution({
          repoRoot,
          files: diffEntries.map((d) => {
            const o = operationByFile.get(d.filePath);
            return { path: d.filePath, operation: o?.op, rename_from: o?.rename_from };
          }),
          aiBlobByPath,
          parentRef: "HEAD^"
        });
      } catch {
        attributionV3 = void 0;
      }
    }
    const squashNoProvenance = triggeredBy === "squash" && !session && checkpointEntries.length === 0 && aiLineEntries.length === 0 && stats.totalAiLinesAdded === 0 && stats.totalAiLinesDeleted === 0;
    const event = {
      event: "commit_event_trace",
      commit_sha: commitSha,
      repo: {
        name: context.repo.name,
        branch: context.repo.branch
      },
      author: {
        email: context.user.email,
        name: context.user.name
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ai_per: finalAiPercentage,
      ...isMerge ? { is_merge_commit: true } : {},
      triggered_by: triggeredBy,
      commit_size_bucket: commitSizeBucket,
      // Phase 5: normal post-commit attribution is measured directly from
      // fingerprints/checkpoints against the real diff. Dashboard headline AI%
      // uses direct-only events. (Remapped events come from transferAttribution.)
      attribution_method: "direct",
      ...squashNoProvenance ? { exclude_from_metrics: true } : {},
      overall: {
        files: {
          changed: filesChanged.length,
          created: fileStats.created,
          deleted: fileStats.deleted
        },
        lines: {
          changed: totalLinesChanged,
          added: stats.totalLinesAdded,
          deleted: stats.totalLinesDeleted
        },
        changed_files_count: filesChanged.length
      },
      file_operations: {
        ...fileOps,
        ...renames.length > 0 ? { renames } : {}
      },
      ...attributionV3 ? {
        attribution_v3: (({ files: _files, ...agg }) => agg)(attributionV3)
      } : {},
      ai: {
        lines: {
          added: finalAiLinesAdded,
          deleted: finalAiLinesDeleted
        },
        ...Object.keys(stats.aiLinesByAgent).length > 0 ? { by_tool: stats.aiLinesByAgent } : {},
        by_tool_added: stats.aiLinesAddedByAgent,
        ...Object.keys(stats.aiLinesDeletedByAgent).length > 0 ? { by_tool_deleted: stats.aiLinesDeletedByAgent } : {},
        // Phase 4: fixed-shape edit_kind split (agent/tab/shell) alongside by_tool.
        ...finalAiLinesAdded > 0 ? {
          by_kind: {
            agent: stats.aiLinesByKind.agent ?? 0,
            tab: stats.aiLinesByKind.tab ?? 0,
            shell: stats.aiLinesByKind.shell ?? 0
          }
        } : {},
        sessions: {
          // Bug 1 fix: Derive count from toolsUsedDetailed so it equals the sum of
          // per-tool session counts, keeping sessions.count and tools_used consistent.
          count: toolsUsedDetailed.reduce((sum, t) => sum + t.sessions, 0),
          ...context.ai_session_id ? { primary_session_id: context.ai_session_id } : {},
          tools_used: toolsUsedDetailed
        },
        activity: {
          line_writes: interCommitSummary.ai_edit_operations,
          files_touched: interCommitSummary.ai_edited_files_count,
          ...interCommitSummary.first_ai_edit_at ? { first_edit_at: interCommitSummary.first_ai_edit_at } : {},
          ...interCommitSummary.last_ai_edit_at ? { last_edit_at: interCommitSummary.last_ai_edit_at } : {}
        }
      },
      human: {
        lines: {
          added: pureHumanLinesAdded,
          deleted: pureHumanLinesDeleted
        }
      },
      quality
    };
    sendEvent(event);
    const commitRecord = {
      commit_sha: commitSha,
      ai_authored_lines_added: finalAiLinesAdded,
      ai_authored_lines_deleted: finalAiLinesDeleted,
      lines_added_total: stats.totalLinesAdded,
      lines_deleted_total: stats.totalLinesDeleted,
      ai_lines_by_tool: stats.aiLinesByAgent,
      files: stats.files,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...isMerge ? { is_merge_commit: true } : {},
      ...sessionsPayload.length > 0 ? { concurrent_ai_sessions: sessionsPayload } : {}
    };
    writeCommitRecord(workstreamId, commitRecord);
    rotateCommitDir();
    if (parentSha) {
      try {
        const sourceDirs = collectCarryForwardSourceDirs(parentSha);
        if (sourceDirs.length > 0) {
          carryForwardUncommittedFingerprintsMultiHop(repoRoot, sourceDirs);
        } else {
          carryForwardUncommittedFingerprints(parentSha, repoRoot);
        }
      } catch {
        try {
          carryForwardUncommittedFingerprints(parentSha, repoRoot);
        } catch {
        }
      }
      carryForwardSessionLogs(parentSha, repoRoot);
    }
    pruneOldCommitDirs();
    try {
      pruneStaleConcurrentSessions();
    } catch {
    }
    try {
      retryUnsentEvents();
    } catch {
    }
    try {
      runSurvivalSweep(repoRoot);
    } catch {
    }
    pruneDedupShas(dedupDir);
    clearTimeout(watchdog);
    process.exit(0);
  } catch {
    clearTimeout(watchdog);
    process.exit(0);
  }
}
main2();

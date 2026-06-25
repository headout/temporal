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
export {
  readCodexAiLines,
  readCursorAiLines,
  readOpenCodeAiLines
};

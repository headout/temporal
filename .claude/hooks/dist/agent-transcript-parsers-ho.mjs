// src/agent-transcript-parsers-ho.ts
import * as fs3 from "fs";
import * as path2 from "path";
import * as os2 from "os";
import { execFileSync as execFileSync2 } from "child_process";

// src/telemetry-core-ho.ts
import { execSync, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
var _cachedRepoRoot = null;
var _cachedGitDir = null;
var _cachedTelemetryBaseDir = null;
var HOOK_HEAL_INTERVAL_MS = 5 * 60 * 1e3;
var BREAKER_DIR = path.join(os.homedir(), ".cache", "hac-telemetry");
var BREAKER_FILE = path.join(BREAKER_DIR, "breaker.json");
var BREAKER_LOCK_FILE = BREAKER_FILE + ".lock";
var CURL_SUCCESS_DIR = path.join(os.tmpdir(), "hac-curl-ok");
var BREAKER_FAILURE_WINDOW_MS = 30 * 60 * 1e3;
var BREAKER_COOLDOWN_MS = 5 * 60 * 1e3;
var BREAKER_ATTEMPT_DECAY_MS = 10 * 60 * 1e3;
function getTelemetryBaseDir() {
  if (_cachedTelemetryBaseDir) return _cachedTelemetryBaseDir;
  const toplevel = getRepoRootFromGit(process.cwd());
  const gitDir = toplevel ? getGitDirAbsolute(toplevel) : null;
  if (gitDir) {
    _cachedTelemetryBaseDir = path.join(gitDir, "hac_telemetry");
  } else {
    _cachedTelemetryBaseDir = path.join(process.cwd(), ".git", "hac_telemetry");
  }
  return _cachedTelemetryBaseDir;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map(
    (k) => JSON.stringify(k) + ":" + stableStringify(value[k])
  ).join(",") + "}";
}
function readSessionLogAcrossCommits(filename) {
  try {
    const baseDir = getTelemetryBaseDir();
    if (!fs.existsSync(baseDir)) return [];
    const entries = [];
    const seen = /* @__PURE__ */ new Set();
    for (const name of fs.readdirSync(baseDir)) {
      const sub = path.join(baseDir, name);
      let isDir = false;
      try {
        isDir = fs.statSync(sub).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const fp = path.join(sub, filename);
      if (!fs.existsSync(fp)) continue;
      try {
        const content = fs.readFileSync(fp, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const key = stableStringify(obj);
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push(obj);
          } catch {
          }
        }
      } catch {
      }
    }
    entries.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
    return entries;
  } catch {
    return [];
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
    _cachedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
    return _cachedGitDir;
  } catch {
    return null;
  }
}
var CONCURRENT_SESSION_STALE_MS = 45 * 60 * 1e3;
var POINTER_DEBOUNCE_MS = 30 * 1e3;

// src/claude-transcript-parser-ho.ts
import * as fs2 from "fs";
import { createHash } from "crypto";
var EMPTY_SUMMARY = {
  turns: [],
  session_totals: {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens_read: 0,
    cached_tokens_written: 0
  }
};
var FILE_EDIT_TOOLS = /* @__PURE__ */ new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "Create",
  "StrReplace",
  "ApplyPatch",
  "NotebookEdit"
]);
function sha1(input) {
  return createHash("sha1").update(input, "utf-8").digest("hex");
}
function asNumber(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
function asString(x) {
  return typeof x === "string" ? x : "";
}
function extractPromptText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.join("");
  }
  return "";
}
function isSkillInjection(text) {
  return text.startsWith("Base directory for this skill:");
}
function extractSlashCommandSkill(text) {
  const m = text.match(/<command-name>\/([^<]+)<\/command-name>/);
  return m ? m[1] : null;
}
function isPureToolResultCarrier(content) {
  if (!Array.isArray(content)) return false;
  let hasTextBlock = false;
  let hasToolResult = false;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block;
      if (b.type === "text") hasTextBlock = true;
      if (b.type === "tool_result") hasToolResult = true;
    }
  }
  return hasToolResult && !hasTextBlock;
}
function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n);
}
function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    if (parts.length > 0) return parts.join(" ");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}
function newAcc(prompt_sent_at, prompt) {
  return {
    prompt_sent_at,
    response_completed_at: prompt_sent_at,
    prompt,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens_read: 0,
    cached_tokens_written: 0,
    tools_invoked: /* @__PURE__ */ new Map(),
    skills_actually_used: /* @__PURE__ */ new Map(),
    subagents_launched: /* @__PURE__ */ new Map(),
    files_edited: /* @__PURE__ */ new Set(),
    files_created: /* @__PURE__ */ new Set(),
    files_deleted: /* @__PURE__ */ new Set(),
    lines_changed: 0,
    lines_added: 0,
    lines_deleted: 0,
    tool_errors: []
  };
}
function bump(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}
function mapToList(m) {
  const out = [];
  for (const [name, count] of m) out.push({ name, count });
  return out;
}
function finalize(acc) {
  const startMs = Date.parse(acc.prompt_sent_at);
  const endMs = Date.parse(acc.response_completed_at);
  const response_time_ms = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : 0;
  return {
    prompt_id: sha1(`${acc.prompt_sent_at}
${acc.prompt}`),
    prompt_sent_at: acc.prompt_sent_at,
    response_completed_at: acc.response_completed_at,
    response_time_ms,
    model: acc.model,
    prompt: acc.prompt,
    prompt_length_chars: acc.prompt.length,
    input_tokens: acc.input_tokens,
    output_tokens: acc.output_tokens,
    cached_tokens_read: acc.cached_tokens_read,
    cached_tokens_written: acc.cached_tokens_written,
    tools_invoked: mapToList(acc.tools_invoked),
    skills_actually_used: mapToList(acc.skills_actually_used),
    subagents_launched: mapToList(acc.subagents_launched),
    files_edited_count: acc.files_edited.size,
    files_created_count: acc.files_created.size,
    files_deleted_count: acc.files_deleted.size,
    lines_changed: acc.lines_changed,
    lines_added: acc.lines_added,
    lines_deleted: acc.lines_deleted,
    tool_errors: acc.tool_errors
  };
}
function parseClaudeTranscript(transcriptPath) {
  if (!transcriptPath) return EMPTY_SUMMARY;
  try {
    if (!fs2.existsSync(transcriptPath)) return EMPTY_SUMMARY;
    const raw = fs2.readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n");
    const turns = [];
    let current = null;
    const usageCountedIds = /* @__PURE__ */ new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      try {
        const type = asString(obj.type);
        const timestamp = asString(obj.timestamp);
        const message = obj.message ?? {};
        if (type === "user") {
          const content = message.content;
          if (isPureToolResultCarrier(content)) {
            if (current && Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object") {
                  const b = block;
                  if (b.type === "tool_result" && b.is_error === true) {
                    const errStr = stringifyToolResultContent(b.content);
                    current.tool_errors.push(truncate(errStr, 200));
                  }
                }
              }
              if (timestamp) current.response_completed_at = timestamp;
            }
            continue;
          }
          const promptText = extractPromptText(content);
          if (isSkillInjection(promptText)) continue;
          if (current) turns.push(finalize(current));
          const started = timestamp || (/* @__PURE__ */ new Date()).toISOString();
          current = newAcc(started, promptText);
          const slashSkill = extractSlashCommandSkill(promptText);
          if (slashSkill) bump(current.skills_actually_used, slashSkill);
          continue;
        }
        if (type === "assistant") {
          if (!current) continue;
          if (timestamp) current.response_completed_at = timestamp;
          const model = asString(message.model);
          if (model) {
            if (!current.model) current.model = model;
          }
          const usage = message.usage ?? {};
          const messageId = asString(message.id);
          const shouldCountUsage = !messageId || !usageCountedIds.has(messageId);
          if (shouldCountUsage) {
            current.input_tokens += asNumber(usage.input_tokens);
            current.output_tokens += asNumber(usage.output_tokens);
            current.cached_tokens_read += asNumber(usage.cache_read_input_tokens);
            current.cached_tokens_written += asNumber(usage.cache_creation_input_tokens);
            if (messageId) usageCountedIds.add(messageId);
          }
          const content = message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || typeof block !== "object") continue;
              const b = block;
              if (b.type !== "tool_use") continue;
              const toolName = asString(b.name) || "unknown";
              bump(current.tools_invoked, toolName);
              const input = b.input ?? {};
              if (toolName === "Skill") {
                const skillName = asString(input.skill) || "unknown";
                bump(current.skills_actually_used, skillName);
              } else if (toolName === "Task" || toolName === "Agent") {
                const subagent = asString(input.subagent_type) || "general-purpose";
                bump(current.subagents_launched, subagent);
              }
              if (FILE_EDIT_TOOLS.has(toolName)) {
                const fp = asString(input.file_path);
                if (fp) {
                  current.files_edited.add(fp);
                  if (toolName === "Write" || toolName === "Create") {
                    current.files_created.add(fp);
                  }
                }
                const newStr = asString(input.new_string ?? input.content ?? "");
                const oldStr = asString(input.old_string ?? "");
                const added = newStr ? newStr.split("\n").length : 0;
                const deleted = oldStr ? oldStr.split("\n").length : 0;
                current.lines_added += added;
                current.lines_deleted += deleted;
                current.lines_changed += added + deleted;
              } else if (toolName === "Bash" || toolName === "bash") {
                const cmd = asString(input.command ?? "");
                if (/\brm\b/.test(cmd)) {
                  const matches = cmd.match(/\S+\.\w+/g) ?? [];
                  for (const m of matches) current.files_deleted.add(m);
                }
              }
            }
          }
          continue;
        }
        if (current && timestamp) current.response_completed_at = timestamp;
      } catch {
        continue;
      }
    }
    if (current) turns.push(finalize(current));
    const totals = {
      turns: turns.length,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens_read: 0,
      cached_tokens_written: 0
    };
    for (const t of turns) {
      totals.input_tokens += t.input_tokens;
      totals.output_tokens += t.output_tokens;
      totals.cached_tokens_read += t.cached_tokens_read;
      totals.cached_tokens_written += t.cached_tokens_written;
    }
    return { turns, session_totals: totals };
  } catch {
    return EMPTY_SUMMARY;
  }
}

// src/agent-transcript-parsers-ho.ts
var ZERO_NONE = {
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens_read: 0,
  cached_tokens_written: 0,
  turns: 0,
  source: "none"
};
function zero(source) {
  return { ...ZERO_NONE, source };
}
function claudeTranscriptResult(transcriptPath) {
  if (!transcriptPath) return ZERO_NONE;
  try {
    const summary = parseClaudeTranscript(transcriptPath);
    const st = summary.session_totals;
    if (summary.turns.length === 0 && st.input_tokens === 0 && st.output_tokens === 0 && st.cached_tokens_read === 0 && st.cached_tokens_written === 0) {
      return ZERO_NONE;
    }
    return {
      input_tokens: st.input_tokens,
      output_tokens: st.output_tokens,
      cached_tokens_read: st.cached_tokens_read,
      cached_tokens_written: st.cached_tokens_written,
      turns: st.turns,
      source: "claude",
      claude_turns: summary.turns
    };
  } catch {
    return ZERO_NONE;
  }
}
function safeReaddir(dir) {
  try {
    return fs3.readdirSync(dir);
  } catch {
    return [];
  }
}
function safeStatIsDir(p) {
  try {
    return fs3.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function walkFiles(root, maxDepth = 6) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    for (const entry of safeReaddir(dir)) {
      const full = path2.join(dir, entry);
      try {
        const st = fs3.statSync(full);
        if (st.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
        else if (st.isFile()) out.push(full);
      } catch {
      }
    }
  }
  return out;
}
function parseCursorTranscript(sessionId) {
  try {
    if (!sessionId || sessionId === String(process.pid)) return ZERO_NONE;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return ZERO_NONE;
    }
    const dbPaths = [
      path2.join(os2.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
      path2.join(os2.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb")
    ];
    const dbPath = dbPaths.find((p) => {
      try {
        return fs3.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!dbPath) return ZERO_NONE;
    try {
      execFileSync2("which", ["sqlite3"], { timeout: 2e3, stdio: "ignore" });
    } catch {
      process.stderr.write("agent-transcript-parsers: sqlite3 not found on PATH, skipping Cursor transcript parsing\n");
      return ZERO_NONE;
    }
    const sql = `SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${sessionId}:%'`;
    let output;
    try {
      output = execFileSync2("sqlite3", ["-json", dbPath, sql], {
        encoding: "utf-8",
        timeout: 8e3,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return ZERO_NONE;
    }
    if (!output.trim()) return ZERO_NONE;
    const totals = zero("cursor");
    let rows;
    try {
      rows = JSON.parse(output);
    } catch {
      return ZERO_NONE;
    }
    for (const row of rows) {
      try {
        const bubble = JSON.parse(row.value);
        if (bubble.type !== 2) continue;
        totals.turns += 1;
        const tc = bubble.tokenCount;
        if (tc) {
          totals.input_tokens += tc.inputTokens ?? 0;
          totals.output_tokens += tc.outputTokens ?? 0;
        }
        if ((tc?.outputTokens ?? 0) === 0 && bubble.text) {
          totals.output_tokens += Math.ceil(bubble.text.length / 4);
        }
      } catch {
      }
    }
    try {
      const composerSql = `SELECT value FROM cursorDiskKV WHERE key='composerData:${sessionId}'`;
      const composerOut = execFileSync2("sqlite3", ["-json", dbPath, composerSql], {
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["ignore", "pipe", "ignore"]
      });
      if (composerOut.trim()) {
        const composerRows = JSON.parse(composerOut.trim());
        if (composerRows[0]) {
          const cd = JSON.parse(composerRows[0].value);
        }
      }
    } catch {
    }
    if (totals.turns === 0) return ZERO_NONE;
    if (totals.input_tokens === 0) {
      try {
        const rows2 = readSessionLogAcrossCommits("compactions.jsonl");
        let estimate = 0;
        for (const r of rows2) {
          if (r.ai_tool && r.ai_tool !== "cursor") continue;
          if (r.session_id && sessionId && r.session_id !== sessionId) continue;
          if (typeof r.context_tokens === "number" && r.context_tokens > 0) {
            estimate = r.context_tokens;
          }
        }
        if (estimate > 0) totals.input_tokens = estimate;
      } catch {
      }
    }
    return totals;
  } catch {
    return ZERO_NONE;
  }
}
function parseCodexTranscript(sessionId) {
  try {
    const codexDir = path2.join(os2.homedir(), ".codex");
    let sessionFilePath = null;
    try {
      const indexPath = path2.join(codexDir, "session_index.jsonl");
      const indexText = fs3.readFileSync(indexPath, "utf-8");
      for (const rawLine of indexText.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.id === sessionId && entry.file) {
            sessionFilePath = path2.isAbsolute(entry.file) ? entry.file : path2.join(codexDir, entry.file);
            break;
          }
        } catch {
        }
      }
    } catch {
    }
    if (!sessionFilePath && sessionId.length >= 8) {
      try {
        const prefix = sessionId.slice(0, 8);
        const indexPath = path2.join(codexDir, "session_index.jsonl");
        const indexText = fs3.readFileSync(indexPath, "utf-8");
        let bestEntry = null;
        for (const rawLine of indexText.split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.id && entry.id.startsWith(prefix) && entry.file) {
              bestEntry = entry;
            }
          } catch {
          }
        }
        if (bestEntry?.file) {
          sessionFilePath = path2.isAbsolute(bestEntry.file) ? bestEntry.file : path2.join(codexDir, bestEntry.file);
        }
      } catch {
      }
    }
    if (!sessionFilePath) {
      const sessionsDir = path2.join(codexDir, "sessions");
      if (!safeStatIsDir(sessionsDir)) {
      } else {
        const candidates = walkFiles(sessionsDir, 6).filter(
          (f) => path2.basename(f).startsWith("rollout-") && f.endsWith(".jsonl")
        );
        if (candidates.length > 0) {
          const byName = candidates.filter((f) => f.includes(sessionId));
          if (byName.length > 0) {
            sessionFilePath = byName[0];
          } else {
            if (sessionId.length >= 8) {
              const prefix = sessionId.slice(0, 8);
              const byPrefix = candidates.filter((f) => path2.basename(f).includes(prefix));
              if (byPrefix.length > 0) {
                sessionFilePath = byPrefix[byPrefix.length - 1];
              }
            }
            if (!sessionFilePath) {
              for (const fp of candidates) {
                try {
                  const content = fs3.readFileSync(fp, "utf-8");
                  const firstLine = content.split("\n", 1)[0] ?? "";
                  if (firstLine.includes(sessionId)) {
                    sessionFilePath = fp;
                    break;
                  }
                } catch {
                }
              }
            }
          }
        }
      }
    }
    if (!sessionFilePath) {
      try {
        const sqliteDb = path2.join(codexDir, "state_5.sqlite");
        if (fs3.statSync(sqliteDb).isFile()) {
          try {
            execFileSync2("which", ["sqlite3"], { timeout: 2e3, stdio: "ignore" });
          } catch {
            throw new Error("sqlite3 not available");
          }
          const cwd = process.cwd();
          const sql = `SELECT rollout_path FROM threads WHERE cwd='${cwd.replace(/'/g, "''")}' ORDER BY updated_at_ms DESC LIMIT 1`;
          const output = execFileSync2("sqlite3", ["-json", sqliteDb, sql], {
            encoding: "utf-8",
            timeout: 5e3,
            stdio: ["ignore", "pipe", "ignore"]
          });
          if (output.trim()) {
            const rows = JSON.parse(output.trim());
            if (rows[0]?.rollout_path) {
              const rp = rows[0].rollout_path;
              const resolved = path2.isAbsolute(rp) ? rp : path2.join(codexDir, rp);
              if (fs3.statSync(resolved).isFile()) {
                sessionFilePath = resolved;
              }
            }
          }
        }
      } catch {
      }
    }
    if (!sessionFilePath) return ZERO_NONE;
    return parseCodexRolloutFile(sessionFilePath);
  } catch {
    return ZERO_NONE;
  }
}
function parseCodexRolloutFile(sessionFilePath) {
  const totals = zero("codex");
  let maxCumulativeTotal = -1;
  try {
    const content = fs3.readFileSync(sessionFilePath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "event_msg" && obj.payload?.type === "token_count" || obj.type === "token_count") {
          const ttu = obj.payload?.info?.total_token_usage;
          if (ttu) {
            const cum = typeof ttu.total_tokens === "number" ? ttu.total_tokens : (ttu.input_tokens ?? 0) + (ttu.output_tokens ?? 0);
            if (maxCumulativeTotal >= 0 && cum < maxCumulativeTotal) {
              totals.input_tokens = 0;
              totals.output_tokens = 0;
              totals.cached_tokens_read = 0;
              totals.turns = 0;
              maxCumulativeTotal = -1;
            }
            if (cum > maxCumulativeTotal) maxCumulativeTotal = cum;
            const cachedCum = typeof ttu.cached_input_tokens === "number" ? ttu.cached_input_tokens : 0;
            if (typeof ttu.input_tokens === "number") totals.input_tokens = Math.max(0, ttu.input_tokens - cachedCum);
            if (typeof ttu.output_tokens === "number") totals.output_tokens = ttu.output_tokens;
            if (typeof ttu.cached_input_tokens === "number") totals.cached_tokens_read = ttu.cached_input_tokens;
          }
        }
        if (obj.type === "response_item") {
          totals.turns += 1;
          const usage = obj.usage;
          if (usage?.output_tokens) {
          } else {
            const textContent = Array.isArray(obj.content) ? obj.content.filter((c) => c.type === "output_text" && typeof c.text === "string").map((c) => c.text ?? "").join("") : "";
            if (textContent && totals.output_tokens === 0) {
              totals.output_tokens += Math.ceil(textContent.length / 4);
            }
          }
        } else if (obj.type !== "event_msg") {
          const usage = obj.usage;
          if (usage) {
            if (typeof usage.input_tokens === "number") totals.input_tokens += usage.input_tokens;
            if (typeof usage.output_tokens === "number") totals.output_tokens += usage.output_tokens;
          }
        }
      } catch {
      }
    }
  } catch {
    return ZERO_NONE;
  }
  if (totals.turns === 0 && totals.input_tokens === 0 && totals.output_tokens === 0) {
    return ZERO_NONE;
  }
  return totals;
}
function parseFactoryTranscript(sessionId) {
  try {
    if (!sessionId || sessionId === String(process.pid)) return zero("factory");
    const sessionsDir = path2.join(os2.homedir(), ".factory", "sessions");
    if (!safeStatIsDir(sessionsDir)) return zero("factory");
    let sessionFile = null;
    for (const wsDir of safeReaddir(sessionsDir)) {
      const candidate = path2.join(sessionsDir, wsDir, `${sessionId}.jsonl`);
      try {
        if (fs3.statSync(candidate).isFile()) {
          sessionFile = candidate;
          break;
        }
      } catch {
      }
    }
    if (!sessionFile) return zero("factory");
    return parseFactoryFile(sessionFile);
  } catch {
    return zero("factory");
  }
}
function parseFactoryFile(sessionFile) {
  const totals = zero("factory");
  let content;
  try {
    content = fs3.readFileSync(sessionFile, "utf-8");
  } catch {
    return zero("factory");
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message" && ev.role === "assistant") {
        totals.turns += 1;
        if (!ev.usage && typeof ev.content === "string" && ev.content) {
          totals.output_tokens += Math.ceil(ev.content.length / 4);
        }
      }
      if (ev.usage) {
        const u = ev.usage;
        const inputRaw = u.input_tokens ?? u.prompt_tokens ?? 0;
        const cachedRead = u.cached_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
        totals.input_tokens += cachedRead > 0 ? Math.max(0, inputRaw - cachedRead) : inputRaw;
        totals.output_tokens += u.output_tokens ?? u.completion_tokens ?? 0;
        if (cachedRead > 0) totals.cached_tokens_read += cachedRead;
      }
    } catch {
    }
  }
  if (totals.turns === 0 && totals.input_tokens === 0 && totals.output_tokens === 0) {
    return zero("factory");
  }
  return totals;
}
function parseOpenCodeTranscript(sessionId) {
  try {
    if (!sessionId || sessionId === String(process.pid)) return zero("opencode");
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) {
      return zero("opencode");
    }
    const dbPaths = [
      path2.join(os2.homedir(), ".local", "share", "opencode", "opencode.db"),
      path2.join(os2.homedir(), "Library", "Application Support", "ai.opencode.desktop", "opencode.db"),
      path2.join(os2.homedir(), ".opencode", "opencode.db")
    ];
    const dbPath = dbPaths.filter((p) => {
      try {
        return fs3.statSync(p).isFile() && fs3.statSync(p).size > 0;
      } catch {
        return false;
      }
    }).sort((a, b) => fs3.statSync(b).size - fs3.statSync(a).size)[0];
    if (!dbPath) return zero("opencode");
    try {
      execFileSync2("which", ["sqlite3"], { timeout: 2e3, stdio: "ignore" });
    } catch {
      process.stderr.write("agent-transcript-parsers: sqlite3 not found on PATH, skipping OpenCode transcript parsing\n");
      return zero("opencode");
    }
    const sql = `SELECT json_extract(data,'$.tokens.input') AS input, json_extract(data,'$.tokens.output') AS output, json_extract(data,'$.tokens.reasoning') AS reasoning, json_extract(data,'$.tokens.cache.read') AS cache_read, json_extract(data,'$.tokens.cache.write') AS cache_write FROM message WHERE session_id='${sessionId}' AND json_extract(data,'$.role')='assistant' ORDER BY time_created`;
    let output;
    try {
      output = execFileSync2("sqlite3", ["-json", dbPath, sql], {
        encoding: "utf-8",
        timeout: 8e3,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return zero("opencode");
    }
    if (!output.trim()) return zero("opencode");
    let rows;
    try {
      rows = JSON.parse(output);
    } catch {
      return zero("opencode");
    }
    const totals = zero("opencode");
    for (const row of rows) {
      totals.turns += 1;
      totals.input_tokens += row.input ?? 0;
      totals.output_tokens += (row.output ?? 0) + (row.reasoning ?? 0);
      totals.cached_tokens_read += row.cache_read ?? 0;
      totals.cached_tokens_written += row.cache_write ?? 0;
    }
    if (totals.turns === 0 && totals.input_tokens === 0 && totals.output_tokens === 0) {
      return zero("opencode");
    }
    return totals;
  } catch {
    return zero("opencode");
  }
}
function parseTranscriptFile(agent, transcriptPath) {
  try {
    switch (agent) {
      case "claude":
        return claudeTranscriptResult(transcriptPath);
      case "codex":
        return parseCodexRolloutFile(transcriptPath);
      case "factory":
        return parseFactoryFile(transcriptPath);
      default:
        return ZERO_NONE;
    }
  } catch {
    return ZERO_NONE;
  }
}
function parseOpencodeSession(sessionId) {
  return parseOpenCodeTranscript(sessionId);
}
function parseAgentTranscript(agent, sessionId, transcriptPath) {
  try {
    switch (agent) {
      case "claude":
        return claudeTranscriptResult(transcriptPath);
      case "cursor":
        return parseCursorTranscript(sessionId);
      case "codex":
        return parseCodexTranscript(sessionId);
      case "factory":
        return parseFactoryTranscript(sessionId);
      case "opencode":
        return parseOpenCodeTranscript(sessionId);
      default:
        return ZERO_NONE;
    }
  } catch {
    return ZERO_NONE;
  }
}
export {
  parseAgentTranscript,
  parseCodexRolloutFile,
  parseFactoryFile,
  parseOpencodeSession,
  parseTranscriptFile
};

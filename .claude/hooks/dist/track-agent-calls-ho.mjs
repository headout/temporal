#!/usr/bin/env node

// src/track-agent-calls-ho.ts
import { readFileSync as readFileSync4 } from "fs";

// src/telemetry-core-ho.ts
import { execSync, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
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
    email = os.userInfo().username || "unknown";
  }
  try {
    name = execSync("git config user.name", { encoding: "utf-8", timeout: 5e3 }).trim();
  } catch {
    name = os.userInfo().username || "unknown";
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
var BREAKER_DIR = path.join(os.homedir(), ".cache", "hac-telemetry");
var BREAKER_FILE = path.join(BREAKER_DIR, "breaker.json");
var BREAKER_LOCK_FILE = BREAKER_FILE + ".lock";
var CURL_SUCCESS_DIR = path.join(os.tmpdir(), "hac-curl-ok");
var BREAKER_FAILURE_WINDOW_MS = 30 * 60 * 1e3;
var BREAKER_COOLDOWN_MS = 5 * 60 * 1e3;
var BREAKER_ATTEMPT_DECAY_MS = 10 * 60 * 1e3;
var _heldLocks = /* @__PURE__ */ new Set();
function withFileLock(lockFile, fn) {
  if (_heldLocks.has(lockFile)) {
    return fn();
  }
  let acquired = false;
  const STALE_MS = 6e4;
  for (let i = 0; i < 10; i++) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
      } catch {
      }
      fs.closeSync(fd);
      acquired = true;
      _heldLocks.add(lockFile);
      break;
    } catch {
      try {
        const pidStr = fs.readFileSync(lockFile, "utf-8").trim();
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
            const st = fs.statSync(lockFile);
            if (Date.now() - st.mtimeMs > STALE_MS) stale = true;
          } catch {
          }
        }
        if (stale) {
          try {
            fs.unlinkSync(lockFile);
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
        fs.unlinkSync(lockFile);
      } catch {
      }
    }
  }
}
function incrementDropCounter(reason, by = 1) {
  if (!Number.isFinite(by) || by <= 0) return;
  try {
    const baseDir = getTelemetryBaseDir();
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const p = path.join(baseDir, "drop_counters.json");
    withFileLock(p + ".lock", () => {
      let counts = {};
      try {
        if (fs.existsSync(p)) counts = JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch {
        counts = {};
      }
      counts[reason] = (typeof counts[reason] === "number" ? counts[reason] : 0) + by;
      try {
        fs.writeFileSync(p, JSON.stringify(counts), "utf-8");
      } catch {
      }
    });
  } catch {
  }
}
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
  return path.join(base, sha);
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
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    const line = JSON.stringify(data) + "\n";
    withFileLock(filePath + ".lock", () => {
      fs.appendFileSync(filePath, line, "utf-8");
    });
  } catch {
    try {
      incrementDropCounter("capture_exception");
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
    _cachedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
    return _cachedGitDir;
  } catch {
    return null;
  }
}
var CONCURRENT_SESSION_STALE_MS = 45 * 60 * 1e3;
var POINTER_DEBOUNCE_MS = 30 * 1e3;
function hashPrompt(s) {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}
function promptTextDisabled() {
  const v = (process.env.HAC_SEND_PROMPT_TEXT ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return true;
  return false;
}

// src/agent-transcript-parsers-ho.ts
import * as fs3 from "fs";
import * as path2 from "path";
import * as os2 from "os";
import { execFileSync as execFileSync2 } from "child_process";

// src/claude-transcript-parser-ho.ts
import * as fs2 from "fs";
import { createHash as createHash2 } from "crypto";
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
  return createHash2("sha1").update(input, "utf-8").digest("hex");
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

// src/track-agent-calls-ho.ts
function readStdin() {
  try {
    return readFileSync4(0, "utf-8");
  } catch {
    return "{}";
  }
}
function asNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function asStr(v) {
  return typeof v === "string" && v ? v : void 0;
}
function tokensFromTranscript(p) {
  if (!p) return void 0;
  try {
    const content = readFileSync4(p, "utf-8");
    let input = 0;
    let output = 0;
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        const usage = obj.usage ?? obj.payload?.usage;
        if (usage) {
          input += asNum(usage.input_tokens) ?? 0;
          output += asNum(usage.output_tokens) ?? 0;
        }
      } catch {
      }
    }
    return input || output ? { input, output } : void 0;
  } catch {
    return void 0;
  }
}
async function main() {
  const watchdog = installHookWatchdog(8e3);
  try {
    const raw = readStdin();
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      input = {};
    }
    const toolName = input.tool_name ?? "";
    const eventName = (input.hook_event_name ?? process.env.HOOK_EVENT ?? "").toLowerCase();
    const isSubagentStart = eventName.includes("subagentstart");
    const isSubagentStop = !isSubagentStart && (eventName.includes("subagentstop") || // Field-shape detection for agents that don't pass hook_event_name.
    toolName !== "Task" && (input.subagent_type !== void 0 || input.agent_transcript_path !== void 0 || input.tool_call_count !== void 0));
    if (toolName !== "Task" && !isSubagentStart && !isSubagentStop) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const agent = aiToolFromHookEnv() ?? detectAiTool();
    const workstreamId = computeWorkstreamId();
    if (isSubagentStart) {
      const startRecord = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "subagent_start",
        ai_tool: agent,
        subagent_type: asStr(input.subagent_type ?? input.agent_type) ?? "general-purpose",
        ...asStr(input.agent_id) ? { agent_id: asStr(input.agent_id) } : {},
        ...asStr(input.task ?? input.description) ? { task: asStr(input.task ?? input.description) } : {}
      };
      appendSessionLog(workstreamId, "task_tool_invocations.jsonl", startRecord);
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    if (isSubagentStop) {
      const durMs = asNum(input.duration_ms);
      const transcriptPath = input.agent_transcript_path ?? input.transcript_path;
      let tokens;
      if (input.tokens && ((input.tokens.input ?? 0) > 0 || (input.tokens.output ?? 0) > 0)) {
        tokens = {
          input: asNum(input.tokens.input) ?? 0,
          output: asNum(input.tokens.output) ?? 0,
          ...asNum(input.tokens.cached_read) ? { cached_read: asNum(input.tokens.cached_read) } : {}
        };
      } else if (agent === "opencode" && asStr(input.leaf_session_id)) {
        const r = parseOpencodeSession(asStr(input.leaf_session_id));
        if (r.input_tokens > 0 || r.output_tokens > 0) {
          tokens = {
            input: r.input_tokens,
            output: r.output_tokens,
            ...r.cached_tokens_read > 0 ? { cached_read: r.cached_tokens_read } : {}
          };
        }
      } else if (transcriptPath) {
        const r = parseTranscriptFile(agent, transcriptPath);
        if (r.input_tokens > 0 || r.output_tokens > 0) {
          tokens = {
            input: r.input_tokens,
            output: r.output_tokens,
            ...r.cached_tokens_read > 0 ? { cached_read: r.cached_tokens_read } : {}
          };
        } else if (agent === "claude") {
          tokens = tokensFromTranscript(transcriptPath);
        }
      }
      const subagentRecord = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "subagent_stop",
        ai_tool: agent,
        subagent_type: asStr(input.subagent_type ?? input.agent_type) ?? "general-purpose",
        status: asStr(input.status) ?? "completed",
        ...asStr(input.agent_id) ? { agent_id: asStr(input.agent_id) } : {},
        ...durMs !== void 0 ? { duration_sec: +(durMs / 1e3).toFixed(1) } : {},
        ...asNum(input.tool_call_count) !== void 0 ? { tool_calls: asNum(input.tool_call_count) } : {},
        ...asNum(input.message_count) !== void 0 ? { message_count: asNum(input.message_count) } : {},
        ...Array.isArray(input.modified_files) ? { files_touched: input.modified_files.length } : {},
        ...tokens ? { tokens } : {},
        // codex/factory SubagentStop payloads may omit the session id; wrappers export HOOK_SESSION_ID
        ...asStr(input.conversation_id ?? input.session_id) ?? process.env.HOOK_SESSION_ID ? { parent_session_id: asStr(input.conversation_id ?? input.session_id) ?? process.env.HOOK_SESSION_ID } : {}
      };
      appendSessionLog(workstreamId, "task_tool_invocations.jsonl", subagentRecord);
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    if (agent === "claude") {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const toolInput = input.tool_input ?? {};
    const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
    const subagentType = typeof toolInput.subagent_type === "string" && toolInput.subagent_type ? toolInput.subagent_type : "general-purpose";
    const description = typeof toolInput.description === "string" ? toolInput.description : "";
    const agentRecord = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      kind: "subagent_spawn",
      ai_tool: agent,
      subagent_type: subagentType,
      description,
      prompt_length_chars: prompt.length
    };
    if (promptTextDisabled()) {
      agentRecord.prompt_fingerprint = hashPrompt(prompt);
      agentRecord.prompt_stored = "hash";
    } else {
      agentRecord.prompt = prompt;
      agentRecord.prompt_stored = "text";
    }
    appendSessionLog(workstreamId, "task_tool_invocations.jsonl", agentRecord);
    console.log(JSON.stringify({ result: "continue" }));
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
  } finally {
    clearTimeout(watchdog);
  }
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});

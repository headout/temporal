#!/usr/bin/env node

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
var GIT_TELEMETRY_MARKER = "# === HeadoutAgentsConfig Telemetry ===";
var GIT_TELEMETRY_END_MARKER = "# === End Telemetry ===";
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
function resetCaches() {
  _cachedRepoRoot = null;
  _cachedGitDir = null;
  _cachedMainGitDir = null;
  _cachedDeveloper = null;
  _cachedRepo = null;
  _cachedWorkstreamId = null;
  _cachedTelemetryBaseDir = null;
  _cachedHeadSha = null;
  _headShaResolved = false;
}
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
var BREAKER_DIR = path.join(os.homedir(), ".cache", "hac-telemetry");
var BREAKER_FILE = path.join(BREAKER_DIR, "breaker.json");
var BREAKER_LOCK_FILE = BREAKER_FILE + ".lock";
var CURL_SUCCESS_DIR = path.join(os.tmpdir(), "hac-curl-ok");
var BREAKER_FAILURE_WINDOW_MS = 30 * 60 * 1e3;
var BREAKER_COOLDOWN_MS = 5 * 60 * 1e3;
var BREAKER_ATTEMPT_THRESHOLD = 10;
var BREAKER_ATTEMPT_DECAY_MS = 10 * 60 * 1e3;
function readBreaker() {
  try {
    const raw = fs.readFileSync(BREAKER_FILE, "utf-8");
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
    if (!fs.existsSync(BREAKER_DIR)) fs.mkdirSync(BREAKER_DIR, { recursive: true });
    const tmp = BREAKER_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs.renameSync(tmp, BREAKER_FILE);
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
    const dir = path.join(baseDir, ".telemetry");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rejectPath = path.join(dir, "reject.log");
    const entry = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      code,
      payload: body.slice(0, 2048)
    }) + "\n";
    withFileLock(rejectPath + ".lock", () => {
      try {
        if (fs.existsSync(rejectPath)) {
          const st = fs.statSync(rejectPath);
          if (st.size + entry.length > 1024 * 1024) {
            try {
              fs.renameSync(rejectPath, rejectPath + ".1");
            } catch {
            }
          }
        }
      } catch {
      }
      try {
        fs.appendFileSync(rejectPath, entry, "utf-8");
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
function getRetryQueuePath() {
  try {
    const baseDir = getTelemetryBaseDir();
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    return path.join(baseDir, "retry_queue.jsonl");
  } catch {
    return null;
  }
}
function retryUnsentEvents(maxPerCall = 3) {
  try {
    const p = getRetryQueuePath();
    if (!p || !fs.existsSync(p)) return;
    withFileLock(p + ".lock", () => {
      if (!fs.existsSync(p)) return;
      const raw = fs.readFileSync(p, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length === 0) {
        try {
          fs.unlinkSync(p);
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
          const dedupDir = path.join(getTelemetryBaseDir(), "emitted_shas");
          const dedupFile = path.join(dedupDir, evt.commit_sha);
          if (fs.existsSync(dedupFile)) continue;
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
          fs.unlinkSync(p);
        } catch {
        }
      } else {
        fs.writeFileSync(tmp, remaining.join("\n") + "\n", "utf-8");
        fs.renameSync(tmp, p);
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
    const out = execFileSync("curl", [
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
    _cachedTelemetryBaseDir = path.join(gitDir, "hac_telemetry");
  } else {
    _cachedTelemetryBaseDir = path.join(process.cwd(), ".git", "hac_telemetry");
  }
  return _cachedTelemetryBaseDir;
}
function computeWorkstreamId() {
  if (_cachedWorkstreamId) return _cachedWorkstreamId;
  const repo = getRepoContext();
  const dev = getDeveloperContext();
  const raw = `${repo.local_path}::${repo.branch}::${dev.email}`;
  _cachedWorkstreamId = createHash("sha256").update(raw, "utf-8").digest("hex");
  return _cachedWorkstreamId;
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
function getConfiguredGitHookPath(repoRoot, hookName) {
  let hooksPathFromConfig = null;
  try {
    hooksPathFromConfig = execSync("git config --get core.hooksPath", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim() || null;
  } catch {
    hooksPathFromConfig = null;
  }
  if (!hooksPathFromConfig) {
    const gitDir = getGitDirAbsolute(repoRoot);
    if (!gitDir) return null;
    return path.join(gitDir, "hooks", hookName);
  }
  const normalized = hooksPathFromConfig.replace(/[/\\]+$/, "");
  const normForward = normalized.replace(/\\/g, "/");
  if (normForward.endsWith(".husky/_")) {
    return path.join(repoRoot, ".husky", hookName);
  }
  const hooksDir = path.isAbsolute(normalized) ? normalized : path.join(repoRoot, normalized);
  return path.join(hooksDir, hookName);
}
function isHuskyHooksLayout(repoRoot) {
  try {
    const p = execSync("git config --get core.hooksPath", {
      encoding: "utf-8",
      timeout: 5e3,
      cwd: repoRoot
    }).trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return p.endsWith(".husky/_");
  } catch {
    return false;
  }
}
function ensureHuskyUnderscoreStub(repoRoot, hookName) {
  try {
    if (!isHuskyHooksLayout(repoRoot)) return;
    const hRunner = path.join(repoRoot, ".husky", "_", "h");
    if (!fs.existsSync(hRunner)) return;
    try {
      fs.chmodSync(hRunner, 493);
    } catch {
    }
    const stubPath = path.join(repoRoot, ".husky", "_", hookName);
    if (fs.existsSync(stubPath)) return;
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    const body = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    fs.writeFileSync(stubPath, body, { encoding: "utf-8" });
    fs.chmodSync(stubPath, 493);
  } catch {
  }
}
function ensureGitTelemetryPostCommitHook(repoRoot) {
  try {
    const resolvedRepoRoot = repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!resolvedRepoRoot) return;
    ensureHuskyUnderscoreStub(resolvedRepoRoot, "post-commit");
    const postCommitPath = getConfiguredGitHookPath(resolvedRepoRoot, "post-commit");
    if (!postCommitPath) return;
    fs.mkdirSync(path.dirname(postCommitPath), { recursive: true });
    if (fs.existsSync(postCommitPath)) {
      try {
        const existing = fs.readFileSync(postCommitPath, "utf-8");
        if (existing.includes(GIT_TELEMETRY_MARKER) && existing.includes(GIT_TELEMETRY_END_MARKER)) {
          return;
        }
      } catch {
      }
    }
    let content = "";
    if (fs.existsSync(postCommitPath)) {
      try {
        content = fs.readFileSync(postCommitPath, "utf-8");
      } catch {
        content = "";
      }
    }
    if (!content.startsWith("#!")) {
      content = `#!/bin/bash
${content}`;
    }
    const startIdx = content.indexOf(GIT_TELEMETRY_MARKER);
    const endIdx = content.indexOf(GIT_TELEMETRY_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const afterEnd = endIdx + GIT_TELEMETRY_END_MARKER.length;
      content = content.slice(0, startIdx) + content.slice(afterEnd);
    }
    if (!content.endsWith("\n")) content += "\n";
    const block = [
      GIT_TELEMETRY_MARKER,
      "(",
      '  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0',
      '  for dir in "$REPO_ROOT/.claude/hooks/dist" "$HOME/.claude/hooks/dist"; do',
      '    if [ -f "$dir/post-commit-telemetry-ho.mjs" ]; then',
      '      node "$dir/post-commit-telemetry-ho.mjs" "$REPO_ROOT" &',
      "      break",
      "    fi",
      "  done",
      ") &",
      GIT_TELEMETRY_END_MARKER,
      ""
    ].join("\n");
    fs.writeFileSync(postCommitPath, content + block, { encoding: "utf-8" });
    fs.chmodSync(postCommitPath, 493);
  } catch (e) {
    process.stderr.write(`[telemetry] Warning: failed to install post-commit git hook: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
var ACTIVE_SESSIONS_CAP = 16;
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
function mergeConcurrentSessionEntries(existing, incoming) {
  const now = Date.now();
  const map = /* @__PURE__ */ new Map();
  for (const e of existing) {
    if (!e.session_id) continue;
    const ts = new Date(e.updated_at).getTime();
    if (!Number.isFinite(ts) || now - ts > CONCURRENT_SESSION_STALE_MS) continue;
    map.set(e.session_id, e);
  }
  map.set(incoming.session_id, incoming);
  return Array.from(map.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, ACTIVE_SESSIONS_CAP);
}
function readActiveSessionPointerFromPath(pointerPath) {
  try {
    if (!fs.existsSync(pointerPath)) return null;
    return JSON.parse(fs.readFileSync(pointerPath, "utf-8"));
  } catch {
    return null;
  }
}
function refreshConcurrentSessionPointer(sessionId, ai_tool, ai_model) {
  try {
    const toplevel = getRepoRootFromGit(process.cwd());
    if (!toplevel) return;
    const gitDir = getGitDirAbsolute(toplevel);
    if (!gitDir) return;
    const baseDir = getTelemetryBaseDir();
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const pointerPath = path.join(baseDir, "concurrent_ai_sessions.json");
    const tmpPath = pointerPath + ".tmp." + process.pid;
    const lockPath = pointerPath + ".lock";
    withFileLock(lockPath, () => {
      const prev = readActiveSessionPointerFromPath(pointerPath);
      const prevEntries = getConcurrentSessionsFromPointer(prev);
      const existingForSession = prevEntries.find((e) => e.session_id === sessionId);
      if (existingForSession && existingForSession.ai_tool === ai_tool && Date.now() - new Date(existingForSession.updated_at).getTime() < POINTER_DEBOUNCE_MS) {
        return;
      }
      const incoming = {
        session_id: sessionId,
        ai_tool,
        updated_at: (/* @__PURE__ */ new Date()).toISOString(),
        ...ai_model ? { ai_model } : {}
      };
      const merged = mergeConcurrentSessionEntries(prevEntries, incoming);
      const pointer = {
        session_id: sessionId,
        workstream_id: computeWorkstreamId(),
        ai_tool,
        updated_at: incoming.updated_at,
        ...ai_model ? { ai_model } : {},
        concurrent_ai_sessions: merged
      };
      fs.writeFileSync(tmpPath, JSON.stringify(pointer, null, 2) + "\n", "utf-8");
      fs.renameSync(tmpPath, pointerPath);
    });
  } catch {
  }
}

// src/codex-notify-ho.ts
function parseNotification(arg) {
  if (!arg) return {};
  try {
    return JSON.parse(arg);
  } catch {
    return {};
  }
}
function main() {
  try {
    const notification = parseNotification(process.argv[2]);
    const sessionId = String(notification["thread-id"] || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.pid);
    const cwd = typeof notification.cwd === "string" && notification.cwd ? notification.cwd : void 0;
    if (cwd) {
      try {
        process.chdir(cwd);
        resetCaches();
      } catch {
      }
    }
    const isPidFallback = /^\d+$/.test(sessionId);
    if (!isPidFallback) {
      refreshConcurrentSessionPointer(sessionId, "codex");
    }
    ensureGitTelemetryPostCommitHook(cwd);
    try {
      retryUnsentEvents();
    } catch {
    }
  } catch {
  }
}
main();

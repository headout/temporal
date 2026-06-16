// src/telemetry-core-ho.ts
import { execSync, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
function readHooksVersion() {
  try {
    const v = (process.env.HAC_VERSION ?? "").trim();
    return v || "unknown";
  } catch {
    return "unknown";
  }
}
function emitAgentHealth(sessionId) {
  try {
    const sid = sessionId || "unknown";
    const baseDir = getTelemetryBaseDir();
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const marker = path.join(baseDir, `agent_health_${sid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48)}.sent`);
    try {
      fs.writeFileSync(marker, "", { flag: "wx" });
    } catch {
      return;
    }
    const ctx = buildContext(sid);
    const isPid = /^\d+$/.test(sid);
    const event = {
      event: "agent_health_trace",
      repo: { name: ctx.repo.name, branch: ctx.repo.branch },
      author: { email: ctx.user.email, name: ctx.user.name },
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      agent: ctx.ai_tool,
      session_id: sid,
      hooks_version: readHooksVersion(),
      session_id_source: isPid ? "pid_fallback" : AGENT_CAPABILITIES[ctx.ai_tool]?.session_id_source ?? "none",
      token_capture: AGENT_TOKEN_CAPABILITY[ctx.ai_tool] ?? "none"
    };
    sendEvent(event);
  } catch {
  }
}
var OMNISCIENT_URL = (process.env.HAC_OMNISCIENT_URL ?? "").trim() || "https://omniscient.test-headout.com/api/v1/events";
var CURL_TIMEOUT_SECONDS = 5;
var GIT_TELEMETRY_MARKER = "# === HeadoutAgentsConfig Telemetry ===";
var GIT_TELEMETRY_END_MARKER = "# === End Telemetry ===";
var GIT_PRE_LINT_MARKER = "# BEGIN_HAC_PRE_LINT_SNAPSHOT";
var GIT_PRE_LINT_END_MARKER = "# END_HAC_PRE_LINT_SNAPSHOT";
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
    if (!fs.existsSync(CURL_SUCCESS_DIR)) return;
    const files = fs.readdirSync(CURL_SUCCESS_DIR);
    if (files.length === 0) return;
    recordTelemetrySuccess();
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(CURL_SUCCESS_DIR, f));
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
var TOOL_ERROR_PATTERNS = [
  ["rate_limit", /rate.?limit|429|too many requests|quota exceeded|overloaded/i],
  ["timeout", /timed?.?out|timeout|etimedout|deadline exceeded/i],
  ["network", /econnrefused|econnreset|enotfound|network|connection (refused|reset|closed)|socket hang up|fetch failed|dns/i],
  ["permission", /permission denied|eacces|eperm|not permitted|unauthorized|forbidden|access denied/i],
  // file_state before not_found: "string to replace not found" is a stale-edit
  // signal, not a missing-file one — match it as file_state first.
  ["file_state", /already exists|eexist|has been (modified|changed)|stale|file changed on disk|string to replace not found|no changes to make|nothing to (commit|edit)|conflict/i],
  ["not_found", /enoent|no such file|not found|does not exist|cannot find/i],
  ["syntax", /syntax error|parse error|unexpected token|invalid syntax|compilation (error|failed)|cannot parse/i]
];
function classifyError(raw) {
  try {
    if (typeof raw !== "string" || !raw) return "other";
    for (const [cls, re] of TOOL_ERROR_PATTERNS) {
      if (re.test(raw)) return cls;
    }
    return "other";
  } catch {
    return "other";
  }
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
function shouldEmitTelemetry(event) {
  return classifyEmission(event) === "emit";
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
function readDropCounters() {
  try {
    const p = path.join(getTelemetryBaseDir(), "drop_counters.json");
    if (!fs.existsSync(p)) return void 0;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) return parsed;
    return void 0;
  } catch {
    return void 0;
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
        const st = fs.statSync(dumpPath);
        if (st.size > ROTATE_AT) {
          try {
            fs.renameSync(dumpPath, dumpPath + ".1");
          } catch {
          }
        }
      } catch {
      }
      fs.appendFileSync(dumpPath, body + "\n");
    } catch {
    }
  }
  try {
    const baseDir = getTelemetryBaseDir();
    fs.mkdirSync(baseDir, { recursive: true });
    const localPath = path.join(baseDir, "events.jsonl");
    const ROTATE_AT = 2 * 1024 * 1024;
    try {
      const st = fs.statSync(localPath);
      if (st.size > ROTATE_AT) {
        try {
          fs.renameSync(localPath, localPath + ".1");
        } catch {
        }
      }
    } catch {
    }
    fs.appendFileSync(localPath, body + "\n");
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
    const tmpFile = path.join(os.tmpdir(), `hac-event-${process.pid}-${rand}.json`);
    try {
      fs.writeFileSync(tmpFile, body, "utf-8");
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
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    return path.join(baseDir, "retry_queue.jsonl");
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
        if (fs.existsSync(p)) {
          const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
          if (lines.length >= RETRY_QUEUE_MAX_LINES) {
            const drop = lines.slice(0, lines.length - Math.floor(RETRY_QUEUE_MAX_LINES / 2));
            const keep = lines.slice(-Math.floor(RETRY_QUEUE_MAX_LINES / 2));
            try {
              const archivePath = p.replace(/\.jsonl$/, "") + ".archived";
              const ARCHIVE_CAP = 5 * 1024 * 1024;
              const toAppend = drop.join("\n") + (drop.length ? "\n" : "");
              let curSize = 0;
              try {
                curSize = fs.statSync(archivePath).size;
              } catch {
              }
              if (curSize + Buffer.byteLength(toAppend, "utf-8") > ARCHIVE_CAP) {
                let existing = "";
                try {
                  existing = fs.readFileSync(archivePath, "utf-8");
                } catch {
                }
                const all = (existing + toAppend).split("\n").filter(Boolean);
                while (all.length > 0 && Buffer.byteLength(all.join("\n") + "\n", "utf-8") > ARCHIVE_CAP) {
                  all.shift();
                }
                fs.writeFileSync(archivePath, all.join("\n") + (all.length ? "\n" : ""), "utf-8");
              } else {
                fs.appendFileSync(archivePath, toAppend, "utf-8");
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
            fs.writeFileSync(p, keep.join("\n") + "\n", "utf-8");
          }
        }
      } catch {
      }
      fs.appendFileSync(p, JSON.stringify(event) + "\n", "utf-8");
    });
  } catch {
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
    _cachedMainGitDir = path.isAbsolute(out) ? out : path.resolve(repoRoot ?? process.cwd(), out);
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
    const norm = path.resolve(p);
    if (seen.has(norm)) return;
    seen.add(norm);
    dirs.push(norm);
  };
  push(getTelemetryBaseDir());
  const main = getMainRepoGitDir();
  if (main) push(path.join(main, "hac_telemetry"));
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
  return path.join(base, sha);
}
function getCommitDir(sha) {
  return path.join(getTelemetryBaseDir(), sha);
}
function commitRecordExistsFor(sha) {
  for (const baseDir of getTelemetryBaseDirsForRead()) {
    const filePath = path.join(baseDir, "ai_commit_records.jsonl");
    if (!fs.existsSync(filePath)) continue;
    try {
      for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
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
    const output = execFileSync("git", ["show", "--format=", "--numstat", sha], {
      encoding: "utf-8",
      timeout: 1e4,
      cwd: repoRoot
    }).trim();
    if (!output) return [];
    const entries = [];
    for (const line of output.split("\n")) {
      const parts = line.split("	");
      if (parts.length < 3) continue;
      const [added, deleted, ...pathParts] = parts;
      const filePath = pathParts.join("	");
      if (added === "-" || deleted === "-") continue;
      const linesAdded = parseInt(added, 10);
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
    if (!fs.existsSync(filePath)) return;
    try {
      for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
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
    if (!fs.existsSync(baseDir)) continue;
    consume(path.join(baseDir, "ai_commit_records.jsonl.1"));
    consume(path.join(baseDir, "ai_commit_records.jsonl"));
    let dirs = [];
    try {
      dirs = fs.readdirSync(baseDir).filter((d) => {
        try {
          return fs.statSync(path.join(baseDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      consume(path.join(baseDir, dir, "ai_commit_records.jsonl"));
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
      const newShaDir = path.join(getTelemetryBaseDir(), newSha);
      fs.mkdirSync(newShaDir, { recursive: true });
      const recordPath = path.join(newShaDir, "ai_commit_records.jsonl");
      withFileLock(recordPath + ".lock", () => {
        const already = fs.existsSync(recordPath) && fs.readFileSync(recordPath, "utf-8").split("\n").some((l) => {
          if (!l.trim()) return false;
          try {
            const r = JSON.parse(l);
            return r.commit_sha === newSha && "files" in r;
          } catch {
            return false;
          }
        });
        if (!already) fs.appendFileSync(recordPath, JSON.stringify(newRecord) + "\n", "utf-8");
      });
    } catch {
    }
    try {
      const basePath = path.join(getTelemetryBaseDir(), "ai_commit_records.jsonl");
      withFileLock(basePath + ".lock", () => {
        const already = fs.existsSync(basePath) && fs.readFileSync(basePath, "utf-8").split("\n").some((l) => {
          if (!l.trim()) return false;
          try {
            const r = JSON.parse(l);
            return r.commit_sha === newSha && "files" in r;
          } catch {
            return false;
          }
        });
        if (!already) fs.appendFileSync(basePath, JSON.stringify(newRecord) + "\n", "utf-8");
      });
    } catch {
    }
    for (const oldSha of oldShas) {
      const tombstone = { commit_sha: oldSha, superseded_by: newSha, timestamp: nowIso };
      try {
        const basePath = path.join(getTelemetryBaseDir(), "ai_commit_records.jsonl");
        withFileLock(basePath + ".lock", () => {
          fs.mkdirSync(getTelemetryBaseDir(), { recursive: true });
          fs.appendFileSync(basePath, JSON.stringify(tombstone) + "\n", "utf-8");
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
function readSessionLog(workstreamId, filename) {
  try {
    const filePath = path.join(getSessionLogDir(workstreamId), filename);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter((line) => line.trim()).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((obj) => obj !== null);
  } catch {
    return [];
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
function fingerprintLines(lines, startIdx, fileLines) {
  return lines.map((line, i) => {
    const absIdx = startIdx + i;
    const prev = absIdx > 0 ? fileLines[absIdx - 1] : "";
    const next = absIdx < fileLines.length - 1 ? fileLines[absIdx + 1] : "";
    return {
      line_context_hash: trigramHash(prev, line, next),
      line_content_hash: lineHash(line)
    };
  });
}
function readSessionLogFromOffset(workstreamId, filename, byteOffset) {
  try {
    const filePath = path.join(getSessionLogDir(workstreamId), filename);
    if (!fs.existsSync(filePath)) return { entries: [], newOffset: byteOffset };
    const stat = fs.statSync(filePath);
    const safeOffset = byteOffset > stat.size ? 0 : byteOffset;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - safeOffset);
    fs.readSync(fd, buf, 0, buf.length, safeOffset);
    fs.closeSync(fd);
    const content = buf.toString("utf-8");
    const entries = content.split("\n").filter((line) => line.trim()).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((obj) => obj !== null);
    return { entries, newOffset: stat.size };
  } catch {
    return { entries: [], newOffset: byteOffset };
  }
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
    const filePath = path.join(base, subdir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
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
function readTailFromSessionLog(workstreamId, filename, maxBytes = 65536, commitSha) {
  const baseDirs = getTelemetryBaseDirsForRead();
  const subdir = commitSha ?? (getHeadSha() ?? "initial");
  const out = [];
  for (const base of baseDirs) {
    const filePath = path.join(base, subdir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
      const len = stat.size - start;
      if (len <= 0) continue;
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(len);
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
      let text = buf.toString("utf-8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
        }
      }
    } catch {
    }
  }
  return out;
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
function rotateCommitDir() {
  const newSha = getHeadSha();
  if (!newSha) return getActiveCommitDir();
  const newDir = path.join(getTelemetryBaseDir(), newSha);
  fs.mkdirSync(newDir, { recursive: true });
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
    const relPath = path.relative(repoRoot, absPath);
    const uncommitted = /* @__PURE__ */ new Set();
    let inHead = true;
    try {
      execFileSync("git", ["cat-file", "-e", `HEAD:${relPath}`], {
        timeout: 5e3,
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      inHead = false;
    }
    if (inHead) {
      try {
        const diffOut = execFileSync("git", ["diff", "HEAD", "--", relPath], {
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
        const workingLines = fs.readFileSync(absPath, "utf-8").split("\n");
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
      uncommittedRaw.split("\n").filter(Boolean).map((f) => path.resolve(repoRoot, f))
    );
    if (uncommittedFiles.size === 0) return;
    const oldDir = sourceDir ?? getCommitDir(oldSha);
    const newDir = getActiveCommitDir();
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
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
      uncommittedRaw.split("\n").filter(Boolean).map((f) => path.resolve(repoRoot, f))
    );
    if (uncommittedFiles.size === 0) return;
    const newDir = getActiveCommitDir();
    const uncommittedHashes = buildUncommittedHashSets(uncommittedFiles, repoRoot);
    const seenAiKeys = /* @__PURE__ */ new Set();
    for (const oldDir of sourceDirs) {
      if (oldDir === newDir || !fs.existsSync(oldDir)) continue;
      const sha = path.basename(oldDir);
      if (/^[0-9a-f]{40}$/.test(sha)) {
        let isAncestor = false;
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
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
    const toAbs = (fp) => path.isAbsolute(fp) ? fp : path.resolve(repoRoot, fp);
    const keptAiEditIds = /* @__PURE__ */ new Set();
    const aiCarried = [];
    const aiSrc = path.join(oldDir, "ai_line_fingerprints.jsonl");
    if (fs.existsSync(aiSrc)) {
      for (const line of fs.readFileSync(aiSrc, "utf-8").split("\n")) {
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
    const oldLinesSrc = path.join(oldDir, "deleted_line_fingerprints.jsonl");
    if (fs.existsSync(oldLinesSrc)) {
      for (const line of fs.readFileSync(oldLinesSrc, "utf-8").split("\n")) {
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
    const ckptSrc = path.join(oldDir, "file_snapshots.jsonl");
    const SNAPSHOT_READ_CAP = 10 * 1024 * 1024;
    if (fs.existsSync(ckptSrc) && fs.statSync(ckptSrc).size <= SNAPSHOT_READ_CAP) {
      const groups = /* @__PURE__ */ new Map();
      for (const line of fs.readFileSync(ckptSrc, "utf-8").split("\n")) {
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
    fs.mkdirSync(newDir, { recursive: true });
    if (aiCarried.length > 0) {
      fs.appendFileSync(
        path.join(newDir, "ai_line_fingerprints.jsonl"),
        aiCarried.join("\n") + "\n",
        "utf-8"
      );
    }
    if (oldCarried.length > 0) {
      fs.appendFileSync(
        path.join(newDir, "deleted_line_fingerprints.jsonl"),
        oldCarried.join("\n") + "\n",
        "utf-8"
      );
    }
    if (ckptCarried.length > 0) {
      fs.appendFileSync(
        path.join(newDir, "file_snapshots.jsonl"),
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
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    const sessionScopedFiles = [
      "prompt_context.jsonl",
      "task_tool_invocations.jsonl",
      "edits.jsonl",
      "skills.jsonl"
    ];
    for (const name of sessionScopedFiles) {
      const src = path.join(oldDir, name);
      if (!fs.existsSync(src)) continue;
      try {
        const content = fs.readFileSync(src, "utf-8");
        if (!content) continue;
        const toAppend = content.endsWith("\n") ? content : content + "\n";
        fs.appendFileSync(path.join(newDir, name), toAppend, "utf-8");
      } catch {
      }
    }
  } catch {
  }
}
function pruneOldCommitDirs(keepCount = 10) {
  const baseDir = getTelemetryBaseDir();
  if (!fs.existsSync(baseDir)) return;
  const SHA_RE = /^[0-9a-f]{40}$/;
  const dirs = fs.readdirSync(baseDir).filter((d) => SHA_RE.test(d) && fs.statSync(path.join(baseDir, d)).isDirectory()).sort((a, b) => {
    const aTime = fs.statSync(path.join(baseDir, a)).mtimeMs;
    const bTime = fs.statSync(path.join(baseDir, b)).mtimeMs;
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
          execFileSync("git", ["merge-base", "--is-ancestor", dir, "HEAD"], {
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
            carryForwardUncommittedFingerprints(dir, repoRoot, path.join(baseDir, dir));
            salvaged = true;
          } catch {
          }
        }
      }
    } catch {
    }
    if (!salvaged) {
      try {
        const emitMarker = path.join(baseDir, "emitted_shas", dir);
        if (!fs.existsSync(emitMarker)) {
          const fpFile = path.join(baseDir, dir, "ai_line_fingerprints.jsonl");
          if (fs.existsSync(fpFile)) {
            const lost = fs.readFileSync(fpFile, "utf-8").split("\n").filter((l) => l.trim()).length;
            if (lost > 0) incrementDropCounter("prune_evicted_unemitted", lost);
          }
          const ckptFile = path.join(baseDir, dir, "file_snapshots.jsonl");
          if (fs.existsSync(ckptFile)) {
            let lostCkpt = 0;
            for (const line of fs.readFileSync(ckptFile, "utf-8").split("\n")) {
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
      fs.rmSync(path.join(baseDir, dir), { recursive: true });
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
function ensureGitTelemetryPostCheckoutHook(repoRoot) {
  try {
    const resolvedRepoRoot = repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!resolvedRepoRoot) return;
    ensureHuskyUnderscoreStub(resolvedRepoRoot, "post-checkout");
    const hookPath = getConfiguredGitHookPath(resolvedRepoRoot, "post-checkout");
    if (!hookPath) return;
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    if (fs.existsSync(hookPath)) {
      try {
        const existing = fs.readFileSync(hookPath, "utf-8");
        if (existing.includes(GIT_TELEMETRY_MARKER) && existing.includes(GIT_TELEMETRY_END_MARKER)) {
          return;
        }
      } catch {
      }
    }
    let content = "";
    if (fs.existsSync(hookPath)) {
      try {
        content = fs.readFileSync(hookPath, "utf-8");
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
      '    if [ -f "$dir/post-checkout-telemetry-ho.mjs" ]; then',
      '      node "$dir/post-checkout-telemetry-ho.mjs" "$1" "$2" "$3" &',
      "      break",
      "    fi",
      "  done",
      ") &",
      GIT_TELEMETRY_END_MARKER,
      ""
    ].join("\n");
    fs.writeFileSync(hookPath, content + block, { encoding: "utf-8" });
    fs.chmodSync(hookPath, 493);
  } catch (e) {
    process.stderr.write(`[telemetry] Warning: failed to install post-checkout git hook: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
function ensureGitTelemetryPostRewriteHook(repoRoot) {
  try {
    const resolvedRepoRoot = repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!resolvedRepoRoot) return;
    ensureHuskyUnderscoreStub(resolvedRepoRoot, "post-rewrite");
    const hookPath = getConfiguredGitHookPath(resolvedRepoRoot, "post-rewrite");
    if (!hookPath) return;
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    if (fs.existsSync(hookPath)) {
      try {
        const existing = fs.readFileSync(hookPath, "utf-8");
        if (existing.includes(GIT_TELEMETRY_MARKER) && existing.includes(GIT_TELEMETRY_END_MARKER)) {
          return;
        }
      } catch {
      }
    }
    let content = "";
    if (fs.existsSync(hookPath)) {
      try {
        content = fs.readFileSync(hookPath, "utf-8");
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
      '    if [ -f "$dir/post-rewrite-telemetry-ho.mjs" ]; then',
      '      cat | node "$dir/post-rewrite-telemetry-ho.mjs" "$REPO_ROOT" &',
      "      break",
      "    fi",
      "  done",
      ") &",
      GIT_TELEMETRY_END_MARKER,
      ""
    ].join("\n");
    fs.writeFileSync(hookPath, content + block, { encoding: "utf-8" });
    fs.chmodSync(hookPath, 493);
  } catch (e) {
    process.stderr.write(`[telemetry] Warning: failed to install post-rewrite git hook: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
function ensureGitTelemetryPostMergeHook(repoRoot) {
  try {
    const resolvedRepoRoot = repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!resolvedRepoRoot) return;
    ensureHuskyUnderscoreStub(resolvedRepoRoot, "post-merge");
    const hookPath = getConfiguredGitHookPath(resolvedRepoRoot, "post-merge");
    if (!hookPath) return;
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    if (fs.existsSync(hookPath)) {
      try {
        const existing = fs.readFileSync(hookPath, "utf-8");
        if (existing.includes(GIT_TELEMETRY_MARKER) && existing.includes(GIT_TELEMETRY_END_MARKER)) {
          return;
        }
      } catch {
      }
    }
    let content = "";
    if (fs.existsSync(hookPath)) {
      try {
        content = fs.readFileSync(hookPath, "utf-8");
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
      '    if [ -f "$dir/post-merge-telemetry-ho.mjs" ]; then',
      '      node "$dir/post-merge-telemetry-ho.mjs" "$REPO_ROOT" &',
      "      break",
      "    fi",
      "  done",
      ") &",
      GIT_TELEMETRY_END_MARKER,
      ""
    ].join("\n");
    fs.writeFileSync(hookPath, content + block, { encoding: "utf-8" });
    fs.chmodSync(hookPath, 493);
  } catch (e) {
    process.stderr.write(`[telemetry] Warning: failed to install post-merge git hook: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
function ensureGitPreLintSnapshotHook(repoRoot) {
  try {
    const resolvedRepoRoot = repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!resolvedRepoRoot) return;
    ensureHuskyUnderscoreStub(resolvedRepoRoot, "pre-commit");
    const hookPath = getConfiguredGitHookPath(resolvedRepoRoot, "pre-commit");
    if (!hookPath) return;
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    if (fs.existsSync(hookPath)) {
      try {
        const existing = fs.readFileSync(hookPath, "utf-8");
        if (existing.includes(GIT_PRE_LINT_MARKER) && existing.includes(GIT_PRE_LINT_END_MARKER)) {
          return;
        }
      } catch {
      }
    }
    let content = "";
    if (fs.existsSync(hookPath)) {
      try {
        content = fs.readFileSync(hookPath, "utf-8");
      } catch {
        content = "";
      }
    }
    if (!content.startsWith("#!")) {
      content = `#!/bin/bash
${content}`;
    }
    const startIdx = content.indexOf(GIT_PRE_LINT_MARKER);
    const endIdx = content.indexOf(GIT_PRE_LINT_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const afterEnd = endIdx + GIT_PRE_LINT_END_MARKER.length;
      content = content.slice(0, startIdx) + content.slice(afterEnd);
    }
    const block = [
      GIT_PRE_LINT_MARKER,
      "(",
      '  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0',
      '  for dir in "${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts}" "$REPO_ROOT/.claude/hooks" "$HOME/.claude/hooks"; do',
      '    if [ -n "$dir" ] && [ -f "$dir/pre-lint-snapshot-ho.sh" ]; then',
      '      bash "$dir/pre-lint-snapshot-ho.sh"',
      "      break",
      "    fi",
      "  done",
      ")",
      GIT_PRE_LINT_END_MARKER,
      ""
    ].join("\n");
    const shebangEnd = content.indexOf("\n") + 1;
    const shebangLine = content.slice(0, shebangEnd);
    const rest = content.slice(shebangEnd);
    content = shebangLine + block + rest;
    fs.writeFileSync(hookPath, content, { encoding: "utf-8" });
    fs.chmodSync(hookPath, 493);
  } catch (e) {
    process.stderr.write(`[telemetry] Warning: failed to install pre-lint snapshot git hook: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
var GIT_BOOTSTRAP_MARKER = "# BEGIN_HAC_BOOTSTRAP";
var GIT_BOOTSTRAP_END_MARKER = "# END_HAC_BOOTSTRAP";
function ensureBootstrapHook(repoRoot) {
  try {
    const resolvedRepoRoot = repoRoot ?? getRepoRootFromGit(process.cwd());
    if (!resolvedRepoRoot) return;
    ensureHuskyUnderscoreStub(resolvedRepoRoot, "prepare-commit-msg");
    const hookPath = getConfiguredGitHookPath(resolvedRepoRoot, "prepare-commit-msg");
    if (!hookPath) return;
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    if (fs.existsSync(hookPath)) {
      try {
        const existing = fs.readFileSync(hookPath, "utf-8");
        if (existing.includes(GIT_BOOTSTRAP_MARKER) && existing.includes(GIT_BOOTSTRAP_END_MARKER)) {
          return;
        }
      } catch {
      }
    }
    let content = "";
    if (fs.existsSync(hookPath)) {
      try {
        content = fs.readFileSync(hookPath, "utf-8");
      } catch {
        content = "";
      }
    }
    if (!content.startsWith("#!")) {
      content = `#!/bin/bash
${content}`;
    }
    const startIdx = content.indexOf(GIT_BOOTSTRAP_MARKER);
    const endIdx = content.indexOf(GIT_BOOTSTRAP_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const afterEnd = endIdx + GIT_BOOTSTRAP_END_MARKER.length;
      content = content.slice(0, startIdx) + content.slice(afterEnd);
    }
    const block = [
      GIT_BOOTSTRAP_MARKER,
      "# Telemetry bootstrap \u2014 ensures post-commit/pre-commit hooks are installed",
      'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || true',
      'for dir in "$REPO_ROOT/.claude/hooks/dist" "$HOME/.claude/hooks/dist"; do',
      '  if [ -f "$dir/skill-activation-prompt-ho.mjs" ]; then',
      `    echo '{"prompt":"","session_id":"bootstrap"}' | node "$dir/skill-activation-prompt-ho.mjs" >/dev/null 2>&1 &`,
      "    break",
      "  fi",
      "done",
      GIT_BOOTSTRAP_END_MARKER,
      ""
    ].join("\n");
    const shebangEnd = content.indexOf("\n") + 1;
    const shebangLine = content.slice(0, shebangEnd);
    const rest = content.slice(shebangEnd);
    content = shebangLine + block + rest;
    fs.writeFileSync(hookPath, content, { encoding: "utf-8" });
    fs.chmodSync(hookPath, 493);
  } catch (e) {
    process.stderr.write(`[telemetry] Warning: failed to install prepare-commit-msg bootstrap hook: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
function ensureAllGitTelemetryHooks(repoRoot) {
  try {
    const baseDir = getTelemetryBaseDir();
    const healCheckPath = path.join(baseDir, "hook_heal_check.json");
    const now = Date.now();
    let currentHooksDir = null;
    try {
      const root = repoRoot ?? getRepoRootFromGit() ?? void 0;
      if (root) {
        const pcPath = getConfiguredGitHookPath(root, "post-commit");
        if (pcPath) currentHooksDir = path.dirname(pcPath);
      }
    } catch {
      currentHooksDir = null;
    }
    if (fs.existsSync(healCheckPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(healCheckPath, "utf-8"));
        const driftDetected = currentHooksDir != null && typeof data.last_hooks_dir === "string" && data.last_hooks_dir !== currentHooksDir;
        if (!driftDetected && typeof data.last_check === "number" && now - data.last_check < HOOK_HEAL_INTERVAL_MS) {
          return;
        }
      } catch {
      }
    }
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(
        healCheckPath,
        JSON.stringify({ last_check: now, ...currentHooksDir ? { last_hooks_dir: currentHooksDir } : {} }),
        "utf-8"
      );
    } catch {
    }
  } catch {
  }
  ensureGitTelemetryPostCommitHook(repoRoot);
  ensureGitTelemetryPostCheckoutHook(repoRoot);
  ensureGitTelemetryPostRewriteHook(repoRoot);
  ensureGitTelemetryPostMergeHook(repoRoot);
  ensureGitPreLintSnapshotHook(repoRoot);
  ensureBootstrapHook(repoRoot);
  try {
    const sessionId = resolveSessionId();
    const aiTool = aiToolFromHookEnv() ?? detectAiTool();
    if (aiTool !== "unknown") {
      refreshConcurrentSessionPointer(sessionId, aiTool);
    }
  } catch {
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
function resetConcurrentSessionsOnBranchCheckout(repoRoot) {
  try {
    const gitDir = getGitDirAbsolute(repoRoot);
    if (!gitDir) return;
    const telemetryDir = path.join(gitDir, "hac_telemetry");
    if (!fs.existsSync(telemetryDir)) fs.mkdirSync(telemetryDir, { recursive: true });
    const pointerPath = path.join(telemetryDir, "concurrent_ai_sessions.json");
    const pointer = {
      session_id: "",
      ai_tool: "unknown",
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      workstream_id: computeWorkstreamId(),
      concurrent_ai_sessions: []
    };
    const tmpPath = pointerPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(pointer, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, pointerPath);
  } catch {
  }
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
function pruneStaleConcurrentSessions() {
  try {
    const baseDir = getTelemetryBaseDir();
    const pointerPath = path.join(baseDir, "concurrent_ai_sessions.json");
    if (!fs.existsSync(pointerPath)) return 0;
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
      fs.writeFileSync(tmpPath, JSON.stringify(pointer, null, 2) + "\n", "utf-8");
      fs.renameSync(tmpPath, pointerPath);
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
    path.join(gitDir, "hac_telemetry", "concurrent_ai_sessions.json")
  );
  const mainGitDir = getMainRepoGitDir();
  if (!mainGitDir || path.resolve(mainGitDir) === path.resolve(gitDir)) {
    return localPointer;
  }
  const mainPointer = readActiveSessionPointerFromPath(
    path.join(mainGitDir, "hac_telemetry", "concurrent_ai_sessions.json")
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
function readConcurrentSessionPointer() {
  try {
    const toplevel = getRepoRootFromGit(process.cwd());
    if (!toplevel) return null;
    return readConcurrentSessionPointerForRepo(toplevel);
  } catch {
    return null;
  }
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
function hashPrompt(s) {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}
function promptTextDisabled() {
  const v = (process.env.HAC_SEND_PROMPT_TEXT ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return true;
  return false;
}
function classifyPromptIntent(text) {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return "other";
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has("fix", "bug", "error", "broken", "crash", "fails", "failing", "not working", "stack trace", "exception", "debug")) return "debug";
  if (has("refactor", "clean up", "cleanup", "rename", "extract", "simplify", "dedup", "restructure", "tidy")) return "refactor";
  if (has("test", "unit test", "e2e", "coverage", "spec", "assert")) return "test";
  if (has("document", "docs", "readme", "comment", "docstring", "changelog")) return "docs";
  if (has("review", "audit", "check the", "look over", "feedback on")) return "review";
  if (has("add", "implement", "build", "create", "feature", "support for", "new ", "wire up")) return "feature";
  if (has("bump", "upgrade", "config", "rename file", "move file", "lint", "format", "chore")) return "chore";
  if (/(^|\s)(how|why|what|where|when|which|can you explain|does|is it)\b/.test(t) || t.includes("?")) return "question";
  return "other";
}
function pruneOldPromptsAndAgents(maxAgeDays = 30) {
  try {
    const baseDir = getTelemetryBaseDir();
    if (!fs.existsSync(baseDir)) return;
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1e3;
    const commitDirs = fs.readdirSync(baseDir).filter((d) => {
      try {
        return fs.statSync(path.join(baseDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
    const targets = ["prompt_context.jsonl", "task_tool_invocations.jsonl"];
    for (const dir of commitDirs) {
      for (const name of targets) {
        const fp = path.join(baseDir, dir, name);
        try {
          if (!fs.existsSync(fp)) continue;
          const st = fs.statSync(fp);
          if (st.mtimeMs < cutoffMs) {
            try {
              fs.unlinkSync(fp);
            } catch {
            }
          }
        } catch {
        }
      }
    }
  } catch {
  }
}
export {
  AGENT_CAPABILITIES,
  AGENT_TOKEN_CAPABILITY,
  CONCURRENT_SESSION_STALE_MS,
  GENERATED_PATH_PREFIXES,
  aiToolFromHookEnv,
  appendSessionLog,
  buildContext,
  carryForwardSessionLogs,
  carryForwardUncommittedFingerprints,
  carryForwardUncommittedFingerprintsMultiHop,
  clampToActualDiff,
  classifyEmission,
  classifyError,
  classifyPromptIntent,
  commitRecordExistsFor,
  computeWorkstreamId,
  detectAiTool,
  emitAgentHealth,
  ensureAllGitTelemetryHooks,
  ensureBootstrapHook,
  ensureGitTelemetryPostCommitHook,
  fingerprintLines,
  getActiveCommitDir,
  getCommitDir,
  getConcurrentSessionsFromPointer,
  getMainRepoGitDir,
  getSessionLogDir,
  getTelemetryBaseDir,
  getTelemetryBaseDirsForRead,
  hashPrompt,
  incrementDropCounter,
  installHookWatchdog,
  isGeneratedFile,
  isValidAuthorEmail,
  lineHash,
  lineHashWsNorm,
  listConcurrentSessionsForPayload,
  loadCommitRecordsForRead,
  mergeAttributions,
  normalizeLine,
  pickActiveAiSessionForCommit,
  promptTextDisabled,
  pruneOldCommitDirs,
  pruneOldPromptsAndAgents,
  pruneStaleConcurrentSessions,
  readAllFromSessionLog,
  readConcurrentSessionPointer,
  readConcurrentSessionPointerForRepo,
  readDropCounters,
  readSessionLog,
  readSessionLogAcrossCommits,
  readSessionLogFromOffset,
  readTailFromSessionLog,
  recordTelemetrySuccess,
  refreshConcurrentSessionPointer,
  resetCaches,
  resetConcurrentSessionsOnBranchCheckout,
  resolveSessionId,
  retryUnsentEvents,
  rotateCommitDir,
  sendEvent,
  sha1,
  shouldEmitTelemetry,
  transferAttribution,
  trigramHash,
  withFileLock
};

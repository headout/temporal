#!/usr/bin/env node

// src/session-stop-telemetry-ho.ts
import { appendFileSync as appendFileSync2, closeSync as closeSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, openSync as openSync2, readdirSync as readdirSync3, readFileSync as readFileSync4, statSync as statSync3, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
import { join as join3 } from "path";

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
var CURL_TIMEOUT_SECONDS = 5;
var _cachedRepoRoot = null;
var _cachedGitDir = null;
var _cachedDeveloper = null;
var _cachedRepo = null;
var _cachedWorkstreamId = null;
var _cachedTelemetryBaseDir = null;
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
function computeWorkstreamId() {
  if (_cachedWorkstreamId) return _cachedWorkstreamId;
  const repo = getRepoContext();
  const dev = getDeveloperContext();
  const raw = `${repo.local_path}::${repo.branch}::${dev.email}`;
  _cachedWorkstreamId = createHash("sha256").update(raw, "utf-8").digest("hex");
  return _cachedWorkstreamId;
}
function sha1(input) {
  return createHash("sha1").update(input, "utf-8").digest("hex");
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
function promptTextDisabled() {
  const v = (process.env.HAC_SEND_PROMPT_TEXT ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return true;
  return false;
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
function sha12(input) {
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
    prompt_id: sha12(`${acc.prompt_sent_at}
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

// src/session-stop-telemetry-ho.ts
function matchPromptContext(entries, turn) {
  if (!entries.length) return void 0;
  const wanted = sha1(turn.prompt);
  const hashHit = entries.find((e) => e.prompt_fingerprint === wanted);
  if (hashHit) return hashHit;
  const turnMs = Date.parse(turn.prompt_sent_at);
  if (!Number.isFinite(turnMs)) return void 0;
  const windowMs = 3e4;
  let best;
  let bestDelta = Infinity;
  for (const e of entries) {
    const ms = Date.parse(e.timestamp);
    if (!Number.isFinite(ms)) continue;
    const delta = turnMs - ms;
    if (delta < 0 || delta > windowMs) continue;
    if (delta < bestDelta) {
      best = e;
      bestDelta = delta;
    }
  }
  return best;
}
function tokenConfidenceFor(aiTool, turn) {
  if ((turn.input_tokens ?? 0) === 0 && (turn.output_tokens ?? 0) === 0) return "none";
  if (aiTool === "cursor") return "partial";
  return "measured";
}
function enrichToolErrors(transcriptErrors, windowFailures) {
  const fromLog = windowFailures.map((f) => ({
    name: f.tool_name && f.tool_name !== "unknown" ? f.tool_name : "unknown",
    error: f.error_snippet ?? (f.error_class ?? "unknown"),
    error_class: f.error_class ?? classifyError(f.error_snippet)
  }));
  const extra = Math.max(0, transcriptErrors.length - windowFailures.length);
  const fromTranscript = transcriptErrors.slice(transcriptErrors.length - extra).map((e) => ({
    name: "unknown",
    error: e,
    error_class: classifyError(e)
  }));
  const errors = [...fromLog, ...fromTranscript];
  const count = Math.max(transcriptErrors.length, windowFailures.length);
  return { count, errors };
}
function buildTurnEvent(turn, idx, match, context, windowFailures = []) {
  const errInfo = enrichToolErrors(turn.tool_errors, windowFailures);
  const event = {
    event: "ai_prompt_trace",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    repo: context.repo,
    author: context.user,
    ai_session: { tool: context.ai_tool, session_id: context.ai_session_id, ai_model: turn.model ?? context.ai_model },
    prompt: {
      id: turn.prompt_id,
      number: idx,
      length_chars: turn.prompt_length_chars,
      context_window_used_per: match?.context_window_used_per,
      skills_recommended: match?.skills_recommended ?? [],
      ...match?.prompt_intent ? { intent: match.prompt_intent } : {}
    },
    tokens: {
      input: turn.input_tokens,
      output: turn.output_tokens,
      cached_read: turn.cached_tokens_read,
      // exposed for analysis, NOT in total
      cached_written: turn.cached_tokens_written,
      // total_billable: input_tokens already includes cache writes; cache reads are priced separately.
      total_billable: turn.input_tokens + turn.output_tokens
    },
    // §10.4: tag measurement fidelity so the dashboard can normalize per tool.
    token_confidence: tokenConfidenceFor(context.ai_tool, turn),
    activity: {
      response_time_sec: turn.response_time_ms / 1e3,
      tools_invoked: turn.tools_invoked,
      files_edited_count: turn.files_edited_count,
      files_created_count: turn.files_created_count,
      files_deleted_count: turn.files_deleted_count,
      lines_changed: turn.lines_changed,
      lines_added: turn.lines_added,
      lines_deleted: turn.lines_deleted,
      skills_used: turn.skills_actually_used,
      subagents_launched: turn.subagents_launched,
      ...turn.subagents && turn.subagents.length > 0 ? { subagents: turn.subagents } : {},
      failed_tool_calls_count: errInfo.count,
      ...errInfo.errors.length > 0 ? { tool_errors: errInfo.errors } : {}
    }
  };
  if (!promptTextDisabled()) {
    event.prompt.text = turn.prompt.length > 300 ? turn.prompt.slice(0, 300) + "\u2026" : turn.prompt;
  }
  return event;
}
function enrichTurnsFromEditsLog(turns, edits) {
  if (turns.length === 0 || edits.length === 0) return;
  const sorted = [...edits].filter((e) => typeof e.timestamp === "string").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!sorted.length) return;
  for (let i = 0; i < turns.length; i++) {
    const start = turns[i].prompt_sent_at;
    const end = i + 1 < turns.length ? turns[i + 1].prompt_sent_at : "\uFFFF";
    const inWindow = sorted.filter((e) => e.timestamp >= start && e.timestamp < end);
    if (inWindow.length === 0) continue;
    const filesTouched = /* @__PURE__ */ new Set();
    const toolCounts = /* @__PURE__ */ new Map();
    const preLines = /* @__PURE__ */ new Map();
    const postLines = /* @__PURE__ */ new Map();
    for (const e of inWindow) {
      if (!e.file_path) continue;
      filesTouched.add(e.file_path);
      if (e.phase === "post") {
        if (e.tool_name) toolCounts.set(e.tool_name, (toolCounts.get(e.tool_name) ?? 0) + 1);
        postLines.set(e.file_path, e.file_lines);
      } else {
        if (!preLines.has(e.file_path)) preLines.set(e.file_path, e.file_lines);
      }
    }
    let delta = 0;
    for (const file of filesTouched) {
      const pre = preLines.get(file);
      const post = postLines.get(file);
      if (typeof pre === "number" && typeof post === "number") delta += post - pre;
    }
    const editsAdded = Math.max(0, delta);
    const editsDeleted = Math.max(0, -delta);
    const turn = turns[i];
    if (filesTouched.size > (turn.files_edited_count ?? 0)) {
      turn.files_edited_count = filesTouched.size;
    }
    if (editsAdded > (turn.lines_added ?? 0)) {
      turn.lines_added = editsAdded;
    }
    if (editsDeleted > (turn.lines_deleted ?? 0)) {
      turn.lines_deleted = editsDeleted;
    }
    turn.lines_changed = (turn.lines_added ?? 0) + (turn.lines_deleted ?? 0);
    if (turn.tools_invoked) {
      const existing = new Map(turn.tools_invoked.map((t) => [t.name, t.count]));
      for (const [name, count] of toolCounts) {
        const cur = existing.get(name) ?? 0;
        if (count > cur) existing.set(name, count);
      }
      turn.tools_invoked = Array.from(existing.entries()).map(([name, count]) => ({ name, count }));
    } else {
      turn.tools_invoked = Array.from(toolCounts.entries()).map(([name, count]) => ({ name, count }));
    }
  }
}
function synthesizeTurnsFromPromptContext(entries, transcriptResult) {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  const lastIdx = sorted.length - 1;
  return sorted.map((e, i) => {
    const isLast = i === lastIdx;
    return {
      prompt_id: e.prompt_fingerprint || sha1(`${e.timestamp}:${i}`),
      prompt_sent_at: e.timestamp,
      response_completed_at: e.timestamp,
      response_time_ms: 0,
      prompt: e.user_message ?? "",
      prompt_length_chars: e.prompt_length_chars ?? (e.user_message?.length ?? 0),
      input_tokens: isLast ? transcriptResult.input_tokens : 0,
      output_tokens: isLast ? transcriptResult.output_tokens : 0,
      cached_tokens_read: isLast ? transcriptResult.cached_tokens_read ?? 0 : 0,
      cached_tokens_written: isLast ? transcriptResult.cached_tokens_written ?? 0 : 0,
      tools_invoked: [],
      skills_actually_used: [],
      subagents_launched: [],
      files_edited_count: 0,
      files_created_count: 0,
      files_deleted_count: 0,
      lines_changed: 0,
      lines_added: 0,
      lines_deleted: 0,
      tool_errors: []
    };
  });
}
function readStdin() {
  try {
    return readFileSync4(0, "utf-8");
  } catch {
    return "{}";
  }
}
function parseStopPayload(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
function inferAgentFromPayload(payload) {
  if (typeof payload.conversation_id === "string" && payload.conversation_id) return "cursor";
  return null;
}
function tryAcquireStopDedupeLock(sessionId) {
  const isPidFallback = /^\d+$/.test(sessionId);
  const lockKey = isPidFallback ? computeWorkstreamId().slice(0, 16) : sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  const lockPath = join3(getTelemetryBaseDir(), `stop_dedup_lock_${lockKey}`);
  const ttlMs = 5e3;
  if (existsSync3(lockPath)) {
    try {
      const ageMs = Date.now() - statSync3(lockPath).mtimeMs;
      if (ageMs < ttlMs) return null;
      unlinkSync2(lockPath);
    } catch {
      return null;
    }
  }
  try {
    const fd = openSync2(lockPath, "wx");
    writeFileSync2(fd, String(Date.now()));
    closeSync2(fd);
    return lockPath;
  } catch {
    return null;
  }
}
function pruneStaleStopDedupeLocks() {
  try {
    const baseDir = getTelemetryBaseDir();
    if (!existsSync3(baseDir)) return;
    const cutoffMs = 6e4;
    for (const name of readdirSync3(baseDir)) {
      if (!name.startsWith("stop_dedup_lock_")) continue;
      const fp = join3(baseDir, name);
      try {
        if (Date.now() - statSync3(fp).mtimeMs > cutoffMs) unlinkSync2(fp);
      } catch {
      }
    }
  } catch {
  }
}
function lastTurnCursorFile(aiTool) {
  const sanitized = (aiTool || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return `last_session_stop_marker_${sanitized}.json`;
}
function readLastSessionStopMarker(_workstreamId, aiTool) {
  try {
    const baseDir = getTelemetryBaseDir();
    const filePath = join3(baseDir, lastTurnCursorFile(aiTool));
    if (existsSync3(filePath)) {
      const raw = readFileSync4(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return { last_turn_at: typeof parsed.last_turn_at === "string" ? parsed.last_turn_at : "" };
    }
    return { last_turn_at: "" };
  } catch {
    return { last_turn_at: "" };
  }
}
function writeLastSessionStopMarker(_workstreamId, aiTool, cursor) {
  try {
    const filePath = join3(getTelemetryBaseDir(), lastTurnCursorFile(aiTool));
    writeFileSync2(filePath, JSON.stringify(cursor), "utf-8");
  } catch {
  }
}
var ZERO_TOKEN_CURSOR = { input: 0, output: 0, cached_read: 0, cached_written: 0 };
function tokenCursorFile(aiTool, sessionId) {
  const tool = (aiTool || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const sid = (sessionId || "nosid").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  return `session_tokens_${tool}_${sid}.json`;
}
function readTokenCursor(aiTool, sessionId) {
  try {
    const filePath = join3(getTelemetryBaseDir(), tokenCursorFile(aiTool, sessionId));
    if (!existsSync3(filePath)) return { ...ZERO_TOKEN_CURSOR };
    const parsed = JSON.parse(readFileSync4(filePath, "utf-8"));
    return {
      input: Number(parsed.input) || 0,
      output: Number(parsed.output) || 0,
      cached_read: Number(parsed.cached_read) || 0,
      cached_written: Number(parsed.cached_written) || 0
    };
  } catch {
    return { ...ZERO_TOKEN_CURSOR };
  }
}
function writeTokenCursor(aiTool, sessionId, cursor) {
  try {
    const filePath = join3(getTelemetryBaseDir(), tokenCursorFile(aiTool, sessionId));
    writeFileSync2(filePath, JSON.stringify(cursor), "utf-8");
  } catch {
  }
}
function tokenDelta(now, last) {
  return {
    input: Math.max(0, now.input - last.input),
    output: Math.max(0, now.output - last.output),
    cached_read: Math.max(0, now.cached_read - last.cached_read),
    cached_written: Math.max(0, now.cached_written - last.cached_written)
  };
}
function pruneStaleTokenCursors() {
  try {
    const baseDir = getTelemetryBaseDir();
    if (!existsSync3(baseDir)) return;
    const cutoffMs = 30 * 24 * 60 * 60 * 1e3;
    for (const name of readdirSync3(baseDir)) {
      if (!name.startsWith("session_tokens_")) continue;
      const fp = join3(baseDir, name);
      try {
        if (Date.now() - statSync3(fp).mtimeMs > cutoffMs) unlinkSync2(fp);
      } catch {
      }
    }
  } catch {
  }
}
function maybeDumpEvent(event) {
  const target = (process.env.HAC_DEBUG_DUMP_EVENTS ?? "").trim();
  if (!target || target === "0" || target.toLowerCase() === "false") return;
  try {
    const path3 = target === "1" || target.toLowerCase() === "true" ? "/tmp/hac-telemetry-events.ndjson" : target;
    appendFileSync2(path3, JSON.stringify(event) + "\n", "utf-8");
  } catch {
  }
}
function emit(event) {
  maybeDumpEvent(event);
  try {
    const baseDir = getTelemetryBaseDir();
    mkdirSync2(baseDir, { recursive: true });
    const eventsFile = join3(baseDir, "events.jsonl");
    appendFileSync2(eventsFile, JSON.stringify(event) + "\n", "utf-8");
  } catch {
  }
  return sendEvent(event);
}
async function main() {
  const watchdog = installHookWatchdog(8e3);
  try {
    try {
      retryUnsentEvents();
    } catch {
    }
    const payload = parseStopPayload(readStdin());
    void (process.env.HOOK_EVENT ?? payload.hook_event_name ?? "");
    const sessionId = resolveSessionId(payload);
    if (process.env.CURSOR_HOOK_ACTIVE === "1") {
      process.env.HOOK_AGENT = "cursor";
    } else if (!process.env.HOOK_AGENT) {
      if (process.env.CURSOR_CONVERSATION_ID) {
        process.env.HOOK_AGENT = "cursor";
      } else if (process.env.CODEX_THREAD_ID) {
        process.env.HOOK_AGENT = "codex";
      } else if (process.env.FACTORY_SESSION_ID) {
        process.env.HOOK_AGENT = "factory";
      } else if (process.env.OPENCODE_SESSION_ID) {
        process.env.HOOK_AGENT = "opencode";
      } else {
        const inferred = inferAgentFromPayload(payload);
        if (inferred) process.env.HOOK_AGENT = inferred;
      }
    }
    const acquiredLockPath = tryAcquireStopDedupeLock(sessionId);
    if (!acquiredLockPath) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const workstreamId = computeWorkstreamId();
    const context = buildContext(sessionId);
    if (context.ai_tool === "unknown") {
      try {
        unlinkSync2(acquiredLockPath);
      } catch {
      }
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const prevCursor = readLastSessionStopMarker(workstreamId, context.ai_tool);
    const lastTurnAt = prevCursor.last_turn_at || "";
    const transcriptResult = parseAgentTranscript(
      context.ai_tool,
      sessionId,
      typeof payload.transcript_path === "string" ? payload.transcript_path : void 0
    );
    const cumulativeTokens = {
      input: transcriptResult.input_tokens,
      output: transcriptResult.output_tokens,
      cached_read: transcriptResult.cached_tokens_read ?? 0,
      cached_written: transcriptResult.cached_tokens_written ?? 0
    };
    const isSynthAgent = context.ai_tool !== "claude";
    const prevTokenCursor = isSynthAgent ? readTokenCursor(context.ai_tool, sessionId) : ZERO_TOKEN_CURSOR;
    const deltaTokens = isSynthAgent ? tokenDelta(cumulativeTokens, prevTokenCursor) : cumulativeTokens;
    const synthTokenResult = {
      input_tokens: deltaTokens.input,
      output_tokens: deltaTokens.output,
      cached_tokens_read: deltaTokens.cached_read,
      cached_tokens_written: deltaTokens.cached_written
    };
    const allCtxEntries = readSessionLogAcrossCommits("prompt_context.jsonl");
    const ctxEntries = allCtxEntries.filter((e) => e.ai_tool === context.ai_tool);
    let allClaudeTurns = transcriptResult.claude_turns ?? [];
    if (allClaudeTurns.length === 0 && ctxEntries.length > 0) {
      allClaudeTurns = synthesizeTurnsFromPromptContext(ctxEntries, synthTokenResult);
    }
    let editEntries = [];
    try {
      editEntries = readSessionLogAcrossCommits("edits.jsonl");
      if (editEntries.length > 0) {
        enrichTurnsFromEditsLog(allClaudeTurns, editEntries);
      }
    } catch {
    }
    let failureEntries = [];
    try {
      failureEntries = readSessionLogAcrossCommits("tool_failures.jsonl").filter((e) => !e.ai_tool || e.ai_tool === context.ai_tool).filter((e) => typeof e.timestamp === "string").sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
    } catch {
    }
    try {
      const allSub = readSessionLogAcrossCommits("task_tool_invocations.jsonl").filter((e) => !e.ai_tool || e.ai_tool === context.ai_tool);
      const stops = allSub.filter((e) => e.kind === "subagent_stop");
      const starts = allSub.filter((e) => e.kind === "subagent_start");
      if (stops.length > 0 && allClaudeTurns.length > 0) {
        const startsById = /* @__PURE__ */ new Map();
        for (const s of starts) if (s.agent_id) startsById.set(s.agent_id, s);
        const orderedStarts = starts.filter((s) => !s.agent_id);
        let orderIdx = 0;
        const subagents = stops.map((e) => {
          let start;
          if (e.agent_id && startsById.has(e.agent_id)) {
            start = startsById.get(e.agent_id);
          } else if (orderIdx < orderedStarts.length) {
            start = orderedStarts[orderIdx++];
          }
          let durationSec = e.duration_sec;
          if (durationSec === void 0 && start?.timestamp && e.timestamp) {
            const ms = Date.parse(e.timestamp) - Date.parse(start.timestamp);
            if (Number.isFinite(ms) && ms >= 0) durationSec = +(ms / 1e3).toFixed(1);
          }
          return {
            subagent_type: e.subagent_type ?? start?.subagent_type ?? "general-purpose",
            ...e.status ? { status: e.status } : {},
            ...typeof durationSec === "number" ? { duration_sec: durationSec } : {},
            ...typeof e.tool_calls === "number" ? { tool_calls: e.tool_calls } : {},
            ...typeof e.message_count === "number" ? { message_count: e.message_count } : {},
            ...typeof e.files_touched === "number" ? { files_touched: e.files_touched } : {},
            ...e.tokens ? { tokens: e.tokens } : {},
            ...e.parent_session_id ? { parent_session_id: e.parent_session_id } : {}
          };
        });
        allClaudeTurns[allClaudeTurns.length - 1].subagents = subagents;
      }
    } catch {
    }
    if (context.ai_tool === "opencode") {
      try {
        const skillRows = readSessionLogAcrossCommits("skills_used.jsonl").filter((e) => !e.ai_tool || e.ai_tool === "opencode");
        if (skillRows.length > 0 && allClaudeTurns.length > 0) {
          const counts = /* @__PURE__ */ new Map();
          for (const r of skillRows) {
            if (!r.name) continue;
            counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
          }
          if (counts.size > 0) {
            const turn = allClaudeTurns[allClaudeTurns.length - 1];
            const merged = new Map(
              (turn.skills_actually_used ?? []).map((s) => [s.name, s.count])
            );
            for (const [name, count] of counts) {
              merged.set(name, (merged.get(name) ?? 0) + count);
            }
            turn.skills_actually_used = Array.from(merged.entries()).map(([name, count]) => ({ name, count }));
          }
        }
      } catch {
      }
    }
    if (allClaudeTurns.length === 0 && editEntries.length > 0) {
      const postEdits = editEntries.filter((e) => e.phase === "post" && e.timestamp);
      if (postEdits.length > 0) {
        const earliest = postEdits.reduce((a, b) => a.timestamp < b.timestamp ? a : b);
        allClaudeTurns = [{
          prompt_id: sha1(`edits-fallback:${earliest.timestamp}`),
          prompt_sent_at: earliest.timestamp,
          response_completed_at: postEdits[postEdits.length - 1].timestamp,
          response_time_ms: 0,
          prompt: "",
          prompt_length_chars: 0,
          input_tokens: synthTokenResult.input_tokens,
          output_tokens: synthTokenResult.output_tokens,
          cached_tokens_read: synthTokenResult.cached_tokens_read,
          cached_tokens_written: synthTokenResult.cached_tokens_written,
          tools_invoked: [],
          skills_actually_used: [],
          subagents_launched: [],
          files_edited_count: 0,
          files_created_count: 0,
          files_deleted_count: 0,
          lines_changed: 0,
          lines_added: 0,
          lines_deleted: 0,
          tool_errors: []
        }];
        enrichTurnsFromEditsLog(allClaudeTurns, editEntries);
      }
    }
    let newestTurnTs = lastTurnAt;
    if (allClaudeTurns.length > 0) {
      const keptTurns = lastTurnAt ? allClaudeTurns.filter((t) => (t.prompt_sent_at ?? "") > lastTurnAt) : allClaudeTurns;
      let dropCounters;
      try {
        dropCounters = readDropCounters();
      } catch {
        dropCounters = void 0;
      }
      const lastIdx = keptTurns.length - 1;
      keptTurns.forEach((turn, ki) => {
        try {
          const idx = allClaudeTurns.findIndex((t) => t.prompt_id === turn.prompt_id);
          const match = matchPromptContext(ctxEntries, turn);
          let windowFailures = [];
          if (failureEntries.length > 0 && idx !== -1) {
            const start = allClaudeTurns[idx].prompt_sent_at ?? "";
            const end = idx + 1 < allClaudeTurns.length ? allClaudeTurns[idx + 1].prompt_sent_at ?? "\uFFFF" : "\uFFFF";
            windowFailures = failureEntries.filter((f) => (f.timestamp ?? "") >= start && (f.timestamp ?? "") < end);
          }
          const turnEvent = buildTurnEvent(turn, idx === -1 ? 0 : idx, match, context, windowFailures);
          if (ki === lastIdx && dropCounters) turnEvent.telemetry_drop_counters = dropCounters;
          emit(turnEvent);
        } catch {
        }
      });
      for (const t of keptTurns) {
        if (t.prompt_sent_at && t.prompt_sent_at > newestTurnTs) newestTurnTs = t.prompt_sent_at;
      }
    }
    refreshConcurrentSessionPointer(sessionId, context.ai_tool, context.ai_model);
    if (newestTurnTs && newestTurnTs !== lastTurnAt) {
      writeLastSessionStopMarker(workstreamId, context.ai_tool, {
        last_turn_at: newestTurnTs
      });
      if (isSynthAgent) writeTokenCursor(context.ai_tool, sessionId, cumulativeTokens);
    }
    try {
      unlinkSync2(acquiredLockPath);
    } catch {
    }
    try {
      pruneOldPromptsAndAgents(30);
    } catch {
    }
    try {
      pruneStaleStopDedupeLocks();
    } catch {
    }
    try {
      pruneStaleTokenCursors();
    } catch {
    }
    try {
      pruneStaleConcurrentSessions();
    } catch {
    }
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

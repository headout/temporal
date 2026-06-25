#!/usr/bin/env node

// src/post-rewrite-telemetry-ho.ts
import { execSync as execSync2 } from "child_process";
import * as fs2 from "fs";
import * as path2 from "path";

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
  const main2 = getMainRepoGitDir();
  if (main2) push(path.join(main2, "hac_telemetry"));
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
    if (!fs.existsSync(pointerPath)) return null;
    return JSON.parse(fs.readFileSync(pointerPath, "utf-8"));
  } catch {
    return null;
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

// src/post-rewrite-telemetry-ho.ts
function getRepoRoot() {
  if (process.argv[2]) return process.argv[2];
  try {
    return execSync2("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
  } catch {
    return null;
  }
}
function readStdin() {
  try {
    return fs2.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}
function parseShaMappings(input) {
  const newToOld = /* @__PURE__ */ new Map();
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const oldSha = parts[0];
    const newSha = parts[1];
    if (!oldSha || !newSha) continue;
    const existing = newToOld.get(newSha) ?? [];
    existing.push(oldSha);
    newToOld.set(newSha, existing);
  }
  return newToOld;
}
function resolveSessionFromEnv() {
  const env = process.env;
  if (env.CLAUDE_PPID) return { sessionId: env.CLAUDE_PPID };
  if (env.CLAUDE_SESSION_ID) return { sessionId: env.CLAUDE_SESSION_ID };
  if (env.CURSOR_SESSION_ID) return { sessionId: env.CURSOR_SESSION_ID };
  if (env.CURSOR_CONVERSATION_ID) return { sessionId: env.CURSOR_CONVERSATION_ID };
  if (env.FACTORY_SESSION_ID) return { sessionId: env.FACTORY_SESSION_ID };
  if (env.CODEX_THREAD_ID) return { sessionId: env.CODEX_THREAD_ID };
  if (env.CODEX_SESSION_ID) return { sessionId: env.CODEX_SESSION_ID };
  return null;
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
    return { sessionId: primary.sessionId, model: primary.ai_model };
  } catch {
    return null;
  }
}
function resolveSession(repoRoot) {
  const envResult = resolveSessionFromEnv();
  if (envResult) return { ...envResult, resolution: "env" };
  const pointerResult = resolveSessionFromPointer(repoRoot);
  if (pointerResult) return { ...pointerResult, resolution: "pointer" };
  return { sessionId: `rewrite-${computeWorkstreamId().slice(0, 12)}`, resolution: "skipped" };
}
function main() {
  const watchdog = installHookWatchdog(8e3);
  try {
    try {
      retryUnsentEvents();
    } catch {
    }
    const repoRoot = getRepoRoot();
    if (!repoRoot) process.exit(0);
    const stdinContent = readStdin();
    if (!stdinContent.trim()) process.exit(0);
    const newToOld = parseShaMappings(stdinContent);
    if (newToOld.size === 0) process.exit(0);
    const activePointer = readConcurrentSessionPointerForRepo(repoRoot);
    const workstreamId = activePointer?.workstream_id ?? computeWorkstreamId();
    const session = resolveSession(repoRoot);
    const sessionsPayload = listConcurrentSessionsForPayload(activePointer);
    const primaryFromPointer = pickActiveAiSessionForCommit(activePointer);
    let mappingCount = 0;
    let squashCount = 0;
    const rewriteToolCounts = /* @__PURE__ */ new Map();
    for (const s of sessionsPayload) {
      if (s.ai_tool) rewriteToolCounts.set(s.ai_tool, (rewriteToolCounts.get(s.ai_tool) ?? 0) + 1);
    }
    const rewriteToolsUsedDetailed = Array.from(rewriteToolCounts.entries()).map(([tool, sessions]) => ({ tool, sessions })).sort((a, b) => b.sessions - a.sessions);
    const rewriteReflog = (process.env.GIT_REFLOG_ACTION ?? "").toLowerCase();
    const rewriteDedup = path2.join(getTelemetryBaseDir(), "rewritten_shas");
    const emittedDedup = path2.join(getTelemetryBaseDir(), "emitted_shas");
    try {
      fs2.mkdirSync(rewriteDedup, { recursive: true });
    } catch {
    }
    for (const [newSha, oldShas] of newToOld) {
      mappingCount += oldShas.length;
      const rewriteDedupFile = path2.join(rewriteDedup, newSha);
      try {
        fs2.writeFileSync(rewriteDedupFile, "", { flag: "wx" });
      } catch {
        if (commitRecordExistsFor(newSha)) continue;
      }
      const alreadyEmittedDirect = fs2.existsSync(path2.join(emittedDedup, newSha));
      const isSquash = oldShas.length > 1;
      if (isSquash) squashCount++;
      const method = isSquash ? "squash" : rewriteReflog.includes("amend") ? "amend" : rewriteReflog.includes("rebase") ? "rebase" : "amend";
      const emitted = transferAttribution(oldShas, newSha, method, {
        emitEvent: !alreadyEmittedDirect,
        repoRoot,
        sessionId: session.sessionId,
        model: session.model,
        aiTool: primaryFromPointer?.ai_tool,
        concurrentSessions: sessionsPayload.length > 0 ? sessionsPayload : void 0,
        toolsUsedDetailed: rewriteToolsUsedDetailed
      });
      if (emitted === null && !alreadyEmittedDirect) {
        try {
          const newDir = path2.join(getTelemetryBaseDir(), newSha);
          fs2.mkdirSync(newDir, { recursive: true });
        } catch {
        }
      }
    }
    appendSessionLog(workstreamId, "events.jsonl", {
      event: "post_rewrite",
      mappings: mappingCount,
      squashes: squashCount,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    try {
      const entries = fs2.readdirSync(rewriteDedup).map((f) => ({ name: f, time: fs2.statSync(path2.join(rewriteDedup, f)).mtimeMs })).sort((a, b) => b.time - a.time);
      for (const e of entries.slice(50)) {
        try {
          fs2.unlinkSync(path2.join(rewriteDedup, e.name));
        } catch {
        }
      }
    } catch {
    }
    clearTimeout(watchdog);
    process.exit(0);
  } catch {
    clearTimeout(watchdog);
    process.exit(0);
  }
}
main();

#!/usr/bin/env node

// src/post-checkout-telemetry-ho.ts
import { execSync as execSync2, execFileSync as execFileSync2 } from "child_process";
import * as fs2 from "fs";
import * as path2 from "path";

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
function normalizeLine(line) {
  return line.replace(/\r/g, "").trimEnd();
}
function sha1(input) {
  return createHash("sha1").update(input, "utf-8").digest("hex");
}
function lineHash(line) {
  return sha1(normalizeLine(line));
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

// src/post-checkout-telemetry-ho.ts
function getRepoRoot() {
  try {
    return execSync2("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
  } catch {
    return null;
  }
}
function getChangedFiles(repoRoot, oldRef, newRef) {
  try {
    const output = execFileSync2("git", ["diff", "--name-only", oldRef, newRef], {
      encoding: "utf-8",
      timeout: 1e4,
      cwd: repoRoot
    }).trim();
    if (!output) return [];
    return output.split("\n").filter((f) => f.trim());
  } catch {
    return [];
  }
}
function getNumstat(repoRoot, oldRef, newRef) {
  try {
    const output = execFileSync2("git", ["diff", "--numstat", oldRef, newRef], {
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
function readWorkingTreeFile(repoRoot, relPath) {
  try {
    const absPath = path2.join(repoRoot, relPath);
    if (!fs2.existsSync(absPath)) return [];
    const content = fs2.readFileSync(absPath, "utf-8");
    return content.split("\n");
  } catch {
    return [];
  }
}
function getGitDir(repoRoot) {
  try {
    const out = execFileSync2("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3
    }).trim();
    if (!out) return null;
    return path2.isAbsolute(out) ? out : path2.resolve(repoRoot, out);
  } catch {
    return null;
  }
}
function inBisectOrRebase(repoRoot) {
  try {
    const gitDir = getGitDir(repoRoot);
    const reflogAction = process.env.GIT_REFLOG_ACTION || "";
    if (/rebase/i.test(reflogAction)) return true;
    if (!gitDir) return false;
    return fs2.existsSync(path2.join(gitDir, "BISECT_LOG")) || fs2.existsSync(path2.join(gitDir, "rebase-merge")) || fs2.existsSync(path2.join(gitDir, "rebase-apply"));
  } catch {
    return false;
  }
}
function buildPreserveSet(repoRoot) {
  const preserve = /* @__PURE__ */ new Set();
  try {
    const out = execFileSync2("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3
    });
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      let rel = line.slice(3).trim();
      const arrow = rel.indexOf(" -> ");
      if (arrow !== -1) rel = rel.slice(arrow + 4).trim();
      if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
      if (rel) preserve.add(path2.resolve(repoRoot, rel));
    }
  } catch {
  }
  try {
    const refs = execFileSync2("git", ["stash", "list", "--format=%gd"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3
    }).split("\n").map((r) => r.trim()).filter(Boolean).slice(0, 5);
    const addStashFiles = (out) => {
      for (const n of out.split("\n")) {
        const rel = n.trim();
        if (rel) preserve.add(path2.resolve(repoRoot, rel));
      }
    };
    for (const ref of refs) {
      try {
        addStashFiles(execFileSync2("git", ["stash", "show", "--include-untracked", "--name-only", ref], {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 3e3,
          stdio: ["ignore", "pipe", "ignore"]
        }));
      } catch {
        try {
          addStashFiles(execFileSync2("git", ["stash", "show", "--name-only", ref], {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 3e3,
            stdio: ["ignore", "pipe", "ignore"]
          }));
        } catch {
        }
      }
    }
  } catch {
  }
  return preserve;
}
function resolveSessionFromEnv() {
  const env = process.env;
  if (env.CLAUDE_PPID) return env.CLAUDE_PPID;
  if (env.CLAUDE_SESSION_ID) return env.CLAUDE_SESSION_ID;
  if (env.CURSOR_SESSION_ID) return env.CURSOR_SESSION_ID;
  if (env.CURSOR_CONVERSATION_ID) return env.CURSOR_CONVERSATION_ID;
  if (env.FACTORY_SESSION_ID) return env.FACTORY_SESSION_ID;
  if (env.CODEX_THREAD_ID) return env.CODEX_THREAD_ID;
  if (env.CODEX_SESSION_ID) return env.CODEX_SESSION_ID;
  if (env.HOOK_SESSION_ID) return env.HOOK_SESSION_ID;
  return null;
}
function resolveSessionId(repoRoot) {
  const envSession = resolveSessionFromEnv();
  if (envSession) return envSession;
  const pointer = readConcurrentSessionPointerForRepo(repoRoot);
  const primary = pickActiveAiSessionForCommit(pointer);
  if (primary?.sessionId) return primary.sessionId;
  return `checkout-${Date.now()}`;
}
function flushCheckpoints(workstreamId, repoRoot, changedFiles) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  for (const relPath of changedFiles) {
    const fileLines = readWorkingTreeFile(repoRoot, relPath);
    if (fileLines.length === 0) continue;
    const lineHashes = fileLines.map((line) => lineHash(line));
    const checkpoint = {
      snapshot_phase: "pre_ai_edit",
      ai_session_fingerprint: "branch_checkout_trace",
      tool_invocation_id: "branch_checkout_trace",
      file_path: path2.resolve(repoRoot, relPath),
      line_hashes: lineHashes,
      timestamp
    };
    appendSessionLog(workstreamId, "file_snapshots.jsonl", checkpoint);
  }
}
function readJsonlRaw(filePath) {
  try {
    if (!fs2.existsSync(filePath)) return [];
    return fs2.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim());
  } catch {
    return [];
  }
}
function atomicRewrite(targetPath, content) {
  const tmpPath = targetPath + `.tmp-${process.pid}`;
  try {
    fs2.writeFileSync(tmpPath, content, "utf-8");
    fs2.renameSync(tmpPath, targetPath);
  } catch {
    try {
      fs2.unlinkSync(tmpPath);
    } catch {
    }
  }
}
function clearStaleFingerprints(workstreamId, changedFiles, preserveSet) {
  if (changedFiles.length === 0) return 0;
  const changedSet = new Set(changedFiles);
  const repoRoot = (() => {
    try {
      return execSync2("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 5e3 }).trim();
    } catch {
      return process.cwd();
    }
  })();
  const changedAbsSet = new Set(changedFiles.map((f) => path2.resolve(repoRoot, f)));
  const logDir = getSessionLogDir(workstreamId);
  let totalInvalidated = 0;
  const isPreserved = (filePath) => preserveSet.has(filePath) || preserveSet.has(path2.resolve(repoRoot, filePath));
  const aiLinesPath = path2.join(logDir, "ai_line_fingerprints.jsonl");
  const aiLines = readJsonlRaw(aiLinesPath);
  if (aiLines.length > 0) {
    let staleCount = 0;
    const kept = [];
    for (const rawLine of aiLines) {
      try {
        const entry = JSON.parse(rawLine);
        if (entry.file_path && (changedSet.has(entry.file_path) || changedAbsSet.has(entry.file_path)) && !isPreserved(entry.file_path)) {
          staleCount++;
        } else {
          kept.push(rawLine);
        }
      } catch {
        kept.push(rawLine);
      }
    }
    if (staleCount > 0) {
      totalInvalidated += staleCount;
      atomicRewrite(aiLinesPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
    }
  }
  const oldLinesPath = path2.join(logDir, "deleted_line_fingerprints.jsonl");
  const oldLines = readJsonlRaw(oldLinesPath);
  if (oldLines.length > 0) {
    let staleCount = 0;
    const kept = [];
    for (const rawLine of oldLines) {
      try {
        const entry = JSON.parse(rawLine);
        if (entry.file_path && (changedSet.has(entry.file_path) || changedAbsSet.has(entry.file_path)) && !isPreserved(entry.file_path)) {
          staleCount++;
        } else {
          kept.push(rawLine);
        }
      } catch {
        kept.push(rawLine);
      }
    }
    if (staleCount > 0) {
      totalInvalidated += staleCount;
      atomicRewrite(oldLinesPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
    }
  }
  return totalInvalidated;
}
function refToBranchName(repoRoot, ref) {
  try {
    const out = execFileSync2("git", ["name-rev", "--name-only", "--no-undefined", "--exclude=tags/*", ref], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!out || out === "undefined") return void 0;
    return out.replace(/^remotes\//, "").replace(/[~^]\d+$/, "");
  } catch {
    return void 0;
  }
}
function commitsAheadBehind(repoRoot, oldRef, newRef) {
  try {
    const out = execFileSync2("git", ["rev-list", "--left-right", "--count", `${oldRef}...${newRef}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const [behindStr, aheadStr] = out.split(/\s+/);
    const behind = Number(behindStr);
    const ahead = Number(aheadStr);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return void 0;
    return { ahead, behind };
  } catch {
    return void 0;
  }
}
function hasLiveAgentContext() {
  return Boolean(
    process.env.CLAUDE_PPID || process.env.CLAUDE_SESSION_ID || process.env.CURSOR_CONVERSATION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.FACTORY_SESSION_ID || process.env.HOOK_SESSION_ID || process.env.HOOK_AGENT
  );
}
function emitBranchTransitionEvent(sessionId, repoRoot, oldRef, newRef, numstatEntries, model) {
  const totalLinesAdded = numstatEntries.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalLinesDeleted = numstatEntries.reduce((sum, e) => sum + e.linesDeleted, 0);
  const filesChanged = numstatEntries.length;
  const context = buildContext(sessionId, model);
  const triggeredBy = hasLiveAgentContext() ? "ai_session" : "git_cli";
  const fromBranch = refToBranchName(repoRoot, oldRef);
  const toBranch = refToBranchName(repoRoot, newRef);
  const counts = commitsAheadBehind(repoRoot, oldRef, newRef);
  const event = {
    event: "branch_checkout_trace",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    repo: context.repo,
    author: context.user,
    from_ref: oldRef,
    to_ref: newRef,
    ...fromBranch ? { from_branch: fromBranch } : {},
    ...toBranch ? { to_branch: toBranch } : {},
    checkout_type: "branch",
    triggered_by: triggeredBy,
    ...counts ? { commits_ahead: counts.ahead, commits_behind: counts.behind } : {},
    lines: { added: totalLinesAdded, deleted: totalLinesDeleted },
    changed_files_count: filesChanged,
    checkpoint_flushed: true
  };
  if (triggeredBy === "ai_session") {
    event.ai_session = {
      tool: context.ai_tool,
      session_id: context.ai_session_id,
      ai_model: context.ai_model
    };
  }
  sendEvent(event);
}
function logBreadcrumb(workstreamId, oldRef, newRef, filesInvalidated) {
  const breadcrumb = {
    event: "branch_checkout_trace",
    from_ref: oldRef,
    to_ref: newRef,
    files_invalidated: filesInvalidated,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  appendSessionLog(workstreamId, "events.jsonl", breadcrumb);
}
var JSONL_FILES_TO_CLEAR = ["ai_line_fingerprints.jsonl", "deleted_line_fingerprints.jsonl", "file_snapshots.jsonl", "edits.jsonl"];
function clearNewBranchCommitDir(repoRoot, preserveSet) {
  try {
    const commitDir = getActiveCommitDir();
    if (!fs2.existsSync(commitDir)) return;
    const isPreserved = (filePath) => preserveSet.has(filePath) || preserveSet.has(path2.resolve(repoRoot, filePath));
    for (const filename of JSONL_FILES_TO_CLEAR) {
      const filePath = path2.join(commitDir, filename);
      if (!fs2.existsSync(filePath)) continue;
      if (preserveSet.size === 0) {
        fs2.writeFileSync(filePath, "", "utf-8");
        continue;
      }
      const rawLines = readJsonlRaw(filePath);
      if (rawLines.length === 0) {
        fs2.writeFileSync(filePath, "", "utf-8");
        continue;
      }
      let parseFailed = false;
      const kept = [];
      for (const rawLine of rawLines) {
        try {
          const entry = JSON.parse(rawLine);
          if (entry.file_path && isPreserved(entry.file_path)) {
            kept.push(rawLine);
          }
        } catch {
          parseFailed = true;
          break;
        }
      }
      if (parseFailed) {
        fs2.writeFileSync(filePath, "", "utf-8");
      } else {
        atomicRewrite(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "");
      }
    }
  } catch {
  }
}
function main() {
  const watchdog = installHookWatchdog(8e3);
  try {
    const oldRef = process.argv[2];
    const newRef = process.argv[3];
    const checkoutType = process.argv[4];
    if (!oldRef || !newRef || !checkoutType) {
      process.exit(0);
    }
    if (checkoutType !== "1") {
      process.exit(0);
    }
    if (oldRef === newRef) {
      process.exit(0);
    }
    const repoRoot = getRepoRoot();
    if (!repoRoot) process.exit(0);
    if (inBisectOrRebase(repoRoot)) {
      clearTimeout(watchdog);
      process.exit(0);
    }
    const preserveSet = buildPreserveSet(repoRoot);
    const sessionId = resolveSessionId(repoRoot);
    const pointerBeforeReset = readConcurrentSessionPointerForRepo(repoRoot);
    const model = pointerBeforeReset?.ai_model;
    resetConcurrentSessionsOnBranchCheckout(repoRoot);
    const activePointer = readConcurrentSessionPointerForRepo(repoRoot);
    const workstreamId = activePointer?.workstream_id ?? computeWorkstreamId();
    const changedFiles = getChangedFiles(repoRoot, oldRef, newRef);
    const numstatEntries = getNumstat(repoRoot, oldRef, newRef);
    flushCheckpoints(workstreamId, repoRoot, changedFiles);
    clearNewBranchCommitDir(repoRoot, preserveSet);
    const filesInvalidated = clearStaleFingerprints(workstreamId, changedFiles, preserveSet);
    if (filesInvalidated > 0) {
      try {
        incrementDropCounter("checkout_cleared", filesInvalidated);
      } catch {
      }
    }
    emitBranchTransitionEvent(sessionId, repoRoot, oldRef, newRef, numstatEntries, model);
    logBreadcrumb(workstreamId, oldRef, newRef, filesInvalidated);
    clearTimeout(watchdog);
    process.exit(0);
  } catch {
    clearTimeout(watchdog);
    process.exit(0);
  }
}
main();

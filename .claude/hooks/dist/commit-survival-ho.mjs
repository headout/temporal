#!/usr/bin/env node

// src/commit-survival-ho.ts
import * as fs2 from "fs";
import * as path2 from "path";
import { execSync as execSync2, execFileSync as execFileSync2 } from "child_process";

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
var CURL_TIMEOUT_SECONDS = 5;
var _cachedRepoRoot = null;
var _cachedGitDir = null;
var _cachedMainGitDir = null;
var _cachedDeveloper = null;
var _cachedRepo = null;
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
    return execFileSync2("git", args, { cwd: repoRoot, encoding: "utf-8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function isAncestorOfHead(repoRoot, sha) {
  try {
    execFileSync2("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
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
    const p = path2.join(baseDir, "survival_measured.json");
    if (!fs2.existsSync(p)) return {};
    return JSON.parse(fs2.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}
function writeMeasuredState(baseDir, state) {
  try {
    const p = path2.join(baseDir, "survival_measured.json");
    withFileLock(p + ".lock", () => {
      let cur = {};
      try {
        if (fs2.existsSync(p)) cur = JSON.parse(fs2.readFileSync(p, "utf-8"));
      } catch {
        cur = {};
      }
      for (const [sha, windows] of Object.entries(state)) {
        const merged = /* @__PURE__ */ new Set([...cur[sha] ?? [], ...windows]);
        cur[sha] = Array.from(merged).sort((a, b) => a - b);
      }
      try {
        fs2.writeFileSync(p, JSON.stringify(cur), "utf-8");
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
    for (const fp of [path2.join(baseDir, "ai_commit_records.jsonl.1"), path2.join(baseDir, "ai_commit_records.jsonl")]) {
      try {
        if (!fs2.existsSync(fp)) continue;
        const lines = fs2.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
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
      const added = rec.lines_added_total ?? 0;
      if (added === 0) continue;
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
        const clampedSurviving = Math.min(surviving, added);
        const churned = Math.max(0, added - clampedSurviving);
        const aiAdded = rec.ai_authored_lines_added ?? 0;
        const aiPer = added > 0 ? aiAdded / added : 0;
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
            added_total: added,
            ai_authored_added: aiAdded,
            surviving: clampedSurviving,
            churned
          },
          survival_rate: added > 0 ? clampedSurviving / added : 0
        };
        let alreadySent = false;
        try {
          withFileLock(path2.join(baseDir, "survival_measured.json.lock"), () => {
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
export {
  runSurvivalSweep
};

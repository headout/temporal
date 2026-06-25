#!/usr/bin/env node

// src/signal-telemetry-ho.ts
import {
  readFileSync as readFileSync2,
  existsSync as existsSync2,
  writeFileSync as writeFileSync2,
  mkdirSync as mkdirSync2,
  readdirSync as readdirSync2,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  openSync as openSync2,
  readSync as readSync2,
  closeSync as closeSync2
} from "fs";
import { execFileSync as execFileSync2 } from "child_process";
import { createHash as createHash2 } from "crypto";
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
function trigramHash(prevLine, currentLine, nextLine) {
  return sha1(normalizeLine(prevLine) + "\0" + normalizeLine(currentLine) + "\0" + normalizeLine(nextLine));
}
function lineHash(line) {
  return sha1(normalizeLine(line));
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

// src/signal-telemetry-ho.ts
var _seenFingerprints = /* @__PURE__ */ new Set();
function appendDedupedFingerprint(workstreamId, filename, entry) {
  const key = `${entry.file_path}:${entry.line_context_hash}`;
  if (_seenFingerprints.has(key)) return;
  _seenFingerprints.add(key);
  appendSessionLog(workstreamId, filename, entry);
}
function sha256(value) {
  return createHash2("sha256").update(value, "utf-8").digest("hex");
}
function normalizePath(p) {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path2.isAbsolute(p) ? p : path2.resolve(projectRoot, p);
}
function readLines(filePath) {
  try {
    if (!existsSync2(filePath)) return [];
    return readFileSync2(filePath, "utf-8").split("\n");
  } catch {
    return [];
  }
}
function countLines(filePath) {
  try {
    if (!existsSync2(filePath)) return 0;
    return readFileSync2(filePath, "utf-8").split("\n").length;
  } catch {
    return 0;
  }
}
function readStdin() {
  try {
    return readFileSync2(0, "utf-8");
  } catch {
    return "{}";
  }
}
function captureBlobSha(filePath) {
  try {
    return execFileSync2("git", ["hash-object", "-w", "--", filePath], {
      cwd: path2.dirname(filePath),
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || void 0;
  } catch {
    return void 0;
  }
}
function snippet(value, max = 200) {
  if (typeof value !== "string" || !value) return void 0;
  return value.length > max ? value.slice(0, max) : value;
}
function durationMs(input) {
  if (typeof input.duration_ms === "number") return input.duration_ms;
  if (typeof input.duration === "number") return input.duration;
  return void 0;
}
function resolveShellCommand(input) {
  const cmd = input.command ?? input.tool_input?.command;
  return typeof cmd === "string" && cmd ? cmd : void 0;
}
function resolveExitCode(input) {
  if (typeof input.exit_code === "number") return input.exit_code;
  if (typeof input.tool_response?.exit_code === "number") return input.tool_response.exit_code;
  return void 0;
}
function resolveOutput(input) {
  return input.output ?? input.tool_response?.output ?? input.tool_response?.stdout;
}
function handleEditPipeline(input, sessionId, agent, workstreamId, aiAuthorId, opts) {
  const rawFilePath = input.file_path;
  if (!rawFilePath) return;
  const filePath = normalizePath(rawFilePath);
  const edits = input.edits;
  if (!edits || edits.length === 0) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const recentSnapshots = readTailFromSessionLog(
    workstreamId,
    "file_snapshots.jsonl"
  );
  const lastSnapshot = recentSnapshots.filter((cp) => cp.file_path === filePath && cp.snapshot_phase === "post_ai_edit").sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (lastSnapshot) {
    const snapshotAge = Date.now() - new Date(lastSnapshot.timestamp).getTime();
    if (snapshotAge < 2e3) return;
  }
  const fileLines = readLines(filePath);
  const hashedLines = fileLines.map((l) => lineHash(l));
  const postBlobSha = captureBlobSha(filePath);
  const checkpoint = {
    snapshot_phase: "post_ai_edit",
    ai_session_fingerprint: aiAuthorId,
    tool_invocation_id: sha1(`signal_${opts.tool}:${filePath}:${now}`),
    file_path: filePath,
    line_hashes: hashedLines,
    timestamp: now,
    // §20 session linkage (match track-ai-edits post snapshots).
    session_id: sessionId,
    ai_tool: agent,
    ...postBlobSha ? { post_blob_sha: postBlobSha } : {},
    ...opts.toolUseId ? { tool_use_id: opts.toolUseId } : {}
  };
  appendSessionLog(workstreamId, "file_snapshots.jsonl", checkpoint);
  appendSessionLog(workstreamId, "edits.jsonl", {
    phase: "post",
    file_path: filePath,
    file_lines: countLines(filePath),
    tool_name: opts.tool,
    timestamp: now,
    source: opts.source,
    ...opts.toolUseId ? { tool_use_id: opts.toolUseId } : {}
  });
  for (const edit of edits) {
    if (!edit.new_string) continue;
    const newLines = edit.new_string.split("\n");
    const editId = createHash2("sha256").update(`${opts.tool}:${filePath}:${now}`).digest("hex").slice(0, 16);
    if (edit.old_string) {
      const oldLines = edit.old_string.split("\n");
      for (const line of oldLines) {
        const normalized = normalizeLine(line);
        if (!normalized) continue;
        const record = {
          file_path: filePath,
          edit_id: editId,
          line_context_hash: lineHash(normalized),
          line_content_hash: lineHash(normalized),
          edit_operation: "replace_source",
          tool: opts.tool,
          ai_tool: agent,
          ai_session_fingerprint: aiAuthorId,
          timestamp: now,
          ...opts.toolUseId ? { tool_use_id: opts.toolUseId } : {}
        };
        appendSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", record);
      }
    }
    let startIdx = locateEditStart(edit, fileLines, newLines);
    const fingerprints = fingerprintLines(newLines, startIdx, fileLines);
    for (let i = 0; i < newLines.length; i++) {
      const normalized = normalizeLine(newLines[i]);
      if (!normalized) continue;
      const record = {
        file_path: filePath,
        line_context_hash: fingerprints[i].line_context_hash,
        line_content_hash: fingerprints[i].line_content_hash,
        edit_operation: edit.old_string ? "replace" : "insert",
        tool: opts.tool,
        ai_tool: agent,
        ai_session_fingerprint: aiAuthorId,
        timestamp: now,
        ...opts.toolUseId ? { tool_use_id: opts.toolUseId } : {},
        ...opts.editKind ? { edit_kind: opts.editKind } : {}
      };
      appendDedupedFingerprint(workstreamId, "ai_line_fingerprints.jsonl", record);
    }
  }
}
function locateEditStart(edit, fileLines, newLines) {
  const fromLine = typeof edit.new_line === "number" ? edit.new_line : typeof edit.old_line === "number" ? edit.old_line : Array.isArray(edit.range) ? edit.range[0] : edit.range?.start;
  if (typeof fromLine === "number" && fromLine >= 0 && fromLine < fileLines.length) {
    const idx = fromLine > 0 ? fromLine - 1 : 0;
    return Math.min(idx, Math.max(0, fileLines.length - 1));
  }
  if (newLines.length > 0) {
    const firstNorm = normalizeLine(newLines[0]);
    if (firstNorm) {
      for (let i = 0; i < fileLines.length; i++) {
        if (normalizeLine(fileLines[i]) === firstNorm) return i;
      }
    }
  }
  return 0;
}
var SHELL_CAP_FILES = 50;
var SHELL_MAX_FILE_BYTES = 1024 * 1024;
var SHELL_PRE_TTL_MS = 10 * 60 * 1e3;
var SHELL_BUDGET_MS = 500;
var SHELL_FORMATTER_DEDUP_MS = 5e3;
var SHELL_AFTER_ONLY_MTIME_MS = 60 * 1e3;
function normalizePhase(p) {
  const v = (p || "").trim().toLowerCase();
  return v === "before" || v === "after" ? v : "";
}
function shellPreDir() {
  return path2.join(getTelemetryBaseDir(), "shell_pre");
}
function shellInvocationKey(command, sessionId, cwd) {
  return sha256(`${command}\0${sessionId}\0${cwd}`).slice(0, 40);
}
function looksBinary(filePath) {
  let fd;
  try {
    fd = openSync2(filePath, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync2(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== void 0) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
  }
}
function fileHashCounts(filePath) {
  try {
    const st = statSync2(filePath);
    if (!st.isFile() || st.size > SHELL_MAX_FILE_BYTES) return null;
    if (looksBinary(filePath)) return null;
    const counts = {};
    for (const line of readFileSync2(filePath, "utf-8").split("\n")) {
      const norm = normalizeLine(line);
      if (!norm) continue;
      const h = lineHash(norm);
      counts[h] = (counts[h] || 0) + 1;
    }
    return counts;
  } catch {
    return null;
  }
}
function listDirtyFiles(cwd, mtimeFloorMs) {
  let out;
  try {
    out = execFileSync2("git", ["status", "--porcelain=v1", "-z"], {
      cwd,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return [];
  }
  const repoRoot = (() => {
    try {
      return execFileSync2("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf-8",
        timeout: 3e3,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      return cwd;
    }
  })();
  const records = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      i++;
    }
    if (xy === "D " || xy === " D") continue;
    if (!p) continue;
    files.push(path2.isAbsolute(p) ? p : path2.resolve(repoRoot, p));
  }
  const filtered = files.filter((f) => {
    if (!existsSync2(f)) return false;
    if (mtimeFloorMs !== void 0) {
      try {
        if (statSync2(f).mtimeMs < mtimeFloorMs) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
  if (filtered.length > SHELL_CAP_FILES) {
    incrementDropCounter("shell_capture_cap");
    return filtered.slice(0, SHELL_CAP_FILES);
  }
  return filtered;
}
function recentlyFingerprintedSet(workstreamId) {
  const recent = readTailFromSessionLog(
    workstreamId,
    "ai_line_fingerprints.jsonl"
  );
  const cutoff = Date.now() - SHELL_FORMATTER_DEDUP_MS;
  const set = /* @__PURE__ */ new Set();
  for (const fp of recent) {
    const t = Date.parse(fp.timestamp);
    if (!Number.isNaN(t) && t >= cutoff) set.add(fp.file_path);
  }
  return set;
}
function cleanStaleShellPre() {
  const dir = shellPreDir();
  let entries;
  try {
    entries = readdirSync2(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const fp = path2.join(dir, name);
    try {
      if (now - statSync2(fp).mtimeMs > SHELL_PRE_TTL_MS) unlinkSync2(fp);
    } catch {
    }
  }
}
function captureShellMutations(input, sessionId, agent, workstreamId, phase) {
  const command = resolveShellCommand(input);
  if (!command) return;
  const cwd = input.cwd || input.tool_input?.cwd || process.cwd();
  const deadline = Date.now() + SHELL_BUDGET_MS;
  const key = shellInvocationKey(command, sessionId, cwd);
  const preDir = shellPreDir();
  const prePath = path2.join(preDir, `${key}.json`);
  cleanStaleShellPre();
  if (phase === "before") {
    const files = {};
    for (const f of listDirtyFiles(cwd)) {
      if (Date.now() > deadline) break;
      const counts = fileHashCounts(f);
      if (counts) files[f] = counts;
    }
    const snap = { command, cwd, timestamp: Date.now(), files };
    try {
      mkdirSync2(preDir, { recursive: true });
      writeFileSync2(prePath, JSON.stringify(snap), "utf-8");
    } catch {
    }
    return;
  }
  let pre;
  try {
    if (existsSync2(prePath)) pre = JSON.parse(readFileSync2(prePath, "utf-8"));
  } catch {
    pre = void 0;
  }
  const aiAuthorId = sha256(`${agent}:${sessionId}`);
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const repoRoot = resolveRepoRoot(cwd);
  const recentSet = recentlyFingerprintedSet(workstreamId);
  if (pre) {
    for (const f of listDirtyFiles(cwd)) {
      if (Date.now() > deadline) break;
      const baseline = pre.files[f] ?? headHashCounts(repoRoot, f) ?? void 0;
      fingerprintShellFile(f, baseline, workstreamId, agent, aiAuthorId, ts, sessionId, recentSet);
    }
    try {
      unlinkSync2(prePath);
    } catch {
    }
  } else {
    const floor = Date.now() - SHELL_AFTER_ONLY_MTIME_MS;
    for (const f of listDirtyFiles(cwd, floor)) {
      if (Date.now() > deadline) break;
      const headCounts = headHashCounts(repoRoot, f);
      fingerprintShellFile(f, headCounts ?? void 0, workstreamId, agent, aiAuthorId, ts, sessionId, recentSet);
    }
  }
}
function resolveRepoRoot(cwd) {
  try {
    return execFileSync2("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
function headHashCounts(repoRoot, absPath) {
  if (!repoRoot) return null;
  try {
    const rel = path2.relative(repoRoot, absPath);
    const blob = execFileSync2("git", ["show", `HEAD:${rel}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const counts = {};
    for (const line of blob.split("\n")) {
      const norm = normalizeLine(line);
      if (!norm) continue;
      const h = lineHash(norm);
      counts[h] = (counts[h] || 0) + 1;
    }
    return counts;
  } catch {
    return null;
  }
}
function fingerprintShellFile(filePath, beforeCounts, workstreamId, agent, aiAuthorId, ts, sessionId, recentSet) {
  if (recentSet.has(filePath)) return;
  const st = (() => {
    try {
      return statSync2(filePath);
    } catch {
      return null;
    }
  })();
  if (!st || !st.isFile() || st.size > SHELL_MAX_FILE_BYTES) return;
  if (looksBinary(filePath)) return;
  const fileLines = readFileSync2(filePath, "utf-8").split("\n");
  const remaining = { ...beforeCounts || {} };
  for (let i = 0; i < fileLines.length; i++) {
    const norm = normalizeLine(fileLines[i]);
    if (!norm) continue;
    const h = lineHash(norm);
    if (remaining[h] && remaining[h] > 0) {
      remaining[h]--;
      continue;
    }
    const fp = fingerprintLines([fileLines[i]], i, fileLines)[0];
    const record = {
      file_path: filePath,
      line_context_hash: fp.line_context_hash,
      line_content_hash: fp.line_content_hash,
      edit_operation: "insert",
      tool: "ShellExec",
      ai_tool: agent,
      ai_session_fingerprint: aiAuthorId,
      timestamp: ts,
      edit_kind: "shell"
    };
    appendDedupedFingerprint(workstreamId, "ai_line_fingerprints.jsonl", record);
  }
  const postBlobSha = captureBlobSha(filePath);
  const snapshot = {
    snapshot_phase: "post_ai_edit",
    ai_session_fingerprint: aiAuthorId,
    tool_invocation_id: sha1(`shell:${filePath}:${ts}`),
    file_path: filePath,
    line_hashes: fileLines.map((l) => lineHash(l)),
    timestamp: ts,
    session_id: sessionId,
    ai_tool: agent,
    ...postBlobSha ? { post_blob_sha: postBlobSha } : {}
  };
  appendSessionLog(workstreamId, "file_snapshots.jsonl", snapshot);
}
function handleShellExec(input, sessionId, agent, workstreamId) {
  const command = resolveShellCommand(input);
  if (!command) return;
  const cwd = input.cwd || input.tool_input?.cwd || process.cwd();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const dur = durationMs(input);
  const exitCode = resolveExitCode(input);
  const out = resolveOutput(input);
  const envPhase = normalizePhase(process.env.HOOK_PHASE);
  const phase = envPhase || normalizePhase(input.phase) || (dur !== void 0 || exitCode !== void 0 || out !== void 0 ? "after" : "before");
  try {
    captureShellMutations(input, sessionId, agent, workstreamId, phase);
  } catch {
  }
  appendSessionLog(workstreamId, "shell_commands.jsonl", {
    command,
    cwd,
    ai_tool: agent,
    session_id: sessionId,
    timestamp: now,
    phase,
    ...dur !== void 0 ? { duration_ms: dur } : {},
    ...exitCode !== void 0 ? { exit_code: exitCode } : {},
    // Never persist raw output — keep a ≤200-char snippet only.
    ...snippet(out) ? { output_snippet: snippet(out) } : {}
  });
}
function handleToolFailure(input, sessionId, agent, workstreamId) {
  const errObj = typeof input.error === "object" && input.error ? input.error : void 0;
  const errorRaw = typeof input.error_message === "string" && input.error_message || (typeof input.error === "string" ? input.error : errObj?.message) || errObj?.name || input.failure_type || "";
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const dur = durationMs(input);
  appendSessionLog(workstreamId, "tool_failures.jsonl", {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ai_tool: agent,
    session_id: sessionId,
    tool_name: input.tool_name || "unknown",
    ...input.tool_use_id ? { tool_use_id: input.tool_use_id } : {},
    ...filePath ? { file_path: normalizePath(filePath) } : {},
    error_class: classifyError(errorRaw),
    ...errorRaw ? { error_snippet: snippet(errorRaw, 300) } : {},
    ...dur !== void 0 ? { duration_ms: dur } : {}
  });
}
function handleMcpExec(input, sessionId, agent, workstreamId) {
  const toolName = input.tool_name || "";
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(toolName);
  const server = m ? m[1] : void 0;
  const dur = durationMs(input);
  appendSessionLog(workstreamId, "mcp_calls.jsonl", {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ai_tool: agent,
    session_id: sessionId,
    tool_name: toolName || "unknown",
    ...server ? { server } : {},
    ...dur !== void 0 ? { duration_ms: dur } : {},
    ...typeof input.success === "boolean" ? { success: input.success } : {}
  });
}
function handleCompaction(input, sessionId, agent, workstreamId) {
  appendSessionLog(workstreamId, "compactions.jsonl", {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ai_tool: agent,
    session_id: sessionId,
    ...input.trigger ? { trigger: input.trigger } : {},
    ...typeof input.pre_tokens === "number" ? { pre_tokens: input.pre_tokens } : {},
    ...typeof input.post_tokens === "number" ? { post_tokens: input.post_tokens } : {},
    ...typeof input.context_tokens === "number" ? { context_tokens: input.context_tokens } : {},
    ...typeof input.context_window_size === "number" ? { context_window_size: input.context_window_size } : {},
    ...typeof input.context_usage_percent === "number" ? { context_usage_percent: input.context_usage_percent } : {}
  });
}
function handleSkillUsed(input, sessionId, agent, workstreamId) {
  const name = input.name || input.command || "";
  if (!name) return;
  appendSessionLog(workstreamId, "skills_used.jsonl", {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ai_tool: agent,
    session_id: sessionId,
    name,
    ...typeof input.arguments_length === "number" ? { arguments_length: input.arguments_length } : {}
  });
}
async function main() {
  const watchdog = installHookWatchdog(3e3);
  _seenFingerprints.clear();
  try {
    const raw = readStdin();
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      input = {};
    }
    const signal = process.env.HOOK_SIGNAL || "";
    if (!signal) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const sessionId = resolveSessionId({
      conversation_id: typeof input.conversation_id === "string" ? input.conversation_id : void 0,
      session_id: typeof input.session_id === "string" ? input.session_id : void 0,
      thread_id: typeof input.thread_id === "string" ? input.thread_id : void 0
    });
    const agent = aiToolFromHookEnv() ?? detectAiTool();
    if (agent === "unknown") {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const workstreamId = computeWorkstreamId();
    const aiAuthorId = sha256(`${agent}:${sessionId}`);
    const toolUseId = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : void 0;
    if (signal === "file_edit") {
      handleEditPipeline(input, sessionId, agent, workstreamId, aiAuthorId, {
        tool: "ShellEdit",
        source: "afterFileEdit",
        toolUseId,
        editKind: "agent"
      });
    } else if (signal === "tab_edit") {
      handleEditPipeline(input, sessionId, agent, workstreamId, aiAuthorId, {
        tool: "TabEdit",
        source: "afterTabFileEdit",
        toolUseId,
        editKind: "tab"
      });
    } else if (signal === "shell_exec") {
      handleShellExec(input, sessionId, agent, workstreamId);
    } else if (signal === "tool_failure") {
      handleToolFailure(input, sessionId, agent, workstreamId);
    } else if (signal === "mcp_exec") {
      handleMcpExec(input, sessionId, agent, workstreamId);
    } else if (signal === "compaction") {
      handleCompaction(input, sessionId, agent, workstreamId);
    } else if (signal === "skill_used") {
      handleSkillUsed(input, sessionId, agent, workstreamId);
    }
    refreshConcurrentSessionPointer(sessionId, agent);
    ensureAllGitTelemetryHooks();
    console.log(JSON.stringify({ result: "continue" }));
  } catch {
    try {
      incrementDropCounter("capture_exception");
    } catch {
    }
    console.log(JSON.stringify({ result: "continue" }));
  } finally {
    clearTimeout(watchdog);
  }
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});

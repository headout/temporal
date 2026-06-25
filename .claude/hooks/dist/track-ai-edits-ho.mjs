#!/usr/bin/env node

// src/track-ai-edits-ho.ts
import { readFileSync as readFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, unlinkSync as unlinkSync2 } from "fs";
import { execSync as execSync2, execFileSync as execFileSync2 } from "child_process";
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

// src/track-ai-edits-ho.ts
var _seenFingerprints = /* @__PURE__ */ new Set();
function appendDedupedFingerprint(workstreamId, filename, entry) {
  const key = `${entry.file_path}:${entry.line_context_hash}`;
  if (_seenFingerprints.has(key)) return;
  _seenFingerprints.add(key);
  appendSessionLog(workstreamId, filename, entry);
}
var FILE_MUTATING_TOOLS = /* @__PURE__ */ new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "Create",
  "StrReplace",
  "Delete",
  "ApplyPatch",
  "NotebookEdit",
  // Codex / Cursor / OpenCode snake_case variants
  "write_file",
  "apply_patch",
  "create_file",
  "write",
  "edit",
  "multi_edit",
  "create",
  "str_replace",
  "delete",
  "notebook_edit"
]);
function normalizeToolName(name) {
  switch (name) {
    case "write_file":
      return "Write";
    case "create_file":
      return "Write";
    case "apply_patch":
      return "ApplyPatch";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "multi_edit":
      return "MultiEdit";
    case "create":
      return "Create";
    case "str_replace":
      return "StrReplace";
    case "delete":
      return "Delete";
    case "notebook_edit":
      return "NotebookEdit";
    default:
      return name;
  }
}
function normalizeToolInput(toolInput) {
  if (typeof toolInput === "string") {
    return toolInput ? { patch: toolInput } : void 0;
  }
  if (toolInput && typeof toolInput === "object") {
    return canonicalizeCamelKeys(toolInput);
  }
  return void 0;
}
var CAMEL_TO_SNAKE = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  patchText: "patch"
};
function canonicalizeCamelKeys(obj) {
  const out = { ...obj };
  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    if (camel in out && !(snake in out)) {
      out[snake] = out[camel];
      delete out[camel];
    }
  }
  if (Array.isArray(out.edits)) {
    out.edits = out.edits.map(
      (e) => e && typeof e === "object" ? canonicalizeCamelKeys(e) : e
    );
  }
  return out;
}
function synthesizeFromAfterFileEdit(input) {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return null;
  const rawEdits = Array.isArray(input.edits) ? input.edits : [];
  const edits = rawEdits.filter((e) => !!e && typeof e === "object").map((e) => ({
    old_string: typeof e.old_string === "string" ? e.old_string : "",
    new_string: typeof e.new_string === "string" ? e.new_string : ""
  }));
  return { tool_name: "MultiEdit", tool_input: { file_path: filePath, edits } };
}
function countLines(filePath) {
  try {
    if (!existsSync2(filePath)) return 0;
    const content = readFileSync2(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}
function applyPatchBody(toolInput) {
  if (!toolInput) return "";
  return String(
    toolInput.patch ?? toolInput.patchText ?? toolInput.content ?? toolInput.diff ?? toolInput.input ?? ""
  );
}
function extractPathsFromApplyPatchBody(patch) {
  const paths = [];
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const header = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (header) {
      const p = header[1].trim();
      if (p) paths.push(p);
      continue;
    }
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/);
    if (move) {
      const dest = move[1].trim();
      if (dest) {
        if (paths.length) paths[paths.length - 1] = dest;
        else paths.push(dest);
      }
    }
  }
  return paths;
}
function normalizePath(p) {
  if (path2.isAbsolute(p)) return p;
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path2.resolve(projectRoot, p);
}
function sha256(value) {
  return createHash2("sha256").update(value, "utf-8").digest("hex");
}
function readLines(filePath) {
  try {
    if (!existsSync2(filePath)) return [];
    const content = readFileSync2(filePath, "utf-8");
    return content.split("\n");
  } catch {
    return [];
  }
}
function extractAddedLinesFromApplyPatchBody(patch) {
  const result = [];
  let currentFile = "";
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const fileMatch = line.match(/^\*\*\* (?:Update|Add) File:\s*(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }
    const moveMatch = line.match(/^\*\*\* Move to:\s*(.+)$/);
    if (moveMatch) {
      const dest = moveMatch[1].trim();
      if (dest) currentFile = dest;
      continue;
    }
    if (!currentFile) continue;
    if (!line.startsWith("+")) continue;
    if (line.startsWith("+++")) continue;
    result.push({ filePath: normalizePath(currentFile), line: line.slice(1) });
  }
  return result;
}
function getFilePathsFromToolInput(toolName, toolInput) {
  if (!toolInput) return [];
  const singleKeys = ["file_path", "filePath", "path", "target_file", "relative_workspace_path", "notebook_path"];
  for (const k of singleKeys) {
    const v = toolInput[k];
    if (typeof v === "string" && v) return [v];
  }
  if (toolName === "ApplyPatch") {
    const patch = applyPatchBody(toolInput);
    const fromPatch = extractPathsFromApplyPatchBody(patch);
    if (fromPatch.length) return fromPatch;
  }
  return [];
}
function extractCandidateAiLines(toolName, toolInput) {
  if (!toolInput) return [];
  const rawPath = String(
    toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? toolInput.target_file ?? toolInput.relative_workspace_path ?? ""
  );
  const relPath = normalizePath(rawPath);
  const lines = [];
  const pushLines = (filePath, value) => {
    if (!filePath || typeof value !== "string") return;
    for (const line of value.split("\n")) {
      lines.push({ filePath, line });
    }
  };
  if (toolName === "Write" || toolName === "Create") {
    pushLines(relPath, toolInput.content ?? toolInput.new_string);
    return lines;
  }
  if (toolName === "NotebookEdit") {
    pushLines(relPath, toolInput.new_source);
    return lines;
  }
  if (toolName === "Edit" || toolName === "StrReplace") {
    const oldStr = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
    const newStr = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
    if (oldStr && newStr) {
      const oldLineSet = /* @__PURE__ */ new Map();
      for (const line of oldStr.split("\n")) {
        const n = normalizeLine(line);
        if (!n) continue;
        const h = lineHash(n);
        oldLineSet.set(h, (oldLineSet.get(h) ?? 0) + 1);
      }
      for (const line of newStr.split("\n")) {
        const n = normalizeLine(line);
        if (!n) {
          lines.push({ filePath: relPath, line });
          continue;
        }
        const h = lineHash(n);
        const remaining = oldLineSet.get(h) ?? 0;
        if (remaining > 0) {
          oldLineSet.set(h, remaining - 1);
        } else {
          lines.push({ filePath: relPath, line });
        }
      }
    } else {
      pushLines(relPath, toolInput.new_string);
    }
    return lines;
  }
  if (toolName === "MultiEdit") {
    const edits = toolInput.edits;
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const editObj = edit;
        const oldStr = typeof editObj.old_string === "string" ? editObj.old_string : "";
        const newStr = typeof editObj.new_string === "string" ? editObj.new_string : "";
        if (oldStr && newStr) {
          const oldLineSet = /* @__PURE__ */ new Map();
          for (const line of oldStr.split("\n")) {
            const n = normalizeLine(line);
            if (!n) continue;
            const h = lineHash(n);
            oldLineSet.set(h, (oldLineSet.get(h) ?? 0) + 1);
          }
          for (const line of newStr.split("\n")) {
            const n = normalizeLine(line);
            if (!n) {
              lines.push({ filePath: relPath, line });
              continue;
            }
            const h = lineHash(n);
            const remaining = oldLineSet.get(h) ?? 0;
            if (remaining > 0) {
              oldLineSet.set(h, remaining - 1);
            } else {
              lines.push({ filePath: relPath, line });
            }
          }
        } else {
          pushLines(relPath, editObj.new_string);
        }
      }
    }
    return lines;
  }
  if (toolName === "ApplyPatch") {
    const patch = applyPatchBody(toolInput);
    return extractAddedLinesFromApplyPatchBody(patch);
  }
  return lines;
}
function getPendingEditPath(invocationId) {
  try {
    const gitDir = execSync2("git rev-parse --git-dir", { encoding: "utf-8", timeout: 5e3 }).trim();
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const absGitDir = path2.isAbsolute(gitDir) ? gitDir : path2.resolve(projectRoot, gitDir);
    return path2.join(absGitDir, "hac_telemetry", "pending_edits", `${invocationId}.json`);
  } catch {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    return path2.join(projectRoot, ".git", "hac_telemetry", "pending_edits", `${invocationId}.json`);
  }
}
function writePendingEditId(invocationId, filePath, editId) {
  try {
    const p = getPendingEditPath(invocationId);
    mkdirSync2(path2.dirname(p), { recursive: true });
    const existing = {};
    if (existsSync2(p)) {
      try {
        Object.assign(existing, JSON.parse(readFileSync2(p, "utf-8")));
      } catch {
      }
    }
    existing[filePath] = editId;
    writeFileSync2(p, JSON.stringify(existing), "utf-8");
  } catch {
  }
}
function readAndDeletePendingEditId(invocationId, filePath) {
  try {
    const p = getPendingEditPath(invocationId);
    if (!existsSync2(p)) return void 0;
    const data = JSON.parse(readFileSync2(p, "utf-8"));
    const editId = data[filePath];
    delete data[filePath];
    if (Object.keys(data).length === 0) {
      try {
        unlinkSync2(p);
      } catch {
      }
    } else {
      writeFileSync2(p, JSON.stringify(data), "utf-8");
    }
    return editId;
  } catch {
    return void 0;
  }
}
function parseUnifiedDiffLines(patch) {
  const removed = [];
  const added = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    }
  }
  return { removed, added };
}
function detectOperationType(toolName, filePath, fileExistedBeforeEdit, toolInput) {
  if (toolName === "Delete") return "delete";
  if (toolName === "ApplyPatch") {
    const patch = applyPatchBody(toolInput);
    if (/\*\*\* Delete File:/.test(patch)) return "delete";
    return "patch";
  }
  if (toolName === "NotebookEdit") {
    return toolInput?.edit_mode === "delete" ? "delete" : "replace";
  }
  if (toolName === "Edit" || toolName === "StrReplace" || toolName === "MultiEdit") return "replace";
  if (toolName === "Write" || toolName === "Create") {
    const existed = fileExistedBeforeEdit ?? existsSync2(filePath);
    return existed ? "replace" : "insert";
  }
  return "insert";
}
function extractOldStrings(toolName, toolInput) {
  if (!toolInput) return [];
  const filePath = String(
    toolInput.file_path ?? toolInput.path ?? toolInput.target_file ?? toolInput.relative_workspace_path ?? ""
  );
  if (!filePath) return [];
  if (toolName === "Edit" || toolName === "StrReplace") {
    const oldStr = toolInput.old_string;
    if (typeof oldStr === "string" && oldStr) {
      return [{ filePath, oldString: oldStr }];
    }
    return [];
  }
  if (toolName === "MultiEdit") {
    const edits = toolInput.edits;
    const results = [];
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const oldStr = edit.old_string;
        if (typeof oldStr === "string" && oldStr) {
          results.push({ filePath, oldString: oldStr });
        }
      }
    }
    return results;
  }
  return [];
}
function findOldStringPosition(fileLines, oldString) {
  const oldLines = oldString.split("\n");
  if (oldLines.length === 0) return -1;
  const firstOldLine = normalizeLine(oldLines[0]);
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    if (normalizeLine(fileLines[i]) === firstOldLine) {
      let match = true;
      for (let j = 1; j < oldLines.length; j++) {
        if (normalizeLine(fileLines[i + j]) !== normalizeLine(oldLines[j])) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
  }
  return -1;
}
function generateEditId(toolName, filePath, timestamp) {
  return sha1(`${toolName}:${filePath}:${timestamp}`);
}
function readStdin() {
  try {
    return readFileSync2(0, "utf-8");
  } catch {
    return "{}";
  }
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
    const eventName = String(input.hook_event_name ?? "").toLowerCase();
    const isAfterFileEdit = eventName === "afterfileedit";
    if (isAfterFileEdit) {
      const synthesized = synthesizeFromAfterFileEdit(input);
      if (synthesized) {
        input.tool_name = synthesized.tool_name;
        input.tool_input = synthesized.tool_input;
      }
    }
    const toolName = normalizeToolName(input.tool_name ?? "");
    if (!FILE_MUTATING_TOOLS.has(toolName)) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const toolInput = normalizeToolInput(input.tool_input);
    const rawPaths = getFilePathsFromToolInput(toolName, toolInput);
    if (!rawPaths.length) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const filePaths = rawPaths.map(normalizePath);
    const phase = process.env.HOOK_PHASE === "pre" ? "pre" : "post";
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
    const inputAny = input;
    const cursorModel = typeof inputAny.cursor_model === "string" ? inputAny.cursor_model : void 0;
    const generation = inputAny.generation;
    const generationModel = generation && typeof generation.model === "string" ? generation.model : void 0;
    const model = typeof input.model === "string" && input.model || cursorModel || generationModel || void 0;
    const workstreamId = computeWorkstreamId();
    const aiAuthorId = sha256(`${agent}:${sessionId}`);
    const humanAuthorId = "human";
    const toolUseId = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : void 0;
    const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : void 0;
    const agentType = typeof input.agent_type === "string" && input.agent_type ? input.agent_type : void 0;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const invocationId = sha1(`${toolName}:${JSON.stringify(toolInput ?? {})}:${sessionId}`);
    for (const filePath of filePaths) {
      const fileLines = countLines(filePath);
      const entry = {
        phase,
        file_path: filePath,
        file_lines: fileLines,
        tool_name: toolName,
        timestamp: now,
        ...phase === "post" ? { input_chars: JSON.stringify(toolInput ?? {}).length } : {},
        ...toolUseId ? { tool_use_id: toolUseId } : {},
        ...agentId ? { agent_id: agentId } : {},
        ...agentType ? { agent_type: agentType } : {}
      };
      appendSessionLog(workstreamId, "edits.jsonl", entry);
      const hashedLines = readLines(filePath).map((l) => lineHash(l));
      let postBlobSha;
      if (phase === "post") {
        try {
          postBlobSha = execFileSync2("git", ["hash-object", "-w", "--", filePath], {
            encoding: "utf-8",
            timeout: 5e3,
            stdio: ["ignore", "pipe", "ignore"],
            cwd: path2.dirname(filePath)
          }).trim() || void 0;
        } catch {
          postBlobSha = void 0;
        }
      }
      const checkpoint = {
        snapshot_phase: phase === "pre" ? "pre_ai_edit" : "post_ai_edit",
        ai_session_fingerprint: phase === "pre" ? humanAuthorId : aiAuthorId,
        tool_invocation_id: invocationId,
        file_path: filePath,
        line_hashes: hashedLines,
        timestamp: now,
        // §20: persist raw session linkage on post-edit (AI) checkpoints so a
        // late commit can recover the session by file-match even when the
        // pointer is stale. Pre-edit snapshots are the human baseline (no AI sid).
        ...phase === "post" ? { session_id: sessionId, ai_tool: agent } : {},
        ...postBlobSha ? { post_blob_sha: postBlobSha } : {},
        // tool_use_id on both phases so a failure can invalidate the paired
        // human-baseline (pre) snapshot; subagent context on post only.
        ...toolUseId ? { tool_use_id: toolUseId } : {},
        ...phase === "post" && agentId ? { agent_id: agentId } : {},
        ...phase === "post" && agentType ? { agent_type: agentType } : {}
      };
      if (phase === "post") {
        const recentCheckpoints = readTailFromSessionLog(
          workstreamId,
          "file_snapshots.jsonl"
        );
        const prevForFile = recentCheckpoints.filter((cp) => cp.file_path === filePath).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
        if (prevForFile && prevForFile.ai_session_fingerprint !== aiAuthorId && prevForFile.ai_session_fingerprint !== "human") {
          checkpoint.overrode = prevForFile.ai_session_fingerprint;
        }
      }
      appendSessionLog(workstreamId, "file_snapshots.jsonl", checkpoint);
    }
    if (phase === "pre" || isAfterFileEdit) {
      const oldStrings = extractOldStrings(toolName, toolInput);
      for (const { filePath, oldString } of oldStrings) {
        const editId = generateEditId(toolName, filePath, now);
        writePendingEditId(invocationId, filePath, editId);
        const fileLines = readLines(filePath);
        const oldLines = oldString.split("\n");
        const startIdx = findOldStringPosition(fileLines, oldString);
        if (startIdx >= 0) {
          const fingerprints = fingerprintLines(oldLines, startIdx, fileLines);
          for (let i = 0; i < oldLines.length; i++) {
            const normalized = normalizeLine(oldLines[i]);
            if (!normalized) continue;
            const record = {
              file_path: filePath,
              line_context_hash: fingerprints[i].line_context_hash,
              line_content_hash: fingerprints[i].line_content_hash,
              edit_operation: "replace_source",
              tool: toolName,
              ai_tool: agent,
              ai_session_fingerprint: aiAuthorId,
              edit_id: editId,
              timestamp: now,
              ...toolUseId ? { tool_use_id: toolUseId } : {}
            };
            appendSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", record);
          }
        } else {
          for (const line of oldLines) {
            const normalized = normalizeLine(line);
            if (!normalized) continue;
            const record = {
              file_path: filePath,
              line_context_hash: lineHash(normalized),
              // no trigram context available
              line_content_hash: lineHash(normalized),
              edit_operation: "replace_source",
              tool: toolName,
              ai_tool: agent,
              ai_session_fingerprint: aiAuthorId,
              edit_id: editId,
              timestamp: now,
              ...toolUseId ? { tool_use_id: toolUseId } : {}
            };
            appendSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", record);
          }
        }
      }
      if (toolName === "ApplyPatch") {
        const patchContent = applyPatchBody(toolInput);
        if (patchContent) {
          for (const filePath of filePaths) {
            const editId = generateEditId(toolName, filePath, now);
            writePendingEditId(invocationId, filePath, editId);
            const { removed } = parseUnifiedDiffLines(patchContent);
            if (removed.length === 0) continue;
            const fileLines = readLines(filePath);
            for (const removedLine of removed) {
              const normalized = normalizeLine(removedLine);
              if (!normalized) continue;
              const pos = findOldStringPosition(fileLines, removedLine);
              let tHash;
              let lHash;
              if (pos >= 0) {
                const fps = fingerprintLines([removedLine], pos, fileLines);
                tHash = fps[0].line_context_hash;
                lHash = fps[0].line_content_hash;
              } else {
                lHash = lineHash(normalized);
                tHash = lHash;
              }
              const record = {
                file_path: filePath,
                line_context_hash: tHash,
                line_content_hash: lHash,
                edit_operation: "replace_source",
                tool: toolName,
                ai_tool: agent,
                ai_session_fingerprint: aiAuthorId,
                edit_id: editId,
                timestamp: now,
                ...toolUseId ? { tool_use_id: toolUseId } : {}
              };
              appendSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", record);
            }
          }
        }
      }
      if (toolName === "Write" || toolName === "Create") {
        for (const filePath of filePaths) {
          if (!existsSync2(filePath)) continue;
          const editId = generateEditId(toolName, filePath, now);
          const fileLines = readLines(filePath);
          if (fileLines.length === 0) continue;
          const fps = fingerprintLines(fileLines, 0, fileLines);
          for (let i = 0; i < fileLines.length; i++) {
            const normalized = normalizeLine(fileLines[i]);
            if (!normalized) continue;
            const record = {
              file_path: filePath,
              line_context_hash: fps[i].line_context_hash,
              line_content_hash: fps[i].line_content_hash,
              edit_operation: "replace_source",
              tool: toolName,
              ai_tool: agent,
              ai_session_fingerprint: aiAuthorId,
              edit_id: editId,
              timestamp: now,
              ...toolUseId ? { tool_use_id: toolUseId } : {}
            };
            appendSessionLog(workstreamId, "deleted_line_fingerprints.jsonl", record);
          }
        }
      }
    }
    if (phase === "post") {
      const candidateLines = extractCandidateAiLines(toolName, toolInput);
      const linesByFile = /* @__PURE__ */ new Map();
      for (const candidate of candidateLines) {
        const normalized = normalizeLine(candidate.line);
        if (!normalized) continue;
        let arr = linesByFile.get(candidate.filePath);
        if (!arr) {
          arr = [];
          linesByFile.set(candidate.filePath, arr);
        }
        arr.push(candidate.line);
      }
      for (const [filePath, rawNewLines] of linesByFile) {
        const fileLines = readLines(filePath);
        const recentSnapshots = readTailFromSessionLog(
          workstreamId,
          "file_snapshots.jsonl"
        );
        const preEditSnapshot = recentSnapshots.filter((cp) => cp.file_path === filePath && cp.snapshot_phase === "pre_ai_edit").sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
        const fileExistedBeforeEdit = !!(preEditSnapshot && preEditSnapshot.line_hashes.length > 0);
        const opType = detectOperationType(toolName, filePath, fileExistedBeforeEdit, toolInput);
        let newLines = rawNewLines;
        if ((toolName === "Write" || toolName === "Create") && fileExistedBeforeEdit && preEditSnapshot) {
          const preStateHashes = new Set(preEditSnapshot.line_hashes);
          newLines = rawNewLines.filter((line) => {
            const normalized = normalizeLine(line);
            if (!normalized) return false;
            return !preStateHashes.has(lineHash(normalized));
          });
        }
        const hasOldString = toolName === "Edit" || toolName === "StrReplace" || toolName === "MultiEdit" || toolName === "ApplyPatch";
        const editId = hasOldString ? readAndDeletePendingEditId(invocationId, filePath) ?? generateEditId(toolName, filePath, now) : void 0;
        let startIdx = 0;
        if (toolName === "Edit" || toolName === "StrReplace") {
          const newStr = String(toolInput?.new_string ?? "");
          const pos = findOldStringPosition(fileLines, newStr);
          if (pos >= 0) startIdx = pos;
        }
        const fingerprints = fingerprintLines(newLines, startIdx, fileLines);
        for (let i = 0; i < newLines.length; i++) {
          const normalized = normalizeLine(newLines[i]);
          if (!normalized) continue;
          const record = {
            file_path: filePath,
            line_context_hash: fingerprints[i].line_context_hash,
            line_content_hash: fingerprints[i].line_content_hash,
            ws_norm_content_hash: lineHashWsNorm(newLines[i]),
            edit_operation: opType,
            tool: toolName,
            ai_tool: agent,
            ai_session_fingerprint: aiAuthorId,
            timestamp: now,
            ...toolUseId ? { tool_use_id: toolUseId } : {}
          };
          if (editId) {
            record.edit_id = editId;
          }
          appendDedupedFingerprint(workstreamId, "ai_line_fingerprints.jsonl", record);
        }
      }
    }
    refreshConcurrentSessionPointer(sessionId, agent, model);
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

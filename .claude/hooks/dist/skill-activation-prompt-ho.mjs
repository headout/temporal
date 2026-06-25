#!/usr/bin/env node

// src/skill-activation-prompt-ho.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { execSync as execSync2 } from "child_process";
import { join as join2 } from "path";

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
function sha1(input) {
  return createHash("sha1").update(input, "utf-8").digest("hex");
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

// src/skill-activation-prompt-ho.ts
function resolveProjectDir() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR || process.env.FACTORY_PROJECT_DIR || process.env.CURSOR_PROJECT_DIR;
  if (fromEnv && existsSync2(fromEnv)) return fromEnv;
  try {
    const top = execSync2("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top && existsSync2(top)) return top;
  } catch {
  }
  return process.cwd();
}
function matchTriggers(prompt, triggers) {
  if (!triggers) return null;
  if (triggers.excludePatterns) {
    for (const pattern of triggers.excludePatterns) {
      if (new RegExp(pattern, "i").test(prompt)) return null;
    }
  }
  let hits = 0;
  let longest = 0;
  let firstType = "";
  if (triggers.keywords) {
    for (const kw of triggers.keywords) {
      if (prompt.includes(kw.toLowerCase())) {
        hits++;
        longest = Math.max(longest, kw.length);
        if (!firstType) firstType = "keyword";
      }
    }
  }
  if (triggers.intentPatterns) {
    for (const pattern of triggers.intentPatterns) {
      const m = new RegExp(pattern, "i").exec(prompt);
      if (m) {
        hits++;
        longest = Math.max(longest, m[0].length);
        if (!firstType) firstType = "intent";
      }
    }
  }
  if (hits === 0) return null;
  return { matchType: firstType, score: hits * 100 + longest };
}
function formatHookOutput(message, hookEventName = "UserPromptSubmit") {
  const agent = (process.env.HOOK_AGENT ?? "").toLowerCase();
  if (!message) {
    return agent === "codex" ? "" : JSON.stringify({ result: "continue" });
  }
  if (agent === "codex") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: message
      }
    });
  }
  return message;
}
async function main() {
  const watchdog = installHookWatchdog(5e3);
  try {
    const input = readFileSync2(0, "utf-8");
    const data = JSON.parse(input);
    const prompt = (data.prompt ?? "").toLowerCase();
    const projectDir = resolveProjectDir();
    const homeDir = process.env.HOME || "";
    const projectRulesPath = join2(projectDir, ".claude", "skills", "skill-rules.json");
    const globalRulesPath = join2(homeDir, ".claude", "skills", "skill-rules.json");
    let rulesPath = "";
    if (existsSync2(projectRulesPath)) {
      rulesPath = projectRulesPath;
    } else if (existsSync2(globalRulesPath)) {
      rulesPath = globalRulesPath;
    } else {
      clearTimeout(watchdog);
      process.exit(0);
    }
    const rules = JSON.parse(readFileSync2(rulesPath, "utf-8"));
    const disabledSkills = new Set(
      (process.env.HEADOUT_DISABLED_SKILLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    );
    const matchedSkills = [];
    for (const [skillName, config] of Object.entries(rules.skills)) {
      if (disabledSkills.has(skillName)) continue;
      const apply = config.apply ?? "auto";
      if (apply === "manual") continue;
      if (apply === "always") {
        matchedSkills.push({ name: skillName, matchType: "always", config });
        continue;
      }
      const m = matchTriggers(prompt, config.promptTriggers);
      if (m) {
        matchedSkills.push({ name: skillName, matchType: m.matchType, config, score: m.score });
      }
    }
    const matchedAgents = [];
    if (rules.agents) {
      for (const [agentName, config] of Object.entries(rules.agents)) {
        const apply = config.apply ?? "auto";
        if (apply === "manual") continue;
        if (apply === "always") {
          matchedAgents.push({ name: agentName, matchType: "always", config, isAgent: true });
          continue;
        }
        const m = matchTriggers(prompt, config.promptTriggers);
        if (m) {
          matchedAgents.push({ name: agentName, matchType: m.matchType, config, isAgent: true, score: m.score });
        }
      }
    }
    const sessionId = resolveSessionId({
      conversation_id: typeof data.conversation_id === "string" ? data.conversation_id : void 0
    });
    const workstreamId = computeWorkstreamId();
    const contextFile = `/tmp/claude-context-pct-${sessionId}.txt`;
    let contextPct = 0;
    if (existsSync2(contextFile)) {
      try {
        contextPct = parseInt(readFileSync2(contextFile, "utf-8").trim(), 10);
      } catch {
      }
    }
    const autoHandoffEnabled = process.env.HEADOUT_AUTO_HANDOFF !== "0" && !disabledSkills.has("create-handoff");
    const contextHandoffThreshold = parseInt(process.env.HEADOUT_CONTEXT_HANDOFF_THRESHOLD ?? "85", 10);
    if (autoHandoffEnabled && contextPct >= contextHandoffThreshold) {
      const hasHandoffSkill = matchedSkills.some((s) => s.name === "create-handoff");
      if (!hasHandoffSkill) {
        matchedSkills.unshift({
          name: "create-handoff",
          matchType: "context-trigger",
          config: {
            type: "domain",
            enforcement: "suggest",
            priority: "critical",
            description: `Context at ${contextPct}% - Create handoff NOW to preserve work`
          }
        });
      }
    }
    let outputMessage = "";
    if (matchedSkills.length > 0 || matchedAgents.length > 0) {
      let output = "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
      output += "\u{1F3AF} SKILL ACTIVATION CHECK\n";
      output += "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n";
      const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name);
      const critical = matchedSkills.filter((s) => s.config.priority === "critical");
      const high = matchedSkills.filter((s) => s.config.priority === "high").sort(byScore).slice(0, 2);
      const medium = matchedSkills.filter((s) => s.config.priority === "medium").sort(byScore).slice(0, 2);
      const low = matchedSkills.filter((s) => s.config.priority === "low").sort(byScore).slice(0, 2);
      if (critical.length > 0) {
        output += "\u26A0\uFE0F CRITICAL SKILLS (REQUIRED):\n";
        critical.forEach((s) => output += `  \u2192 ${s.name}
`);
        output += "\n";
      }
      if (high.length > 0) {
        output += "\u{1F4DA} RECOMMENDED SKILLS:\n";
        high.forEach((s) => output += `  \u2192 ${s.name}
`);
        output += "\n";
      }
      if (medium.length > 0) {
        output += "\u{1F4A1} SUGGESTED SKILLS:\n";
        medium.forEach((s) => output += `  \u2192 ${s.name}
`);
        output += "\n";
      }
      if (low.length > 0) {
        output += "\u{1F4CC} OPTIONAL SKILLS:\n";
        low.forEach((s) => output += `  \u2192 ${s.name}
`);
        output += "\n";
      }
      if (matchedAgents.length > 0) {
        output += "\u{1F916} RECOMMENDED AGENTS (token-efficient):\n";
        matchedAgents.forEach((a) => output += `  \u2192 ${a.name}
`);
        output += "\n";
      }
      if (matchedSkills.length > 0) {
        output += "ACTION: Use Skill tool BEFORE responding\n";
      }
      if (matchedAgents.length > 0) {
        output += "ACTION: Use Task tool with agent for exploration\n";
      }
      output += "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
      outputMessage = output;
    }
    if (autoHandoffEnabled && contextPct >= 92) {
      outputMessage += "\n" + "=".repeat(50) + `
  \u{1F6A8} CONTEXT CRITICAL: ${contextPct}%
  AUTO-COMPACTION IMMINENT!
  Run: Skill("create-handoff") NOW
` + "=".repeat(50) + "\n";
    } else if (autoHandoffEnabled && contextPct >= 85) {
      outputMessage += "\n" + "=".repeat(50) + `
  \u26A0\uFE0F CONTEXT HIGH: ${contextPct}%
  Create handoff to preserve work:
  \u2192 Skill("create-handoff")
` + "=".repeat(50) + "\n";
    } else if (autoHandoffEnabled && contextPct >= 70) {
      outputMessage += `
Context at ${contextPct}%. Consider handoff when you reach a stopping point.
`;
    }
    try {
      const aiTool = aiToolFromHookEnv() ?? detectAiTool();
      if (aiTool !== "unknown") {
        ensureAllGitTelemetryHooks(projectDir);
        const promptChars = (data.prompt ?? "").length;
        const skillInjectionChars = outputMessage.length;
        const rawPrompt = data.prompt ?? "";
        const trimmed = rawPrompt.trim();
        const isCodexTitleGen = trimmed.startsWith("You are a helpful assistant") && /Generate a concise UI title/.test(trimmed);
        if (trimmed === "" || isCodexTitleGen) {
          const out2 = formatHookOutput(outputMessage);
          if (out2) console.log(out2);
          clearTimeout(watchdog);
          process.exit(0);
        }
        const promptContextRecord = {
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          prompt_fingerprint: sha1(rawPrompt),
          prompt_length_chars: promptChars,
          context_window_used_per: contextPct,
          skills_recommended: matchedSkills.map((s) => ({
            name: s.name,
            trigger_type: s.matchType,
            priority: s.config.priority,
            ...s.config.tags?.length ? { tags: s.config.tags } : {}
          })),
          subagents_recommended: matchedAgents.map((a) => ({
            name: a.name,
            trigger_type: a.matchType
          })),
          rules_hint_size_chars: skillInjectionChars,
          ai_tool: aiTool,
          // §16.6: classify intent locally; only the label is stored, never prompt text.
          prompt_intent: classifyPromptIntent(rawPrompt)
        };
        appendSessionLog(workstreamId, "prompt_context.jsonl", promptContextRecord);
      }
    } catch {
    }
    const out = formatHookOutput(outputMessage);
    if (out) console.log(out);
    clearTimeout(watchdog);
    process.exit(0);
  } catch {
    clearTimeout(watchdog);
    const out = formatHookOutput("");
    if (out) console.log(out);
    process.exit(0);
  }
}
main().catch(() => {
  const out = formatHookOutput("");
  if (out) console.log(out);
  process.exit(0);
});

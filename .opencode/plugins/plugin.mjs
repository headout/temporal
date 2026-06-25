// .opencode/plugins/plugin.ts
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
function runBootstrapOnce(projectDir) {
  try {
    const marker = join(projectDir, ".git", ".hac_bootstrapped");
    if (existsSync(marker)) return;
    const script = join(projectDir, "bootstrap-telemetry-ho.sh");
    if (!existsSync(script)) return;
    const child = spawn("bash", [script], {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
  } catch {
  }
}
var FILE_MUTATING_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "create", "multi_edit", "str_replace", "delete"]);
var TOOL_NAME_MAP = {
  write: "Write",
  edit: "Edit",
  apply_patch: "ApplyPatch",
  create: "Create",
  multi_edit: "MultiEdit",
  str_replace: "StrReplace",
  delete: "Delete"
};
var CAMEL_TO_SNAKE = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
  patchText: "patch"
};
function normalizeArgs(tool, args) {
  if (!args || typeof args !== "object") return {};
  const normalized = { ...args };
  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    if (camel in normalized && !(snake in normalized)) {
      normalized[snake] = normalized[camel];
      delete normalized[camel];
    }
  }
  if (tool === "write" || tool === "edit" || tool === "create" || tool === "multi_edit" || tool === "str_replace" || tool === "delete") {
    if ("path" in normalized && !("file_path" in normalized)) {
      normalized.file_path = normalized.path;
      delete normalized.path;
    }
  } else if (tool === "apply_patch") {
    normalized.file_path = normalized.file_path ?? "";
  }
  return normalized;
}
function findHandler(worktree, name) {
  const candidates = [
    join(worktree, ".claude/hooks/dist", name),
    join(homedir(), ".claude/hooks/dist", name)
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
function callTrackEdits(worktree, phase, sessionID, tool, args, leafSessionID) {
  const handler = findHandler(worktree, "track-ai-edits-ho.mjs");
  if (!handler) return;
  const payload = JSON.stringify({
    tool_name: TOOL_NAME_MAP[tool] ?? tool,
    tool_input: normalizeArgs(tool, args),
    session_id: sessionID
  });
  try {
    spawnSync("node", [handler], {
      input: payload,
      env: {
        ...process.env,
        HOOK_PHASE: phase,
        HOOK_SESSION_ID: sessionID,
        HOOK_AGENT: "opencode",
        CLAUDE_PROJECT_DIR: worktree,
        OPENCODE_SESSION_ID: sessionID,
        // §9.3 groundwork: leaf id for subagent attribution (Phase 4).
        ...leafSessionID && leafSessionID !== sessionID ? { OPENCODE_LEAF_SESSION_ID: leafSessionID } : {}
      },
      timeout: 5e3
    });
  } catch {
  }
}
function callSkillActivation(worktree, sessionID, userMessage) {
  const handler = findHandler(worktree, "skill-activation-prompt-ho.mjs");
  if (!handler) return "";
  const payload = JSON.stringify({ prompt: userMessage, session_id: sessionID });
  try {
    const result = spawnSync("node", [handler], {
      input: payload,
      env: { ...process.env, HOOK_AGENT: "opencode", HOOK_SESSION_ID: sessionID, CLAUDE_PROJECT_DIR: worktree, OPENCODE_SESSION_ID: sessionID },
      timeout: 5e3
    });
    if (result.status === 0 && result.stdout) {
      const raw = result.stdout.toString();
      try {
        const out = JSON.parse(raw);
        return typeof out.message === "string" ? out.message : raw;
      } catch {
        return raw;
      }
    }
  } catch {
  }
  return "";
}
function callPreCompact(worktree, sessionID) {
  const handler = findHandler(worktree, "pre-compact-continuity-ho.mjs");
  if (!handler) return [];
  const payload = JSON.stringify({ session_id: sessionID });
  try {
    const result = spawnSync("node", [handler], {
      input: payload,
      env: { ...process.env, HOOK_AGENT: "opencode", HOOK_SESSION_ID: sessionID, CLAUDE_PROJECT_DIR: worktree, OPENCODE_SESSION_ID: sessionID },
      timeout: 5e3
    });
    if (result.status === 0 && result.stdout) {
      const out = JSON.parse(result.stdout.toString());
      if (typeof out.systemMessage === "string" && out.systemMessage) {
        return [out.systemMessage];
      }
    }
  } catch {
  }
  return [];
}
var sessionParent = /* @__PURE__ */ new Map();
function recordSessionParent(childID, parentID) {
  if (childID && parentID && parentID !== childID) sessionParent.set(childID, parentID);
}
var subagentStopFired = /* @__PURE__ */ new Set();
function resolveRootSession(id) {
  let cur = id;
  const seen = /* @__PURE__ */ new Set();
  let depth = 0;
  while (cur && sessionParent.has(cur) && !seen.has(cur) && depth < 20) {
    seen.add(cur);
    const parent = sessionParent.get(cur);
    if (!parent || parent === cur) break;
    cur = parent;
    depth++;
  }
  return cur || id;
}
var startedSessions = /* @__PURE__ */ new Set();
var exitFlushState = { worktree: "", sessionID: "" };
var exitFlushRegistered = false;
var HEARTBEAT_INTERVAL_MS = 5 * 60 * 1e3;
var lastSessionStopTime = 0;
function registerExitFlush() {
  if (exitFlushRegistered) return;
  exitFlushRegistered = true;
  const flush = () => {
    try {
      if (exitFlushState && exitFlushState.sessionID && exitFlushState.worktree) {
        callSessionStop(exitFlushState.worktree, exitFlushState.sessionID);
      }
    } catch {
    }
  };
  try {
    process.once("exit", flush);
    process.once("SIGINT", () => {
      flush();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      flush();
      process.exit(143);
    });
  } catch {
  }
}
function ensureSessionStarted(worktree, sessionID) {
  if (!sessionID) return;
  if (exitFlushState) {
    exitFlushState.worktree = worktree;
    exitFlushState.sessionID = sessionID;
  }
  registerExitFlush();
  if (startedSessions.has(sessionID)) return;
  startedSessions.add(sessionID);
  runBootstrapOnce(worktree);
  callSessionStart(worktree, sessionID);
}
function callSessionStart(worktree, sessionID) {
  const handler = findHandler(worktree, "session-start-continuity-ho.mjs");
  if (!handler) return;
  const payload = JSON.stringify({ type: "resume", session_id: sessionID });
  try {
    spawnSync("node", [handler], {
      input: payload,
      env: { ...process.env, HOOK_AGENT: "opencode", HOOK_SESSION_ID: sessionID, CLAUDE_PROJECT_DIR: worktree, OPENCODE_SESSION_ID: sessionID },
      timeout: 5e3
    });
  } catch {
  }
}
function callSignal(worktree, sessionID, signal, details = {}, phase) {
  const handler = findHandler(worktree, "signal-telemetry-ho.mjs");
  if (!handler) return;
  const payload = JSON.stringify({
    session_id: sessionID,
    ...details
  });
  try {
    spawnSync("node", [handler], {
      input: payload,
      env: {
        ...process.env,
        HOOK_SIGNAL: signal,
        HOOK_AGENT: "opencode",
        HOOK_SESSION_ID: sessionID,
        CLAUDE_PROJECT_DIR: worktree,
        OPENCODE_SESSION_ID: sessionID,
        ...(phase ? { HOOK_PHASE: phase } : {})
      },
      timeout: 5e3
    });
  } catch {
  }
}
var SESSION_STOP_FLOOR_MS = 1e3;
var lastSessionStopAt = /* @__PURE__ */ new Map();
var lastFlushedTurnId = /* @__PURE__ */ new Map();
function callSessionStop(worktree, sessionID, turnID, leafSessionID) {
  if (!sessionID) return;
  if (turnID) {
    if (lastFlushedTurnId.get(sessionID) === turnID) return;
    lastFlushedTurnId.set(sessionID, turnID);
  } else {
    const last = lastSessionStopAt.get(sessionID) ?? 0;
    if (Date.now() - last < SESSION_STOP_FLOOR_MS) return;
  }
  lastSessionStopAt.set(sessionID, Date.now());
  lastSessionStopTime = Date.now();
  const handler = findHandler(worktree, "session-stop-telemetry-ho.mjs");
  if (!handler) return;
  const payload = JSON.stringify({ session_id: sessionID });
  try {
    spawnSync("node", [handler], {
      input: payload,
      env: {
        ...process.env,
        HOOK_AGENT: "opencode",
        HOOK_SESSION_ID: sessionID,
        CLAUDE_PROJECT_DIR: worktree,
        OPENCODE_SESSION_ID: sessionID,
        ...leafSessionID && leafSessionID !== sessionID ? { OPENCODE_LEAF_SESSION_ID: leafSessionID } : {}
      },
      timeout: 5e3
    });
  } catch {
  }
}
var subagentSpawnFired = /* @__PURE__ */ new Set();
function callTrackAgentCalls(worktree, rootSessionID, childSessionID, subagentType) {
  if (!childSessionID || subagentSpawnFired.has(childSessionID)) return;
  subagentSpawnFired.add(childSessionID);
  const handler = findHandler(worktree, "track-agent-calls-ho.mjs");
  if (!handler) return;
  const payload = JSON.stringify({
    tool_name: "Task",
    tool_input: { subagent_type: subagentType || "general-purpose", description: "", prompt: "" },
    session_id: rootSessionID
  });
  try {
    spawnSync("node", [handler], {
      input: payload,
      env: {
        ...process.env,
        HOOK_AGENT: "opencode",
        HOOK_SESSION_ID: rootSessionID,
        CLAUDE_PROJECT_DIR: worktree,
        OPENCODE_SESSION_ID: rootSessionID,
        OPENCODE_LEAF_SESSION_ID: childSessionID
      },
      timeout: 5e3
    });
  } catch {
  }
}
function callSubagentStop(worktree, rootSessionID, subagentType, leafSessionID) {
  const handler = findHandler(worktree, "track-agent-calls-ho.mjs");
  if (!handler) return;
  const payload = JSON.stringify({
    hook_event_name: "SubagentStop",
    subagent_type: subagentType || "general-purpose",
    status: "completed",
    conversation_id: rootSessionID,
    ...leafSessionID && leafSessionID !== rootSessionID ? { leaf_session_id: leafSessionID } : {}
  });
  try {
    spawnSync("node", [handler], {
      input: payload,
      env: {
        ...process.env,
        HOOK_AGENT: "opencode",
        HOOK_EVENT: "SubagentStop",
        HOOK_SESSION_ID: rootSessionID,
        CLAUDE_PROJECT_DIR: worktree,
        OPENCODE_SESSION_ID: rootSessionID,
        ...leafSessionID && leafSessionID !== rootSessionID ? { OPENCODE_LEAF_SESSION_ID: leafSessionID } : {}
      },
      timeout: 5e3
    });
  } catch {
  }
}
function callSkillUsed(worktree, sessionID, name, argumentsLength) {
  if (!name) return;
  callSignal(worktree, sessionID, "skill_used", {
    name,
    ...typeof argumentsLength === "number" ? { arguments_length: argumentsLength } : {}
  });
}
var toolFailureFired = /* @__PURE__ */ new Set();
var server = async ({ worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      try {
        const root = resolveRootSession(input.sessionID);
        ensureSessionStarted(worktree, root);
        const tool = input.tool.toLowerCase();
        if (tool === "bash" || tool === "shell") {
          const args = output.args ?? {};
          callSignal(worktree, root, "shell_exec", {
            command: args.command ?? "",
            description: args.description ?? ""
          }, "before");
          return;
        }
        if (!FILE_MUTATING_TOOLS.has(tool)) return;
        callTrackEdits(worktree, "pre", root, tool, output.args, input.sessionID);
      } catch {
      }
    },
    "tool.execute.after": async (input) => {
      try {
        const root = resolveRootSession(input.sessionID);
        ensureSessionStarted(worktree, root);
        const tool = input.tool.toLowerCase();
        if (FILE_MUTATING_TOOLS.has(tool)) {
          callTrackEdits(worktree, "post", root, tool, input.args, input.sessionID);
        }
        if (tool === "bash" || tool === "shell") {
          const args = input.args ?? {};
          callSignal(worktree, root, "shell_exec", {
            command: args.command ?? "",
            description: args.description ?? ""
          }, "after");
        }
        if (root && Date.now() - lastSessionStopTime > HEARTBEAT_INTERVAL_MS) {
          callSessionStop(worktree, root, void 0, input.sessionID);
        }
      } catch {
      }
    },
    "chat.message": async (input, output) => {
      try {
        const root = resolveRootSession(input.sessionID);
        ensureSessionStarted(worktree, root);
        const userText = output.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
        const injection = callSkillActivation(worktree, root, userText);
        if (injection) {
          output.parts = [
            ...output.parts,
            { type: "text", text: "\n\n" + injection }
          ];
        }
      } catch {
      }
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        const context = callPreCompact(worktree, input.sessionID);
        if (context.length > 0) {
          output.context.push(...context);
        }
      } catch {
      }
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.created" || event.type === "session.updated") {
          const info = event.properties?.info ?? {};
          const id = info.id ?? event.properties?.sessionID ?? "";
          const parentID = info.parentID ?? info.parent_id ?? event.properties?.parentID ?? "";
          if (id && parentID) recordSessionParent(id, parentID);
          if (event.type === "session.created" && id) {
            const root = resolveRootSession(id);
            ensureSessionStarted(worktree, root);
            if (parentID) {
              const subagentType = info.agent ?? info.mode ?? "general-purpose";
              callTrackAgentCalls(worktree, root, id, String(subagentType));
            }
          }
        }
        if (event.type === "session.idle" || event.type === "session.deleted") {
          const props = event.properties ?? {};
          const leafSessionID = props.sessionID ?? props.info?.id ?? "";
          const parentID = props.info?.parentID ?? props.info?.parent_id ?? props.parentID ?? "";
          if (leafSessionID && parentID) recordSessionParent(leafSessionID, parentID);
          const sessionID = resolveRootSession(leafSessionID);
          const turnID = props.turnID ?? props.turn_id ?? props.messageID ?? props.message_id ?? void 0;
          callSessionStop(worktree, sessionID, typeof turnID === "string" ? turnID : void 0, leafSessionID);
          if (leafSessionID && sessionID !== leafSessionID && !subagentStopFired.has(leafSessionID)) {
            subagentStopFired.add(leafSessionID);
            const subagentType = props.info?.agent ?? props.info?.mode ?? props.agent ?? "general-purpose";
            callSubagentStop(worktree, sessionID, String(subagentType), leafSessionID);
          }
          try {
            const tokens = Number(props.tokens) || Number(props.usage?.total) || Number(props.info?.tokens) || 0;
            const PRECOMPACT_TOKEN_THRESHOLD = 15e4;
            if (event.type === "session.idle" && tokens > PRECOMPACT_TOKEN_THRESHOLD) {
              callPreCompact(worktree, sessionID);
            }
          } catch {
          }
        }
        if (event.type === "message.part.updated") {
          const part = event.properties?.part ?? {};
          if (part.type === "tool" && part.state?.status === "error") {
            const callID = part.callID ?? part.id ?? "";
            if (callID && !toolFailureFired.has(callID)) {
              toolFailureFired.add(callID);
              const sessID = part.sessionID ?? event.properties?.sessionID ?? "";
              const root = resolveRootSession(sessID);
              callSignal(worktree, root, "tool_failure", {
                tool_name: part.tool ?? "unknown",
                tool_use_id: callID,
                error: part.state?.error ?? part.state?.message ?? ""
              });
            }
          }
        }
        if (event.type === "session.error") {
          const props = event.properties ?? {};
          const err = props.error ?? props.message ?? props.info?.error ?? "";
          const sessID = props.sessionID ?? props.info?.id ?? "";
          const root = resolveRootSession(sessID);
          callSignal(worktree, root, "tool_failure", {
            tool_name: "session",
            error: typeof err === "string" ? err : err?.name ?? err?.message ?? "session_error"
          });
        }
        if (event.type === "session.compacted") {
          const props = event.properties ?? {};
          const sessID = props.sessionID ?? props.info?.id ?? "";
          const root = resolveRootSession(sessID);
          callSignal(worktree, root, "compaction", { trigger: "auto" });
        }
        if (event.type === "command.executed") {
          const props = event.properties ?? {};
          const name = props.command ?? props.name ?? props.info?.command ?? "";
          const sessID = props.sessionID ?? props.info?.id ?? "";
          const root = resolveRootSession(sessID);
          const argLen = typeof props.arguments === "string" ? props.arguments.length : typeof props.args === "string" ? props.args.length : void 0;
          callSkillUsed(worktree, root, String(name), argLen);
        }
      } catch {
      }
    },
    // Official teardown hook (v1.15.11+). Guarantees a final flush even when the
    // process exits cleanly; process.exit/SIGINT/SIGTERM handlers remain as a
    // fallback for SIGKILL paths where dispose never runs.
    dispose: async () => {
      try {
        if (exitFlushState && exitFlushState.sessionID && exitFlushState.worktree) {
          callSessionStop(exitFlushState.worktree, exitFlushState.sessionID);
        }
      } catch {
      }
    }
  };
};
export {
  server
};

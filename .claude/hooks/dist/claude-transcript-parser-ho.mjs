// src/claude-transcript-parser-ho.ts
import * as fs from "fs";
import { createHash } from "crypto";
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
function sha1(input) {
  return createHash("sha1").update(input, "utf-8").digest("hex");
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
    prompt_id: sha1(`${acc.prompt_sent_at}
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
    if (!fs.existsSync(transcriptPath)) return EMPTY_SUMMARY;
    const raw = fs.readFileSync(transcriptPath, "utf-8");
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
export {
  parseClaudeTranscript
};

// src/attribution-v3-ho.ts
import { execFileSync } from "child_process";
function git(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function objectLines(repoRoot, spec) {
  const out = git(repoRoot, ["cat-file", "-p", spec]);
  if (out === null) return null;
  const lines = out.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function multiset(lines) {
  const m = /* @__PURE__ */ new Map();
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    m.set(line, (m.get(line) ?? 0) + 1);
  }
  return m;
}
function added(from, to) {
  const out = /* @__PURE__ */ new Map();
  for (const [line, n] of to) {
    const diff = n - (from.get(line) ?? 0);
    if (diff > 0) out.set(line, diff);
  }
  return out;
}
function intersectionSize(a, b) {
  let total = 0;
  for (const [line, n] of a) {
    const m = b.get(line) ?? 0;
    if (m > 0) total += Math.min(n, m);
  }
  return total;
}
function sumCounts(m) {
  let t = 0;
  for (const n of m.values()) t += n;
  return t;
}
function computeBlobAttribution(input) {
  const { repoRoot, files, aiBlobByPath, parentRef } = input;
  const results = [];
  for (const f of files) {
    const op = f.operation ?? "unknown";
    const parentSpec = f.rename_from ? `${parentRef}:${f.rename_from}` : `${parentRef}:${f.path}`;
    const aLines = op === "create" ? [] : objectLines(repoRoot, parentSpec) ?? [];
    const cLines = op === "delete" ? [] : objectLines(repoRoot, `HEAD:${f.path}`) ?? [];
    const A = multiset(aLines);
    const C = multiset(cLines);
    const addedAC = added(A, C);
    const deletedAC = added(C, A);
    const linesAddedTotal = sumCounts(addedAC);
    const linesDeletedTotal = sumCounts(deletedAC);
    const aiSha = aiBlobByPath.get(f.path);
    if (!aiSha) {
      results.push({
        path: f.path,
        operation: op,
        ai_lines_added: 0,
        ai_lines_deleted: 0,
        human_lines_added: linesAddedTotal,
        drafted_then_human_edited: 0,
        lines_added_total: linesAddedTotal,
        lines_deleted_total: linesDeletedTotal,
        ai_per: 0,
        has_ai_blob: false
      });
      continue;
    }
    const bLines = objectLines(repoRoot, aiSha) ?? [];
    const B = multiset(bLines);
    const addedAB = added(A, B);
    const deletedAB = added(B, A);
    const aiLinesAdded = intersectionSize(addedAC, addedAB);
    const aiLinesDeleted = intersectionSize(deletedAC, deletedAB);
    const humanLinesAdded = Math.max(0, linesAddedTotal - aiLinesAdded);
    const draftedThenEdited = Math.max(0, sumCounts(addedAB) - intersectionSize(addedAB, C));
    const aiPer = linesAddedTotal > 0 ? aiLinesAdded / linesAddedTotal : 0;
    results.push({
      path: f.path,
      operation: op,
      ai_lines_added: aiLinesAdded,
      ai_lines_deleted: aiLinesDeleted,
      human_lines_added: humanLinesAdded,
      drafted_then_human_edited: draftedThenEdited,
      lines_added_total: linesAddedTotal,
      lines_deleted_total: linesDeletedTotal,
      ai_per: +aiPer.toFixed(3),
      has_ai_blob: true
    });
  }
  const sum = (k) => results.reduce((s, r) => s + r[k], 0);
  const totalAdded = sum("lines_added_total");
  const totalAiAdded = sum("ai_lines_added");
  return {
    files: results,
    ai_lines_added: totalAiAdded,
    ai_lines_deleted: sum("ai_lines_deleted"),
    human_lines_added: sum("human_lines_added"),
    drafted_then_human_edited: sum("drafted_then_human_edited"),
    lines_added_total: totalAdded,
    lines_deleted_total: sum("lines_deleted_total"),
    ai_per: totalAdded > 0 ? +(totalAiAdded / totalAdded).toFixed(3) : 0
  };
}
export {
  computeBlobAttribution
};

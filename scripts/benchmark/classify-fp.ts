#!/usr/bin/env npx tsx
/**
 * FP attribution — tags every false positive with a REASON.
 *
 * The recall side is already covered (classify-misses.js, leak-attrib.js, funnel-*).
 * This fills the precision-side blind spot: the judge only stores FP as a COUNT,
 * so "FP doubled" is unexplained. This classifies each FP into one of:
 *
 *   hallucination       - the bug does not plausibly exist
 *   correct_but_trivial - valid but a dev would not act (nit/style/cosmetic)
 *   wrong_localization  - same issue as a golden, wrong file/line, so it didn't match
 *   weak_evidence       - real-sounding but no concrete evidence / causal chain
 *   golden_incomplete   - a genuine bug simply MISSING from the golden set (your H6)
 *                         -> these are precision you are losing to an incomplete golden
 *   duplicate           - restates an issue already covered
 *
 * FP source of truth (verified against real runs):
 *   match-matrix.json[pi] = cells {gi, ci, match, confidence, reasoning}
 *   candidates-all.json[pi].issues, ci aligned to the issues with stage==='sent'
 *   A candidate ci is a FP when no cell with that ci has match===true.
 *
 * Mirrors judge.ts (same Anthropic client/model/batch/retry).
 *
 * Usage:
 *   npx tsx scripts/benchmark/classify-fp.ts --run gemini50-r04
 *   npx tsx scripts/benchmark/classify-fp.ts --run gemini50-r04 --dry   # no LLM, just extract
 *   npx tsx scripts/benchmark/classify-fp.ts --dir results/gemini50-r04 --limit 20
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";

const MODEL = process.env.CLASSIFY_FP_MODEL ?? "claude-sonnet-4-20250514"; // same as judge.ts
const BATCH_SIZE = 20;
const LLM_CALL_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
const MAX_GOLDENS_IN_PROMPT = 25;
const FP_TAGS = [
  "hallucination",
  "correct_but_trivial",
  "wrong_localization",
  "weak_evidence",
  "golden_incomplete",
  "duplicate",
] as const;

const PROMPT = `You are doing error attribution on a FALSE POSITIVE from an AI code reviewer.
A false positive = an issue the reviewer raised that did NOT match any expected (golden) comment for this pull request.

The reviewer's issue (the false positive):
Comment: {comment}
Location: {location}
Severity: {severity}

Expected golden comments for THIS PR (the issues that actually mattered here):
{golden_list}

The judge already compared this issue against each golden and rejected every match. Judge notes:
{judge_notes}

Classify the false positive into EXACTLY ONE tag:
- "hallucination": describes a bug/behavior that does not plausibly exist in the code.
- "correct_but_trivial": technically valid but a developer would not act on it (nitpick, style, cosmetic, restating the obvious).
- "wrong_localization": clearly the SAME issue as one of the golden comments above, but pointing at a different file/line/wording, so it failed to match.
- "weak_evidence": a real-sounding claim with no concrete evidence or causal chain (vague, speculative, "could potentially").
- "golden_incomplete": looks like a GENUINE, actionable bug that is simply MISSING from the golden list above (the golden set is incomplete, the reviewer is not wrong).
- "duplicate": restates an issue already covered by another candidate or golden.

Respond with ONLY a JSON object:
{"tag": "<one tag>", "reason": "<one short sentence>", "likely_real_bug": true|false}`;

type Cell = { gi: number; ci: number; match: boolean; confidence: number; reasoning: string };
type Issue = { comment: string; severity?: string; location?: string; stage?: string; killedBy?: string | null };
type CandPR = { repo?: string; prNumber?: number; head?: string; issues?: Issue[] };
type GoldenPR = { repo?: string; golden_comments?: { comment: string; severity?: string }[] };

type FP = {
  pi: number;
  ci: number;
  repo: string;
  prNumber: number | null;
  comment: string;
  location: string;
  severity: string;
  goldens: string[];
  judgeNotes: string[];
};

function parseArgs() {
  const a = process.argv.slice(2);
  if (a.includes("--help") || a.includes("-h")) {
    console.log(
      `FP attribution. Tags each false positive with a reason.\n\n` +
        `  --run <name>    results/<name>/ (or use --dir)\n` +
        `  --dir <path>    run directory holding match-matrix.json, candidates-all.json, golden.json\n` +
        `  --dry           extract FPs and print, but do NOT call the LLM\n` +
        `  --limit <n>     classify at most n FPs\n` +
        `  --out <path>    output (default <dir>/fp-attribution.json)\n` +
        `  --model <id>    override model (default ${MODEL})\n\n` +
        `Requires ANTHROPIC_API_KEY (unless --dry).`,
    );
    process.exit(0);
  }
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--dry") { flags.add("dry"); continue; }
    if (k?.startsWith("--")) { opts[k.slice(2)] = a[++i]; }
  }
  let dir = opts.dir;
  if (!dir && opts.run) dir = resolve(__dirname, "results", opts.run);
  if (!dir) { console.error("Error: pass --run <name> or --dir <path>"); process.exit(1); }
  return {
    dir: resolve(dir),
    dry: flags.has("dry"),
    limit: opts.limit ? parseInt(opts.limit, 10) : Infinity,
    out: opts.out ? resolve(opts.out) : join(resolve(dir), "fp-attribution.json"),
    model: opts.model ?? MODEL,
  };
}

function loadJson<T>(p: string): T {
  if (!existsSync(p)) { console.error(`Error: missing ${p}`); process.exit(1); }
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/** Pure extraction — no LLM. Returns the FP list + any alignment warnings. */
function extractFPs(dir: string): { fps: FP[]; warnings: string[] } {
  const matrix = loadJson<Cell[][]>(join(dir, "match-matrix.json"));
  const cands = loadJson<CandPR[]>(join(dir, "candidates-all.json"));
  const goldens = loadJson<GoldenPR[]>(join(dir, "golden.json"));
  const fps: FP[] = [];
  const warnings: string[] = [];

  for (let pi = 0; pi < matrix.length; pi++) {
    const cells = matrix[pi] || [];
    if (!cells.length) continue;
    // ci is aligned to the SENT issues (the candidates the judge actually scored).
    const sent = (cands[pi]?.issues || []).filter((i) => i.stage === "sent");
    const distinctCi = Math.max(...cells.map((c) => c.ci)) + 1;
    if (distinctCi !== sent.length) {
      warnings.push(
        `PR ${pi} (${(cands[pi]?.repo || "?").split("/").pop()}): ci count ${distinctCi} != sent issues ${sent.length} — skipping (alignment unsafe)`,
      );
      continue;
    }
    const matchedCi = new Set(cells.filter((c) => c.match).map((c) => c.ci));
    const goldList = (goldens[pi]?.golden_comments || []).map((g) => g.comment);

    for (let ci = 0; ci < distinctCi; ci++) {
      if (matchedCi.has(ci)) continue; // matched -> TP, not FP
      const issue = sent[ci];
      if (!issue) continue;
      // why the judge rejected this candidate: its highest-confidence non-matches
      const notes = cells
        .filter((c) => c.ci === ci && !c.match)
        .sort((x, y) => y.confidence - x.confidence)
        .slice(0, 3)
        .map((c) => c.reasoning)
        .filter(Boolean);
      fps.push({
        pi,
        ci,
        repo: (cands[pi]?.repo || "?").split("/").pop() || "?",
        prNumber: cands[pi]?.prNumber ?? null,
        comment: issue.comment,
        location: issue.location || "",
        severity: issue.severity || "?",
        goldens: goldList,
        judgeNotes: notes,
      });
    }
  }
  return { fps, warnings };
}

function fmtList(items: string[], cap = MAX_GOLDENS_IN_PROMPT): string {
  if (!items.length) return "(none)";
  return items.slice(0, cap).map((t) => `- ${t}`).join("\n");
}

class FPClassifier {
  private client: Anthropic;
  constructor(private model: string) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY environment variable required");
    this.client = new Anthropic({ apiKey: key });
    console.log(`Classifier model: ${model}`);
  }

  async classify(fp: FP): Promise<{ tag: string; reason: string; likely_real_bug: boolean }> {
    const prompt = PROMPT.replace("{comment}", fp.comment)
      .replace("{location}", fp.location || "(none)")
      .replace("{severity}", fp.severity)
      .replace("{golden_list}", fmtList(fp.goldens))
      .replace("{judge_notes}", fmtList(fp.judgeNotes, 3));

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT);
        const resp = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: 256,
            temperature: 0,
            system: "You are a precise code review error-attribution analyst. Always respond with valid JSON.",
            messages: [{ role: "user", content: prompt }],
          },
          { signal: controller.signal },
        );
        clearTimeout(t);
        let c = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
        if (c.startsWith("```")) { c = c.split("```")[1]; if (c.startsWith("json")) c = c.slice(4); c = c.trim(); }
        const p = JSON.parse(c);
        const tag = FP_TAGS.includes(p.tag) ? p.tag : "unclassified";
        return { tag, reason: p.reason ?? "", likely_real_bug: !!p.likely_real_bug };
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) return { tag: "unclassified", reason: `Error: ${err}`, likely_real_bug: false };
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
    return { tag: "unclassified", reason: "max retries", likely_real_bug: false };
  }
}

async function processBatch<T>(tasks: (() => Promise<T>)[], size = BATCH_SIZE): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += size) {
    const batch = tasks.slice(i, i + size);
    out.push(...(await Promise.all(batch.map((f) => f()))));
    if (i + size < tasks.length) await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

function printByTag(rows: { tag: string }[]) {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.tag] = (counts[r.tag] || 0) + 1;
  for (const [tag, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${tag}`);
  }
  return counts;
}

async function main() {
  const opts = parseArgs();
  const { fps, warnings } = extractFPs(opts.dir);
  for (const w of warnings) console.warn("WARN " + w);
  console.log(`\nRun dir: ${opts.dir}`);
  console.log(`False positives extracted: ${fps.length}` + (Number.isFinite(opts.limit) ? ` (classifying first ${opts.limit})` : ""));

  const subset = Number.isFinite(opts.limit) ? fps.slice(0, opts.limit) : fps;

  if (opts.dry) {
    console.log("\n--dry: FP candidates (no LLM call):");
    for (const fp of subset.slice(0, 40)) {
      console.log(`  [${fp.repo}#${fp.prNumber ?? "?"}] ${fp.severity.padEnd(8)} ${fp.location || "-"}`);
      console.log(`     ${fp.comment.slice(0, 120)}`);
    }
    if (subset.length > 40) console.log(`  … and ${subset.length - 40} more`);
    console.log(`\nFP per repo:`);
    const byRepo: Record<string, number> = {};
    for (const fp of fps) byRepo[fp.repo] = (byRepo[fp.repo] || 0) + 1;
    for (const [r, n] of Object.entries(byRepo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);
    console.log(`\nReady. Re-run without --dry (needs ANTHROPIC_API_KEY) to tag each FP.`);
    return;
  }

  const clf = new FPClassifier(opts.model);
  const tagged = await processBatch(subset.map((fp) => async () => ({ ...fp, ...(await clf.classify(fp)) })));

  console.log("\n=== FP attribution ===");
  const counts = printByTag(tagged);
  const incomplete = tagged.filter((t) => t.tag === "golden_incomplete" || t.likely_real_bug);
  if (incomplete.length) {
    console.log(`\n${incomplete.length} FP look like REAL bugs missing from the golden set (H6 — precision you are losing for free):`);
    for (const t of incomplete.slice(0, 15)) console.log(`  [${t.repo}#${t.prNumber ?? "?"}] ${t.location || "-"} :: ${t.comment.slice(0, 90)}`);
  }

  writeFileSync(
    opts.out,
    JSON.stringify(
      {
        run: opts.dir,
        model: opts.model,
        total_fp: fps.length,
        classified: tagged.length,
        by_tag: counts,
        golden_incomplete_count: incomplete.length,
        fps: tagged.map((t) => ({
          repo: t.repo, prNumber: t.prNumber, location: t.location, severity: t.severity,
          tag: t.tag, reason: t.reason, likely_real_bug: t.likely_real_bug, comment: t.comment,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${opts.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env npx tsx
/**
 * Benchmark Judge — evaluates code review results against golden comments.
 *
 * Uses the EXACT same judge prompt as withmartian/code-review-benchmark
 * with Sonnet 4.6 as the LLM judge (N×M pairwise comparisons).
 *
 * Usage:
 *   npx tsx scripts/benchmark/judge.ts --candidates candidates.json [--tool kodus] [--output results/evaluations.json]
 *   npx tsx scripts/benchmark/judge.ts --help
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type {
  BenchmarkData,
  BenchmarkPR,
  BenchmarkResults,
  CandidateIssue,
  JudgeMatch,
  PREvaluation,
  Severity,
} from "./types";

/**
 * EXACT judge prompt from withmartian/code-review-benchmark
 * Source: offline/code_review_benchmark/step3_judge_comments.py
 */
const JUDGE_PROMPT = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
{golden_comment}

Candidate Issue (from the tool's review):
{candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}}`;

const BATCH_SIZE = 20; // concurrent LLM calls
const LLM_CALL_TIMEOUT = 30_000; // 30s per call
const MAX_RETRIES = 3;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Benchmark Judge — evaluate code review results against golden comments.

Uses Sonnet 4.6 as judge with the EXACT withmartian/code-review-benchmark prompt.
Requires ANTHROPIC_API_KEY environment variable.

Usage:
  npx tsx scripts/benchmark/judge.ts --candidates <path> [options]

Options:
  --candidates <path>   Path to candidates.json (from extract.ts)
  --tool <name>         Tool name for labeling results (default: "kodus")
  --output <path>       Output path (default: scripts/benchmark/results/evaluations.json)
  --help                Show this help
`);
    process.exit(0);
  }

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val) opts[key] = val;
  }

  if (!opts.candidates) {
    console.error("Error: --candidates <path> is required");
    process.exit(1);
  }

  return {
    candidatesPath: opts.candidates,
    tool: opts.tool ?? "kodus",
    outputPath:
      opts.output ??
      resolve(__dirname, "results", "evaluations.json"),
  };
}

class SonnetJudge {
  private client: Anthropic;
  private model = "claude-sonnet-4-20250514";

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable required");
    }
    this.client = new Anthropic({ apiKey });
    console.log(`Judge model: ${this.model}`);
  }

  async matchComment(
    goldenComment: string,
    candidate: string,
  ): Promise<{ reasoning: string; match: boolean; confidence: number }> {
    const prompt = JUDGE_PROMPT
      .replace("{golden_comment}", goldenComment)
      .replace("{candidate}", candidate);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          LLM_CALL_TIMEOUT,
        );

        const response = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: 256,
            temperature: 0,
            system:
              "You are a precise code review evaluator. Always respond with valid JSON.",
            messages: [{ role: "user", content: prompt }],
          },
          { signal: controller.signal },
        );

        clearTimeout(timeout);

        let content =
          response.content[0]?.type === "text"
            ? response.content[0].text.trim()
            : "";

        // Strip markdown code blocks if present
        if (content.startsWith("```")) {
          content = content.split("```")[1];
          if (content.startsWith("json")) content = content.slice(4);
          content = content.trim();
        }

        const parsed = JSON.parse(content);
        return {
          reasoning: parsed.reasoning ?? "",
          match: !!parsed.match,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        };
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) {
          return { reasoning: `Error: ${err}`, match: false, confidence: 0 };
        }
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }

    return { reasoning: "Max retries exceeded", match: false, confidence: 0 };
  }
}

/**
 * Process tasks in batches with concurrency control.
 * Same pattern as withmartian's process_batch.
 */
async function processBatch<T>(
  tasks: (() => Promise<T>)[],
  batchSize: number = BATCH_SIZE,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        results.push({
          reasoning: `Error: ${r.reason}`,
          match: false,
          confidence: 0,
        } as T);
      }
    }
    // Small delay between batches to avoid rate limits
    if (i + batchSize < tasks.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return results;
}

/**
 * Evaluate a single PR — N×M pairwise comparisons.
 * Same algorithm as withmartian's evaluate_review.
 */
async function evaluatePR(
  pr: BenchmarkPR,
  candidate: CandidateIssue | undefined,
  tool: string,
  judge: SonnetJudge,
): Promise<PREvaluation> {
  const goldenComments = pr.golden_comments;
  const candidateIssues = candidate?.issues ?? [];

  if (candidateIssues.length === 0) {
    return {
      pr_title: pr.title,
      repo: repoFromPR(pr),
      source_url: pr.source_url,
      tool,
      true_positives: 0,
      false_positives: 0,
      false_negatives: goldenComments.length,
      precision: 0,
      recall: 0,
      f1: 0,
      matches: [],
      comment: `No candidates. Missed all ${goldenComments.length} golden comments.`,
    };
  }

  // Create N×M matching tasks (each golden × each candidate)
  const tasks: (() => Promise<{
    gi: number;
    ci: number;
    result: { reasoning: string; match: boolean; confidence: number };
  }>)[] = [];

  for (let gi = 0; gi < goldenComments.length; gi++) {
    for (let ci = 0; ci < candidateIssues.length; ci++) {
      const golden = goldenComments[gi].comment;
      const cand = candidateIssues[ci].comment;
      tasks.push(async () => ({
        gi,
        ci,
        result: await judge.matchComment(golden, cand),
      }));
    }
  }

  // Process all comparisons with batching
  const pairResults = await processBatch(tasks);

  // Build match matrix — same logic as withmartian
  // For each golden comment, find the best-matching candidate (highest confidence)
  const goldenMatched = new Map<
    number,
    { ci: number; confidence: number; reasoning: string; candidateText: string }
  >();
  const candidateMatched = new Set<number>();

  for (const { gi, ci, result } of pairResults) {
    if (!result.match) continue;

    const existing = goldenMatched.get(gi);
    if (!existing || result.confidence > existing.confidence) {
      goldenMatched.set(gi, {
        ci,
        confidence: result.confidence,
        reasoning: result.reasoning,
        candidateText: candidateIssues[ci].comment,
      });
    }
  }

  // Mark matched candidates
  for (const [, info] of goldenMatched) {
    candidateMatched.add(info.ci);
  }

  // Build matches array
  const matches: JudgeMatch[] = [];
  for (const [gi, info] of goldenMatched) {
    matches.push({
      golden_comment: goldenComments[gi].comment,
      candidate_comment: info.candidateText,
      reasoning: info.reasoning,
      match: true,
      confidence: info.confidence,
    });
  }

  const tp = goldenMatched.size;
  const fp = candidateIssues.length - candidateMatched.size;
  const fn = goldenComments.length - goldenMatched.size;

  const precision = tp + fp === 0 ? 1.0 : round(tp / (tp + fp));
  const recall = tp + fn === 0 ? 1.0 : round(tp / (tp + fn));
  const f1 =
    precision + recall === 0
      ? 0.0
      : round((2 * precision * recall) / (precision + recall));

  const missedComments = goldenComments
    .filter((_, i) => !goldenMatched.has(i))
    .map((g) => g.comment);

  return {
    pr_title: pr.title,
    repo: repoFromPR(pr),
    source_url: pr.source_url,
    tool,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
    precision,
    recall,
    f1,
    matches,
    comment: `Found ${tp}/${goldenComments.length} bugs. ${fp} false positives.${
      missedComments.length > 0
        ? ` Missed: ${missedComments.map((c) => `"${c.slice(0, 60)}..."`).join(", ")}`
        : ""
    }`,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function repoFromPR(pr: BenchmarkPR): string {
  return pr.repo.split("/").pop() ?? pr.repo;
}

function aggregateResults(
  evaluations: PREvaluation[],
  benchmarkData: BenchmarkData,
  tool: string,
): BenchmarkResults {
  const totalTP = evaluations.reduce((s, e) => s + e.true_positives, 0);
  const totalFP = evaluations.reduce((s, e) => s + e.false_positives, 0);
  const totalFN = evaluations.reduce((s, e) => s + e.false_negatives, 0);
  const totalGolden = benchmarkData.prs.reduce(
    (s, p) => s + p.golden_comments.length,
    0,
  );

  const precision =
    totalTP + totalFP === 0 ? 1.0 : round(totalTP / (totalTP + totalFP));
  const recall =
    totalTP + totalFN === 0 ? 1.0 : round(totalTP / (totalTP + totalFN));
  const f1 =
    precision + recall === 0
      ? 0.0
      : round((2 * precision * recall) / (precision + recall));

  // By repo
  const byRepo: BenchmarkResults["by_repo"] = {};
  const repos = [...new Set(benchmarkData.prs.map(repoFromPR))];
  for (const repo of repos) {
    const repoEvals = evaluations.filter((e) => e.repo === repo);
    const repoPRs = benchmarkData.prs.filter((p) => repoFromPR(p) === repo);
    const rTP = repoEvals.reduce((s, e) => s + e.true_positives, 0);
    const rFP = repoEvals.reduce((s, e) => s + e.false_positives, 0);
    const rFN = repoEvals.reduce((s, e) => s + e.false_negatives, 0);
    const rGolden = repoPRs.reduce(
      (s, p) => s + p.golden_comments.length,
      0,
    );

    byRepo[repo] = {
      prs: repoPRs.length,
      golden_comments: rGolden,
      true_positives: rTP,
      false_positives: rFP,
      false_negatives: rFN,
      precision: rTP + rFP === 0 ? 1.0 : round(rTP / (rTP + rFP)),
      recall: rTP + rFN === 0 ? 1.0 : round(rTP / (rTP + rFN)),
      f1:
        rTP + rFP === 0 && rTP + rFN === 0
          ? 1.0
          : round(
              (2 * rTP) /
                (2 * rTP + rFP + rFN || 1),
            ),
    };
  }

  // By severity
  const severities: Severity[] = ["Critical", "High", "Medium", "Low"];
  const bySeverity: BenchmarkResults["by_severity"] = {} as BenchmarkResults["by_severity"];
  for (const sev of severities) {
    const total = benchmarkData.prs.reduce(
      (s, p) => s + p.golden_comments.filter((c) => c.severity === sev).length,
      0,
    );
    const found = evaluations.reduce((s, e) => {
      const pr = benchmarkData.prs.find((p) => p.title === e.pr_title);
      if (!pr) return s;
      return (
        s +
        e.matches.filter((m) => {
          const goldenMatch = pr.golden_comments.find(
            (gc) => gc.comment === m.golden_comment && gc.severity === sev,
          );
          return goldenMatch && m.match;
        }).length
      );
    }, 0);

    bySeverity[sev] = {
      total,
      found,
      recall: total === 0 ? 1.0 : round(found / total),
    };
  }

  return {
    evaluated_at: new Date().toISOString(),
    tool,
    summary: {
      total_prs: evaluations.length,
      total_golden_comments: totalGolden,
      total_true_positives: totalTP,
      total_false_positives: totalFP,
      total_false_negatives: totalFN,
      precision,
      recall,
      f1,
    },
    by_repo: byRepo,
    by_severity: bySeverity,
    evaluations,
  };
}

async function main() {
  const opts = parseArgs();

  console.log(`Loading candidates from ${opts.candidatesPath}...`);
  const candidates: CandidateIssue[] = JSON.parse(
    readFileSync(resolve(opts.candidatesPath), "utf-8"),
  );

  console.log(`Loading benchmark PRs...`);
  const benchmarkData: BenchmarkData = JSON.parse(
    readFileSync(resolve(__dirname, "prs-benchmark.json"), "utf-8"),
  );

  const totalGolden = benchmarkData.prs.reduce(
    (s, p) => s + p.golden_comments.length,
    0,
  );
  const totalCandidates = candidates.reduce(
    (s, c) => s + c.issues.length,
    0,
  );
  const totalComparisons = benchmarkData.prs.reduce((s, pr) => {
    const cand = candidates.find(
      (c) => c.pr_title === pr.title || c.pr_url === pr.source_url,
    );
    return s + pr.golden_comments.length * (cand?.issues.length ?? 0);
  }, 0);

  console.log(
    `Evaluating ${totalCandidates} candidates against ${totalGolden} golden comments (${totalComparisons} pairwise comparisons)`,
  );

  const judge = new SonnetJudge();
  const evaluations: PREvaluation[] = [];

  for (let i = 0; i < benchmarkData.prs.length; i++) {
    const pr = benchmarkData.prs[i];
    const candidate = candidates.find(
      (c) => c.pr_title === pr.title || c.pr_url === pr.source_url,
    );

    const nComparisons =
      pr.golden_comments.length * (candidate?.issues.length ?? 0);
    console.log(
      `  [${i + 1}/${benchmarkData.prs.length}] ${pr.title.slice(0, 50).padEnd(50)} ${candidate?.issues.length ?? 0} candidates × ${pr.golden_comments.length} golden = ${nComparisons} comparisons`,
    );

    const evaluation = await evaluatePR(pr, candidate, opts.tool, judge);
    evaluations.push(evaluation);

    // Progress update
    console.log(
      `    → TP=${evaluation.true_positives} FP=${evaluation.false_positives} FN=${evaluation.false_negatives} P=${evaluation.precision} R=${evaluation.recall} F1=${evaluation.f1}`,
    );
  }

  const results = aggregateResults(evaluations, benchmarkData, opts.tool);

  // Write output
  const outputDir = dirname(opts.outputPath);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(opts.outputPath, JSON.stringify(results, null, 2));

  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Benchmark Results — ${opts.tool} (judge: Sonnet 4.6)`);
  console.log(`${"=".repeat(60)}`);
  console.log(
    `Total PRs: ${results.summary.total_prs} | Golden: ${results.summary.total_golden_comments}`,
  );
  console.log(
    `Precision: ${results.summary.precision} | Recall: ${results.summary.recall} | F1: ${results.summary.f1}`,
  );
  console.log(
    `TP: ${results.summary.total_true_positives} | FP: ${results.summary.total_false_positives} | FN: ${results.summary.total_false_negatives}`,
  );
  console.log(`\nBy Repository:`);
  for (const [repo, stats] of Object.entries(results.by_repo)) {
    console.log(
      `  ${repo.padEnd(20)} P=${stats.precision} R=${stats.recall} F1=${stats.f1} (${stats.true_positives}/${stats.golden_comments} found)`,
    );
  }
  console.log(`\nBy Severity:`);
  for (const [sev, stats] of Object.entries(results.by_severity)) {
    console.log(
      `  ${sev.padEnd(10)} ${stats.found}/${stats.total} found (recall=${stats.recall})`,
    );
  }
  console.log(`\nResults written to ${opts.outputPath}`);
}

main().catch((err) => {
  console.error("Judge failed:", err);
  process.exit(1);
});

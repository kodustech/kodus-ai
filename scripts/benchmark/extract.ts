#!/usr/bin/env npx tsx
/**
 * Extract — pulls review comments from GitHub PRs and normalizes them into atomic issues.
 * Uses `gh` CLI for GitHub API access (no token needed — uses your existing gh auth).
 *
 * Usage:
 *   npx tsx scripts/benchmark/extract.ts --owner <org> [--tool kodus] [--output candidates.json]
 *   npx tsx scripts/benchmark/extract.ts --help
 */

import { generateObject } from "ai";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import type { BenchmarkData, CandidateIssue } from "./types";

const EXTRACT_SYSTEM_PROMPT = `You are an expert at analyzing code review comments.
Given a list of review comments from a pull request, extract the distinct atomic issues identified.
Each issue should be a single, clear problem statement.
Ignore meta-comments (e.g., "LGTM", "looks good", review summaries, deployment instructions).
Ignore style/formatting suggestions unless they point to a real bug.
Focus on bugs, logic errors, security issues, race conditions, and correctness problems.`;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Extract — pull review comments from GitHub PRs and normalize into atomic issues.
Uses the gh CLI for authentication (run 'gh auth login' first).

Usage:
  npx tsx scripts/benchmark/extract.ts --owner <org> [options]

Options:
  --owner <org>         GitHub org that owns the forked repos (required)
  --tool <name>         Label for the review tool (default: "kodus")
  --output <path>       Output path (default: scripts/benchmark/candidates.json)
  --model <id>          Model for normalization (default: gemini-2.5-flash)
  --help                Show this help

Prerequisites:
  - gh CLI installed and authenticated (gh auth login)
  - GOOGLE_GENERATIVE_AI_API_KEY set for LLM normalization

The script reads prs-benchmark.json to know which PRs to fetch,
then pulls review comments from GitHub and uses an LLM to
normalize them into atomic issue statements.
`);
    process.exit(0);
  }

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val) opts[key] = val;
  }

  if (!opts.owner) {
    console.error("Error: --owner <org> is required");
    process.exit(1);
  }

  return {
    owner: opts.owner,
    tool: opts.tool ?? "kodus",
    outputPath:
      opts.output ?? resolve(__dirname, "candidates.json"),
    model: opts.model ?? "gemini-2.5-flash",
  };
}

function checkGhCli() {
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch {
    console.error(
      "Error: gh CLI is not authenticated. Run 'gh auth login' first.",
    );
    process.exit(1);
  }
}

function gh<T>(endpoint: string): T {
  try {
    const result = execSync(
      `gh api "${endpoint}" --paginate`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(result) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("Not Found")) {
      return [] as T;
    }
    throw err;
  }
}

interface GitHubPR {
  number: number;
  title: string;
}

interface GitHubComment {
  body: string;
  path?: string;
  line?: number;
  user: { login: string };
  created_at: string;
}

function fetchPRComments(
  owner: string,
  repo: string,
): { prNumber: number; title: string; comments: GitHubComment[] }[] {
  const prs = gh<GitHubPR[]>(
    `/repos/${owner}/${repo}/pulls?state=all&per_page=100`,
  );

  if (!Array.isArray(prs) || prs.length === 0) {
    console.warn(`  Warning: No PRs found for ${owner}/${repo}`);
    return [];
  }

  const results: { prNumber: number; title: string; comments: GitHubComment[] }[] = [];

  for (const pr of prs) {
    const reviewComments = gh<GitHubComment[]>(
      `/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=100`,
    );

    const issueComments = gh<GitHubComment[]>(
      `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`,
    );

    const allComments = [
      ...(Array.isArray(reviewComments) ? reviewComments : []),
      ...(Array.isArray(issueComments) ? issueComments : []),
    ];

    results.push({
      prNumber: pr.number,
      title: pr.title,
      comments: allComments,
    });
  }

  return results;
}

const issuesSchema = z.object({
  issues: z.array(
    z.object({
      comment: z
        .string()
        .describe("A single atomic issue identified in the review"),
      file: z.string().optional().describe("File path if mentioned"),
      line: z.number().optional().describe("Line number if mentioned"),
    }),
  ),
});

async function normalizeComments(
  prTitle: string,
  comments: GitHubComment[],
  model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>>,
): Promise<CandidateIssue["issues"]> {
  if (comments.length === 0) return [];

  const commentTexts = comments
    .filter((c) => c.body && c.body.length > 10)
    .map(
      (c) =>
        `${c.path ? `[${c.path}${c.line ? `:${c.line}` : ""}] ` : ""}${c.body}`,
    )
    .join("\n---\n");

  if (!commentTexts.trim()) return [];

  const { object } = await generateObject({
    model,
    system: EXTRACT_SYSTEM_PROMPT,
    prompt: `PR: "${prTitle}"

Review comments:
${commentTexts}

Extract distinct atomic issues from these review comments. Ignore meta-comments, summaries, and deployment instructions.`,
    schema: issuesSchema,
  });

  return object.issues;
}

async function main() {
  const opts = parseArgs();

  console.log("Checking gh CLI authentication...");
  checkGhCli();

  console.log(`Loading benchmark PRs...`);
  const benchmarkData: BenchmarkData = JSON.parse(
    readFileSync(resolve(__dirname, "prs-benchmark.json"), "utf-8"),
  );

  console.log(
    `Extracting review comments for ${benchmarkData.prs.length} PRs from org "${opts.owner}"...`,
  );

  const google = createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  const model = google(opts.model);

  const candidates: CandidateIssue[] = [];

  // Group PRs by repo
  const prsByRepo = new Map<string, typeof benchmarkData.prs>();
  for (const pr of benchmarkData.prs) {
    const repoName = pr.repo.split("/").pop() ?? pr.repo;
    const existing = prsByRepo.get(repoName) ?? [];
    existing.push(pr);
    prsByRepo.set(repoName, existing);
  }

  for (const [repoName, prs] of prsByRepo) {
    console.log(`\nRepo: ${opts.owner}/${repoName} (${prs.length} PRs)`);

    const prComments = fetchPRComments(opts.owner, repoName);

    for (const pr of prs) {
      // Match PR by title
      const matchedPR = prComments.find(
        (pc) => pc.title === pr.title,
      );

      const comments = matchedPR?.comments ?? [];

      // Filter out bot comments that are just triggers
      const relevantComments = comments.filter(
        (c) => c.body.length > 20 && !c.body.startsWith("/"),
      );

      console.log(
        `  ${pr.title.slice(0, 50).padEnd(50)} — ${relevantComments.length} comments`,
      );

      const issues = await normalizeComments(
        pr.title,
        relevantComments,
        model,
      );

      candidates.push({
        pr_title: pr.title,
        pr_url: pr.source_url,
        tool: opts.tool,
        issues,
      });
    }
  }

  writeFileSync(opts.outputPath, JSON.stringify(candidates, null, 2));
  console.log(
    `\nExtracted ${candidates.reduce((s, c) => s + c.issues.length, 0)} issues from ${candidates.length} PRs`,
  );
  console.log(`Written to ${opts.outputPath}`);
}

main().catch((err) => {
  console.error("Extract failed:", err);
  process.exit(1);
});

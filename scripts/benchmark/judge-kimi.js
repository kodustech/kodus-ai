#!/usr/bin/env node
/**
 * Judge benchmark candidates against golden comments using Kimi (Moonshot,
 * OpenAI-compatible). Identical scoring to judge-sonnet.js — same N×M pairwise
 * match matrix, same greedy 1:1 matching, same severity threshold outputs — only
 * the LLM client differs (OpenAI SDK → Moonshot base URL, KIMI key).
 *
 * Usage:
 *   KIMI=sk-... node judge-kimi.js <golden.json> <candidates-severity.json> <output-dir>
 * Env:
 *   KIMI            — Moonshot API key (required)
 *   KIMI_BASE_URL   — default https://api.moonshot.ai/v1
 *   KIMI_JUDGE_MODEL — default kimi-k2.6
 */
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const BASE = process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1";
// Default to a Moonshot model that accepts temperature=0: the kimi-k2.x / k3
// models force temperature=1 (nondeterministic), which is exactly what a judge
// must avoid — a deterministic judge minimizes measurement variance and makes
// its systematic bias cancel in a baseline-vs-treatment DELTA. Override with
// KIMI_JUDGE_MODEL if you want a different model.
const MODEL = process.env.KIMI_JUDGE_MODEL || "moonshot-v1-32k";

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
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

const BATCH_SIZE = 10; // concurrent LLM calls

/** Parse the judge's JSON leniently: strip fences, then try a strict parse;
 *  on failure, extract the first {...} block and, as a last resort, read
 *  match/confidence off the raw text with a regex. Returns null if nothing
 *  usable is found (caller retries once). Keeps a malformed-but-answered
 *  response from silently dropping a pair (which understates recall). */
function parseVerdict(text) {
    const clean = String(text || "").replace(/```json?/g, "").replace(/```/g, "").trim();
    const tryParse = (s) => {
        try {
            const j = JSON.parse(s);
            if (typeof j.match === "boolean") return j;
        } catch {}
        return null;
    };
    let j = tryParse(clean);
    if (j) return j;
    const block = clean.match(/\{[\s\S]*\}/);
    if (block) {
        j = tryParse(block[0]);
        if (j) return j;
    }
    // Last resort: regex the two fields out of a malformed object.
    const m = clean.match(/"match"\s*:\s*(true|false)/i);
    if (m) {
        const cf = clean.match(/"confidence"\s*:\s*([0-9.]+)/);
        return { match: /true/i.test(m[1]), confidence: cf ? parseFloat(cf[1]) : 0.5, reasoning: "" };
    }
    return null;
}

/** One judge call with a single retry on an unparseable response. */
async function judgeOne(client, prompt) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const resp = await client.chat.completions.create({
            model: MODEL,
            max_tokens: 200,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
        });
        const v = parseVerdict(resp.choices[0].message.content);
        if (v) return v;
    }
    throw new Error("unparseable judge response after retry");
}

/**
 * Run N×M pairwise comparison and return raw match matrix.
 * matrix[prIdx] = array of { gi, ci, match, confidence, reasoning }
 */
async function buildMatchMatrix(client, golden, candidates) {
    const matrix = [];

    for (let i = 0; i < golden.length; i++) {
        const pr = golden[i];
        const cand = candidates[i];
        const prMatches = [];

        // Build all (golden, candidate) pairs for this PR
        const pairs = [];
        for (let gi = 0; gi < pr.golden_comments.length; gi++) {
            for (let ci = 0; ci < cand.issues.length; ci++) {
                pairs.push({ gi, ci });
            }
        }

        // Process in batches
        for (let b = 0; b < pairs.length; b += BATCH_SIZE) {
            const batch = pairs.slice(b, b + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(async ({ gi, ci }) => {
                    const prompt = JUDGE_PROMPT
                        .replace("{golden_comment}", pr.golden_comments[gi].comment)
                        .replace("{candidate}", cand.issues[ci].comment);

                    const json = await judgeOne(client, prompt);
                    return { gi, ci, match: !!json.match, confidence: json.confidence || 0, reasoning: json.reasoning || "" };
                })
            );

            for (const r of results) {
                if (r.status === "fulfilled") {
                    prMatches.push(r.value);
                } else {
                    process.stderr.write("    judge error: " + (r.reason?.message || r.reason).toString().substring(0, 100) + "\n");
                }
            }
        }

        matrix.push(prMatches);

        const repo = cand.repo || pr.repo.split("/").pop();
        const matchCount = prMatches.filter(m => m.match).length;
        process.stderr.write(
            "    " + repo.padEnd(18) + (pr.title || "").substring(0, 37).padEnd(39) +
            "pairs=" + pairs.length + " matches=" + matchCount + "\n"
        );
    }

    return matrix;
}

/**
 * From a match matrix, compute greedy 1:1 matching for a subset of candidates.
 * candidateFilter: function(candidate, index) => boolean
 */
function computeGreedyMatching(matrix, golden, candidates, candidateFilter) {
    let totalTP = 0, totalFP = 0, totalFN = 0;
    const prResults = [];
    const repoStats = {};

    for (let i = 0; i < golden.length; i++) {
        const pr = golden[i];
        const cand = candidates[i];
        const prMatches = matrix[i];

        // Filter to only candidates that pass the filter
        const validCandidates = new Set();
        cand.issues.forEach((c, ci) => {
            if (candidateFilter(c, ci)) validCandidates.add(ci);
        });

        // Get all positive matches involving valid candidates, sorted by confidence desc
        const positiveMatches = prMatches
            .filter(m => m.match && validCandidates.has(m.ci))
            .sort((a, b) => b.confidence - a.confidence);

        // Greedy 1:1 matching
        const goldenMatched = new Set();
        const candMatched = new Set();
        const matches = [];

        for (const m of positiveMatches) {
            if (goldenMatched.has(m.gi) || candMatched.has(m.ci)) continue;
            matches.push([m.ci, m.gi]);
            goldenMatched.add(m.gi);
            candMatched.add(m.ci);
        }

        const tp = matches.length;
        const fp = validCandidates.size - tp;
        const fn = pr.golden_comments.length - tp;
        totalTP += tp;
        totalFP += fp;
        totalFN += fn;

        const repo = cand.repo || pr.repo.split("/").pop();
        const matchedG = new Set(matches.map(m => m[1]));
        const matchedC = new Set(matches.map(m => m[0]));
        const found = pr.golden_comments.filter((g, gi) => matchedG.has(gi)).map(g => ({ comment: g.comment.substring(0, 120), severity: g.severity }));
        const missed = pr.golden_comments.filter((g, gi) => !matchedG.has(gi)).map(g => ({ comment: g.comment.substring(0, 120), severity: g.severity }));
        const noise = cand.issues.filter((c, ci) => validCandidates.has(ci) && !matchedC.has(ci)).map(c => c.comment.substring(0, 120));

        prResults.push({ repo, title: (pr.title || "").substring(0, 50), tp, fp, fn, golden: pr.golden_comments.length, candidates: validCandidates.size, found, missed, noise });

        if (!repoStats[repo]) repoStats[repo] = { tp: 0, fp: 0, fn: 0, golden: 0, candidates: 0, prs: 0 };
        repoStats[repo].tp += tp;
        repoStats[repo].fp += fp;
        repoStats[repo].fn += fn;
        repoStats[repo].golden += pr.golden_comments.length;
        repoStats[repo].candidates += validCandidates.size;
        repoStats[repo].prs++;
    }

    const p = totalTP / (totalTP + totalFP) || 0;
    const r = totalTP / (totalTP + totalFN) || 0;
    const f1 = p + r === 0 ? 0 : 2 * p * r / (p + r);

    return { tp: totalTP, fp: totalFP, fn: totalFN, precision: p, recall: r, f1, prResults, repoStats };
}

async function main() {
    const [goldenFile, candidatesFile, outputDir] = process.argv.slice(2);

    if (!goldenFile || !candidatesFile || !outputDir) {
        console.error("Usage: node judge-kimi.js <golden.json> <candidates-severity.json> <output-dir>");
        process.exit(1);
    }

    const apiKey = process.env.KIMI;
    if (!apiKey) {
        console.error("KIMI not set");
        process.exit(1);
    }

    process.stderr.write(`  Judge: Kimi ${MODEL} @ ${BASE}\n`);
    const client = new OpenAI.default({ apiKey, baseURL: BASE });
    const golden = JSON.parse(fs.readFileSync(goldenFile, "utf8"));
    const candidates = JSON.parse(fs.readFileSync(candidatesFile, "utf8"));

    // Step 1: Build match matrix (all N×M comparisons, done ONCE)
    process.stderr.write("  Building match matrix...\n");
    const matrix = await buildMatchMatrix(client, golden, candidates);

    // Step 2: Compute results at multiple severity thresholds from the same matrix
    const severityThresholds = {
        critical: new Set(["critical"]),
        high: new Set(["critical", "high"]),
        medium: new Set(["critical", "high", "medium"]),
        all: new Set(["critical", "high", "medium", "low", "unknown"]),
    };

    for (const [level, accepted] of Object.entries(severityThresholds)) {
        process.stderr.write(`  Computing ${level} results...\n`);
        const result = computeGreedyMatching(matrix, golden, candidates, (c) =>
            accepted.has((c.severity || "unknown").toLowerCase())
        );
        result.level = level;
        fs.writeFileSync(path.join(outputDir, `results-${level}.json`), JSON.stringify(result, null, 2));
        process.stderr.write(`    ${level}: F1=${result.f1.toFixed(3)} P=${result.precision.toFixed(3)} R=${result.recall.toFixed(3)} TP=${result.tp} FP=${result.fp}\n`);
    }

    // Also keep the "severity" alias pointing to "all" for backwards compat
    try {
        const allResult = JSON.parse(fs.readFileSync(path.join(outputDir, "results-all.json"), "utf8"));
        allResult.level = "severity";
        fs.writeFileSync(path.join(outputDir, "results-severity.json"), JSON.stringify(allResult, null, 2));
    } catch {}

    // Save raw matrix for debugging
    fs.writeFileSync(path.join(outputDir, "match-matrix.json"), JSON.stringify(matrix, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });

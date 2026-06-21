// Scorecard: score the benchmark's collected findings against golden_comments
// and emit a per-model precision/recall report. This is the QUALITY artifact —
// NOT a pass/fail gate (the mechanical gate is "all reviews completed", in
// run.ts). Reuses the same Sonnet-judge matching algorithm as
// scripts/benchmark/judge.ts so numbers are comparable.
//
// Input:  tests/e2e/benchmark/results.json (from run.ts)
// Output: tests/e2e/benchmark/scorecard.json + a printed table.
// Needs:  ANTHROPIC_API_KEY (the judge; falls back to BYOK_ANTHROPIC_API_KEY).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Pull the judge key from ~/.kodus-dev/config if not already in env.
function loadConfig(): void {
    let text: string;
    try {
        text = readFileSync(join(homedir(), ".kodus-dev", "config"), "utf8");
    } catch {
        return;
    }
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined) {
            // Strip a trailing inline comment (" # ...") + surrounding quotes +
            // trailing whitespace — config lines like `KEY=sk-... # note` would
            // otherwise carry the comment into the value and 401 the judge.
            const v = m[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
            if (!v.startsWith("op://")) process.env[m[1]] = v;
        }
    }
}

const JUDGE_MODEL = "claude-sonnet-4-6";
const MATCH_CONFIDENCE = 0.5;

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

interface PRResult {
    model: string;
    modelId?: string;
    repo: string;
    prNumber?: number;
    golden_comments?: { comment: string; severity?: string }[];
    findings?: string[];
    error?: string;
}

// Call the judge once. Fail LOUD on a misconfigured judge (bad key, bad model,
// bad request) — a broken judge must abort, never silently score every pair as
// "no match" and emit a fake 0.00 scorecard. Retry only transient 429/5xx.
async function judgeCall(apiKey: string, prompt: string): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
        // Hard per-call timeout. Without it a hung socket (ESTABLISHED but no
        // bytes — the Anthropic API occasionally stalls a request) blocks fetch
        // FOREVER: the retry below never fires because nothing throws, and the
        // whole scorecard wedges at 0% CPU. AbortController turns that stall into
        // a throw so the retry/backoff actually engages.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90_000);
        try {
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: JUDGE_MODEL,
                    max_tokens: 256,
                    messages: [{ role: "user", content: prompt }],
                }),
                signal: ctrl.signal,
            });
            if (resp.ok) {
                const data = (await resp.json()) as {
                    content?: { type: string; text?: string }[];
                };
                return data.content?.find((c) => c.type === "text")?.text ?? "{}";
            }
            const body = await resp.text();
            // Auth/bad-request = hard config error: fail loud immediately.
            if (resp.status === 401 || resp.status === 400) {
                throw new Error(
                    `judge call failed: HTTP ${resp.status} ${body.slice(0, 200)} — check the judge key (ANTHROPIC_API_KEY / BYOK_ANTHROPIC_API_KEY)`,
                );
            }
            lastErr = new Error(`judge HTTP ${resp.status} ${body.slice(0, 120)}`);
        } catch (e) {
            // Network/transport failure ("fetch failed") — retry, don't crash
            // the whole scorecard on one blip (a ~600-call run will hit some).
            lastErr = e;
            if (/HTTP (401|400)/.test((e as Error).message)) throw e;
        } finally {
            clearTimeout(timer);
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw new Error(`judge call exhausted retries: ${(lastErr as Error)?.message}`);
}

async function matchComment(
    apiKey: string,
    golden: string,
    candidate: string,
): Promise<{ match: boolean; confidence: number }> {
    const prompt = JUDGE_PROMPT.replace("{golden_comment}", golden).replace(
        "{candidate}",
        candidate.slice(0, 4000),
    );
    const text = await judgeCall(apiKey, prompt);
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
        const p = JSON.parse(json) as { match?: boolean; confidence?: number };
        return { match: !!p.match, confidence: p.confidence ?? 0 };
    } catch {
        return { match: false, confidence: 0 };
    }
}

interface ModelScore {
    model: string;
    prs: number;
    reviewed: number;
    tp: number;
    fp: number;
    fn: number;
    precision: number;
    recall: number;
    f1: number;
}

async function main() {
    loadConfig();
    const apiKey =
        process.env.ANTHROPIC_API_KEY || process.env.BYOK_ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY (judge) not set");
    // Default to run.ts's results.json; the farm overrides per-run (via
    // SCORECARD_RESULTS) so parallel slots judge their own file without
    // clobbering a shared one.
    const resultsPath =
        process.env.SCORECARD_RESULTS ?? join(process.cwd(), "benchmark", "results.json");
    const { results } = JSON.parse(readFileSync(resultsPath, "utf8")) as {
        results: PRResult[];
    };

    const byModel = new Map<string, ModelScore>();
    const get = (m: string): ModelScore =>
        byModel.get(m) ??
        (byModel.set(m, {
            model: m,
            prs: 0,
            reviewed: 0,
            tp: 0,
            fp: 0,
            fn: 0,
            precision: 0,
            recall: 0,
            f1: 0,
        }),
        byModel.get(m)!);

    for (const pr of results) {
        const s = get(pr.model);
        s.prs += 1;
        if (pr.error) continue;
        s.reviewed += 1;
        const golden = pr.golden_comments ?? [];
        const findings = pr.findings ?? [];
        const matchedGolden = new Set<number>();
        const matchedFinding = new Set<number>();
        for (let gi = 0; gi < golden.length; gi++) {
            for (let fi = 0; fi < findings.length; fi++) {
                const r = await matchComment(
                    apiKey,
                    golden[gi].comment,
                    findings[fi],
                );
                if (r.match && r.confidence >= MATCH_CONFIDENCE) {
                    matchedGolden.add(gi);
                    matchedFinding.add(fi);
                }
            }
        }
        s.tp += matchedGolden.size;
        s.fn += golden.length - matchedGolden.size;
        s.fp += findings.length - matchedFinding.size;
    }

    const scores: ModelScore[] = [];
    for (const s of byModel.values()) {
        s.precision = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 0;
        s.recall = s.tp + s.fn ? s.tp / (s.tp + s.fn) : 0;
        s.f1 = s.precision + s.recall
            ? (2 * s.precision * s.recall) / (s.precision + s.recall)
            : 0;
        scores.push(s);
    }
    scores.sort((a, b) => b.f1 - a.f1);

    console.log("\n=== Tier-0 model code-review scorecard ===");
    console.log(
        "model".padEnd(26) +
            "reviewed".padEnd(10) +
            "TP/FP/FN".padEnd(12) +
            "prec".padEnd(7) +
            "recall".padEnd(8) +
            "f1",
    );
    for (const s of scores) {
        console.log(
            s.model.padEnd(26) +
                `${s.reviewed}/${s.prs}`.padEnd(10) +
                `${s.tp}/${s.fp}/${s.fn}`.padEnd(12) +
                s.precision.toFixed(2).padEnd(7) +
                s.recall.toFixed(2).padEnd(8) +
                s.f1.toFixed(2),
        );
    }
    const out = process.env.SCORECARD_OUT ?? join(process.cwd(), "benchmark", "scorecard.json");
    writeFileSync(out, JSON.stringify({ scoredAt: new Date().toISOString(), scores }, null, 2));
    console.log(`\n→ ${out}`);
}

main().catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exit(1);
});

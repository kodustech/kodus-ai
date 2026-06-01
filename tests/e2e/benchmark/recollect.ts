// Re-collect findings from the FINAL (settled) state of each benchmark PR.
//
// A run that collected findings the instant the review started can undercount
// (Kody posts inline findings over several seconds). The PRs persist (closed,
// comments intact), so this re-reads each PR's inline comments now that they've
// settled and rewrites results.json — making the scorecard accurate without
// re-running the benchmark. Idempotent; safe to run repeatedly.
//
// Run:  GH_TEST_TOKEN=$(gh auth token) tsx benchmark/recollect.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function loadConfig(): void {
    try {
        const text = readFileSync(join(homedir(), ".kodus-dev", "config"), "utf8");
        for (const line of text.split("\n")) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
            if (m && process.env[m[1]] === undefined) {
                const v = m[2].replace(/^["']|["']$/g, "");
                if (!v.startsWith("op://")) process.env[m[1]] = v;
            }
        }
    } catch { /* no config file — rely on env */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET with retries on transient 5xx/429/network — CI must not flake on a hiccup.
async function ghGetJson<T>(url: string): Promise<T> {
    const headers = { Authorization: `Bearer ${process.env.GH_TEST_TOKEN}`, Accept: "application/vnd.github+json" };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const r = await fetch(url, { headers });
            if (r.ok) return (await r.json()) as T;
            if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
            throw new Error(`GitHub ${r.status} on ${url}`);
        } catch (e) { lastErr = e; await sleep(2000 * 2 ** attempt); }
    }
    throw new Error(`ghGetJson exhausted retries: ${url} (${(lastErr as Error)?.message})`);
}

async function collectFindings(repo: string, prNumber: number): Promise<string[]> {
    const arr = await ghGetJson<{ body?: string }[]>(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`,
    );
    if (!Array.isArray(arr)) return [];
    return arr
        .map((c) => (c.body ?? "").trim())
        .filter((b) => b && !b.toLowerCase().startsWith("@kody"))
        .map((b) => b.replace(/^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+/i, "").trim());
}

interface PRResult { repo: string; prNumber?: number; findings?: string[]; error?: string }

async function main(): Promise<void> {
    loadConfig();
    const path = join(process.cwd(), "benchmark", "results.json");
    const data = JSON.parse(readFileSync(path, "utf8")) as { results: PRResult[] };
    let changed = 0;
    for (const r of data.results) {
        if (r.error || !r.prNumber) continue;
        const before = r.findings?.length ?? 0;
        const settled = await collectFindings(r.repo, r.prNumber);
        if (settled.length !== before) {
            console.log(`  ${r.repo}#${r.prNumber}: ${before} → ${settled.length} findings`);
            changed++;
        }
        r.findings = settled;
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
    console.log(`recollected ${data.results.length} PRs (${changed} corrected) → ${path}`);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });

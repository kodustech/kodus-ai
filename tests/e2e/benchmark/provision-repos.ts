// Provision the isolated per-model benchmark repos for the PARALLEL topology.
//
// The parallel benchmark needs each model to own its OWN copy of the 5 fixture
// repos (so 6 tenants never collide on a shared repo's single-owner webhook).
// This script creates `kodus-e2e/<base>-<modelSlug>` for every (base × model)
// and pushes just the two branches each benchmark PR needs (head + base) — the
// rest of the fixture's 75 branches are irrelevant.
//
// GitHub's template-generate flattens history and drops the PR branches, so we
// do a real git mirror+push. That means a large upload (~repo size per copy),
// so this MUST run OUTSIDE the network sandbox (plain shell, or Bash with
// dangerouslyDisableSandbox). It is idempotent: a copy that already has the
// head branch is skipped, so it's safe to re-run after an interrupted transfer.
//
// Run:  GH_TEST_TOKEN=$(gh auth token) tsx benchmark/provision-repos.ts
//       (BENCH_ONLY_MODEL=<slug> to provision a single model's 5 repos.)
import { execSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadTier0Models } from "./models.js";

const ORG = "kodus-e2e";
const TOKEN = process.env.GH_TEST_TOKEN || process.env.GH_DEV_TOKEN;
if (!TOKEN) throw new Error("GH_TEST_TOKEN not set");

interface BenchPR { repo: string; head: string; base: string }

function loadPRs(): BenchPR[] {
    const p = join(process.cwd(), "..", "..", "scripts", "benchmark", "tier0-bench-prs.json");
    return JSON.parse(readFileSync(p, "utf8")).prs as BenchPR[];
}

function sh(cmd: string, cwd?: string): string {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}
function gh(args: string): string {
    return sh(`gh ${args}`);
}
const authUrl = (repo: string) => `https://x-access-token:${TOKEN}@github.com/${repo}.git`;

function repoExists(full: string): boolean {
    try { gh(`api repos/${full} --jq .full_name`); return true; } catch { return false; }
}
function branchSha(full: string, branch: string): string | null {
    try { return gh(`api repos/${full}/branches/${encodeURIComponent(branch)} --jq .commit.sha`).trim(); } catch { return null; }
}
function createRepo(name: string): void {
    if (repoExists(`${ORG}/${name}`)) return;
    // private=false so the QA GitHub App + token can see it like the bases.
    gh(`api -X POST orgs/${ORG}/repos -f name=${name} -F private=false -f description="tier-0 benchmark fixture (isolated per-model copy)"`);
    console.log(`  + created ${ORG}/${name}`);
}

function main(): void {
    const only = process.env.BENCH_ONLY_MODEL;
    const models = loadTier0Models().filter((m) => !only || m.slug === only);
    const prs = loadPRs();
    // base repo -> the (head, base) branches its PR needs
    const bases = new Map<string, { head: string; base: string }>();
    for (const pr of prs) bases.set(pr.repo.split("/")[1], { head: pr.head, base: pr.base });

    console.log(`Provisioning ${models.length} models × ${bases.size} repos = ${models.length * bases.size} isolated repos`);

    for (const [base, br] of bases) {
        // Mirror the source once; reuse its objects for every model push.
        const work = mkdtempSync(join(tmpdir(), `bench-prov-${base}-`));
        const mirror = join(work, "src.git");
        console.log(`[${base}] cloning source (head=${br.head} base=${br.base})…`);
        sh(`git clone --mirror --quiet ${authUrl(`${ORG}/${base}`)} ${mirror}`);
        // The fixture's head/base SHAs — a copy is only valid if its branches
        // point at these EXACT commits (so the PR diff + shared ancestor match).
        const srcHead = branchSha(`${ORG}/${base}`, br.head);
        const srcBase = branchSha(`${ORG}/${base}`, br.base);
        try {
            for (const m of models) {
                const name = `${base}-${m.slug}`;
                const full = `${ORG}/${name}`;
                if (branchSha(full, br.head) === srcHead && branchSha(full, br.base) === srcBase) {
                    console.log(`  = ${name} branches already match source — skip`);
                    continue;
                }
                createRepo(name);
                // Force-push only the two branches the PR needs — force because a
                // prior bad copy (e.g. template-generate) leaves unrelated-history
                // branches that must be overwritten with the real commits.
                console.log(`  → force-pushing ${br.base} + ${br.head} to ${name}…`);
                sh(
                    `git push --force --quiet ${authUrl(full)} ` +
                        `refs/heads/${br.base}:refs/heads/${br.base} ` +
                        `refs/heads/${br.head}:refs/heads/${br.head}`,
                    mirror,
                );
                // Make the PR's base branch the repo default (clean PR target).
                try { gh(`api -X PATCH repos/${full} -f default_branch=${br.base}`); } catch { /* best-effort */ }
                console.log(`  ✓ ${name} ready`);
            }
        } finally {
            if (existsSync(work)) rmSync(work, { recursive: true, force: true });
        }
    }
    console.log("done.");
}

main();

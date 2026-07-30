// Per-run repo-sets for the benchmark farm — with a pre-cloned POOL + a local
// source-mirror cache, so the slow part (mirror + full-history push of the 5
// dataset repos) happens in the BACKGROUND, not on a run's hot path.
//
// Each run needs its OWN copy of the 5 dataset repos: parallel runs collide on a
// repo's single webhook owner, and re-opening PRs on a reused repo leaks prior
// review comments. So every run gets pristine `<org>/<base>-<RUN_ID>` repos.
//
// Why a pool: minting a set means git-mirroring each source (ai-code-review-
// benchmark/<base>) and force-pushing the head/base branches its PRs need. For
// big repos (grafana) that's minutes + flaky. So we keep K pre-built `*-pool-*`
// sets warm; a run CLAIMS one by renaming it to its RUN_ID (atomic: the first
// repo's rename is the lock), which is instant. No pool free -> clone inline.
//
// Local mirror cache (~/.cache/kodus-bench-mirrors/<base>.git): the source is
// mirrored ONCE and kept fresh with `remote update --prune`, so neither pool
// refill nor an inline clone re-downloads full history every time. `--mirror`
// keeps ALL refs, so the exact head/base branches are always present; we push
// only the subset each set needs.
//
// Modes (run OUTSIDE the network sandbox — large git transfer):
//   FARM_RUN_ID=<id> tsx clone-run-repos.ts            # provision inline (1 set)
//   FARM_RUN_ID=<id> tsx clone-run-repos.ts --claim    # claim a pool set -> RUN_ID (exit 3 = none free)
//   FARM_RUN_ID=<id> tsx clone-run-repos.ts --destroy  # delete the run's set
//   FARM_POOL_SIZE=3 tsx clone-run-repos.ts --refill   # top the pool up to K sets
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ORG = process.env.FARM_GH_ORG || "kodus-bench";
const TOKEN = process.env.FARM_GH_TOKEN || process.env.GH_CLONE_TOKEN || process.env.GH_TEST_TOKEN || process.env.GH_DEV_TOKEN;
if (!TOKEN) throw new Error("FARM_GH_TOKEN not set");

const MODE = process.argv.includes("--destroy") ? "destroy"
    : process.argv.includes("--refill") ? "refill"
    : process.argv.includes("--claim") ? "claim"
    : "provision";

const RUN_ID = process.env.FARM_RUN_ID;
if (MODE !== "refill" && !RUN_ID) throw new Error("FARM_RUN_ID not set");

const MIRROR_DIR = join(homedir(), ".cache", "kodus-bench-mirrors");

interface BenchPR { repo: string; head: string; base: string }

// applyCap=false loads the FULL 50 (pool sets are always full so any run can
// claim them); provision/claim of a capped smoke pass applyCap=true.
function loadPRs(applyCap = true): BenchPR[] {
    const p = join(process.cwd(), "..", "..", "scripts", "benchmark", "prs-benchmark.json");
    let prs = (JSON.parse(readFileSync(p, "utf8")).prs ?? []) as BenchPR[];
    const maxPrs = applyCap ? Number(process.env.FARM_MAX_PRS ?? 0) : 0;
    if (maxPrs > 0) {
        const seen = new Set<string>();
        const onePerRepo = prs.filter((p) => { const b = p.repo.split("/")[1]; if (seen.has(b)) return false; seen.add(b); return true; });
        prs = [...onePerRepo, ...prs.filter((p) => !onePerRepo.includes(p))].slice(0, maxPrs);
    }
    return prs;
}

function sh(cmd: string, cwd?: string): string {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}
// Big-repo pushes drop the connection on sideband/cleanup even though refs land;
// retry the idempotent force-push (a confirming retry returns fast).
function shRetry(cmd: string, cwd?: string, attempts = 4): void {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
        try { sh(cmd, cwd); return; }
        catch (e) { lastErr = e; console.log(`  push attempt ${i}/${attempts} failed; retrying…`); execSync(`sleep ${4 * i}`); }
    }
    throw lastErr;
}
const gh = (args: string) => sh(`gh ${args}`);
const authUrl = (repo: string) => `https://x-access-token:${TOKEN}@github.com/${repo}.git`;

function repoExists(full: string): boolean {
    try { gh(`api repos/${full} --jq .full_name`); return true; } catch { return false; }
}
function createRepo(name: string, descr: string): void {
    if (repoExists(`${ORG}/${name}`)) return;
    gh(`api -X POST orgs/${ORG}/repos -f name=${name} -F private=false -f description="${descr}"`);
}

// base -> { source, branches } for the dataset's PRs.
function branchesByBase(prs: BenchPR[]): Map<string, { source: string; branches: Set<string> }> {
    const m = new Map<string, { source: string; branches: Set<string> }>();
    for (const pr of prs) {
        const base = pr.repo.split("/")[1];
        if (!m.has(base)) m.set(base, { source: pr.repo, branches: new Set() });
        m.get(base)!.branches.add(pr.head);
        m.get(base)!.branches.add(pr.base);
    }
    return m;
}

// Local bare mirror of a source repo, kept fresh. Returns its path.
function ensureMirror(source: string): string {
    const base = source.split("/")[1];
    const path = join(MIRROR_DIR, `${base}.git`);
    if (existsSync(path)) {
        // Refresh refs (cheap, incremental). set-url first so a rotated token
        // doesn't get stuck on the old one baked into the remote URL.
        try { sh(`git -C ${path} remote set-url origin ${authUrl(source)}`); sh(`git -C ${path} remote update --prune`); }
        catch { /* keep the stale mirror on a transient fetch error */ }
    } else {
        mkdirSync(MIRROR_DIR, { recursive: true });
        console.log(`[${base}] caching source mirror (first time)…`);
        sh(`git clone --mirror --quiet ${authUrl(source)} ${path}`);
    }
    return path;
}

// Build one repo-set named <base>-<suffix>, pushing from the cached mirror.
function buildSet(suffix: string, prs: BenchPR[], descr: string): void {
    for (const [base, { source, branches }] of branchesByBase(prs)) {
        const name = `${base}-${suffix}`;
        const mirror = ensureMirror(source);
        createRepo(name, descr);
        const defaultBranch = [...branches].find((b) => /^(master|main)$/.test(b)) ?? [...branches][0];
        const refspecs = [...branches].map((b) => `refs/heads/${b}:refs/heads/${b}`).join(" ");
        console.log(`  -> ${name}: pushing ${branches.size} branches…`);
        shRetry(`git push --force --quiet ${authUrl(`${ORG}/${name}`)} ${refspecs}`, mirror);
        try { gh(`api -X PATCH repos/${ORG}/${name} -f default_branch=${defaultBranch}`); } catch { /* best-effort */ }
        console.log(`  ok ${name}`);
    }
}

// All complete pool-ids present in the org (a set is complete when every base
// has a `<base>-pool-<id>` repo).
function poolSets(): string[] {
    const bases = [...branchesByBase(loadPRs(false)).keys()];
    let names: string[] = [];
    try { names = gh(`api orgs/${ORG}/repos?per_page=100 --paginate --jq .[].name`).split("\n").filter(Boolean); }
    catch { return []; }
    const byId = new Map<string, Set<string>>();
    for (const n of names) {
        const m = n.match(/^(.+)-(pool-[a-z0-9]+)$/);
        if (m && bases.includes(m[1])) {
            if (!byId.has(m[2])) byId.set(m[2], new Set());
            byId.get(m[2])!.add(m[1]);
        }
    }
    return [...byId.entries()].filter(([, s]) => bases.every((b) => s.has(b))).map(([id]) => id);
}

function provision(): void {
    console.log(`Provisioning a set for run ${RUN_ID} (${ORG}/<base>-${RUN_ID})`);
    buildSet(RUN_ID!, loadPRs(), `farm run ${RUN_ID} (single-use)`);
    console.log("done.");
}

function destroy(): void {
    console.log(`Destroying run ${RUN_ID}'s set`);
    for (const base of branchesByBase(loadPRs()).keys()) {
        const full = `${ORG}/${base}-${RUN_ID}`;
        if (!repoExists(full)) continue;
        try { gh(`api -X DELETE repos/${full}`); console.log(`  - deleted ${full}`); }
        catch (e) { console.error(`  ! failed to delete ${full}: ${(e as Error).message}`); }
    }
    console.log("done.");
}

// Claim a pool set by renaming it to RUN_ID. The FIRST base's rename is the
// atomic lock (a concurrent claimer gets 404 and moves on). Exits 3 if no pool
// set is free, so bench-run falls back to an inline clone.
function claim(): void {
    const bases = [...branchesByBase(loadPRs(false)).keys()];
    for (const poolid of poolSets()) {
        try { gh(`api -X PATCH repos/${ORG}/${bases[0]}-${poolid} -f name=${bases[0]}-${RUN_ID}`); }
        catch { continue; } // taken/raced — next pool set
        // Lock acquired (bases[0] renamed). The remaining renames MUST all land,
        // or the set is left half-pool/half-run (neither a usable pool set nor a
        // complete run set). Retry each through transient blips; if one still
        // fails, surface the partial set loudly for manual cleanup instead of
        // aborting opaquely mid-loop.
        for (const base of bases.slice(1)) {
            try { shRetry(`gh api -X PATCH repos/${ORG}/${base}-${poolid} -f name=${base}-${RUN_ID}`); }
            catch (e) {
                throw new Error(
                    `claim: pool set ${poolid} left HALF-RENAMED to ${RUN_ID} — ` +
                    `'${base}-${poolid}' did not rename after retries; some repos are ` +
                    `'<base>-${RUN_ID}' and the rest still '<base>-${poolid}'. ` +
                    `Manual cleanup needed. Cause: ${(e as Error).message}`,
                );
            }
        }
        console.log(`claimed pool set ${poolid} -> ${RUN_ID} (instant)`);
        return;
    }
    console.log("no pool set free — caller should clone inline");
    process.exit(3);
}

function refill(): void {
    const K = Number(process.env.FARM_POOL_SIZE ?? 3);
    let have = poolSets().length;
    console.log(`Pool refill: ${have}/${K} sets ready`);
    while (have < K) {
        const poolid = `pool-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
        console.log(`minting ${poolid} (${have + 1}/${K})…`);
        buildSet(poolid, loadPRs(false), `farm pool (pre-cloned, single-use)`);
        have = poolSets().length;
    }
    console.log("pool full.");
}

({ provision, destroy, claim, refill }[MODE])();

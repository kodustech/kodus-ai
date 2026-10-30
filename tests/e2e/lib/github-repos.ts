import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./git.js";
import { http } from "./http.js";
import { logger } from "./log.js";
import { invalidateRegisteredRepo } from "./onboarding.js";

const log = logger("gh-repos");
const API = "https://api.github.com";

// Throwaway GitHub repos for scenarios that need an EXCLUSIVE repo per run
// (cloud webhook→org resolution returns the first IntegrationConfig with an
// active code-review automation — webhook-context.service.ts — so a repo
// shared across throwaway orgs lets a stale org intercept the review).
//
// Mechanics mirror scripts/e2e/provision-cloud-github-repos.sh: create via
// the org endpoint (user fallback), then `git clone --bare` + `push --mirror`
// from the base fixture repo so ALL branch pairs (feature/add-stats,
// bug/missing-null-check, …) come along for openPRFromBranches.

// Repo CREATE/DELETE needs org Administration rights, which the regular
// fine-grained GH_TEST_TOKEN (scoped to kodus-e2e, All-repositories but no
// admin) typically lacks. GH_REPO_ADMIN_TOKEN(_2,_3…) are used ONLY here —
// for minting/mirroring/deleting the throwaway repo. Everything else
// (integration binding, listing, PRs, polling) keeps using GH_TEST_TOKEN,
// whose first org is kodus-e2e (that's what the Kodus integration binds to —
// github.service.ts picks orgs[0]). Falls back to GH_TEST_TOKEN when the
// admin var is absent (a single fully-privileged token also works).
//
// GitHub's primary rate limit is per ACCOUNT (5000 req/hr), not per token, so
// a single admin account doing every repo create/delete/mirror across the
// matrix exhausts it (the cloud-matrix github cells then 403 on
// "API rate limit exceeded for user ID …"). Round-robin across the pool of
// admin tokens (each a DIFFERENT account) so the heavy repo-admin traffic
// spreads over multiple per-account quotas. Both tokens must be distinct
// GitHub accounts that are members of the org with Administration + Contents
// write — a second PAT of the SAME account buys no extra quota.
const MAX_ADMIN_TOKENS = 5;
function adminTokenPool(): string[] {
    const pool: string[] = [];
    if (process.env.GH_REPO_ADMIN_TOKEN) pool.push(process.env.GH_REPO_ADMIN_TOKEN);
    for (let i = 2; i <= MAX_ADMIN_TOKENS; i++) {
        const v = process.env[`GH_REPO_ADMIN_TOKEN_${i}`];
        if (v) pool.push(v);
    }
    if (pool.length === 0 && process.env.GH_TEST_TOKEN) {
        pool.push(process.env.GH_TEST_TOKEN);
    }
    return [...new Set(pool.map((t) => t.trim()).filter(Boolean))];
}
let adminTokenIdx = 0;
function token(): string {
    const pool = adminTokenPool();
    if (!pool.length)
        throw new Error(
            "GH_REPO_ADMIN_TOKEN or GH_TEST_TOKEN is required for throwaway repos",
        );
    return pool[adminTokenIdx++ % pool.length];
}

function headers(tok?: string): Record<string, string> {
    return {
        Authorization: `Bearer ${tok ?? token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
}

/** Create `owner/name` (private) and mirror every ref from `baseRepo` into
 *  it. Returns the new full_name. */
export async function createThrowawayRepo(
    baseRepo: string,
    name: string,
): Promise<string> {
    const owner = baseRepo.split("/")[0];
    const full = `${owner}/${name}`;

    // Pick ONE admin token for this whole repo (create + mirror push) so the
    // push isn't attempted by a different account than the one that created
    // the repo. Rotation happens ACROSS repos — token() round-robins per call.
    const tok = token();
    log.info(`Creating throwaway repo ${full} (mirror of ${baseRepo})`);
    let resp = await http(`${API}/orgs/${owner}/repos`, {
        method: "POST",
        headers: headers(tok),
        body: {
            name,
            private: true,
            auto_init: false,
            has_issues: false,
            has_projects: false,
            has_wiki: false,
        },
        timeoutMs: 30_000,
    });
    if (resp.status === 404) {
        // Owner is the token's user, not an org.
        resp = await http(`${API}/user/repos`, {
            method: "POST",
            headers: headers(tok),
            body: { name, private: true, auto_init: false },
            timeoutMs: 30_000,
        });
    }
    if (resp.status !== 201) {
        const hint =
            resp.status === 403
                ? " — GH_TEST_TOKEN cannot create repos in the org. It needs repo-creation rights on kodus-e2e (classic PAT: `repo` scope + org membership allowing repo creation; fine-grained: org Administration/repo-create). Same requirement as scripts/e2e/provision-cloud-github-repos.sh."
                : "";
        throw new Error(
            `create repo ${full} failed (HTTP ${resp.status}): ${resp.raw.slice(0, 300)}${hint}`,
        );
    }

    const tmp = mkdtempSync(join(tmpdir(), "e2e-mirror-"));
    try {
        // Token deliberately NOT in the URL (and not in argv at all): run()
        // builds its error message from cmd+args, so an embedded credential
        // would land in plaintext in the test runner's logs on any git
        // failure (withRetry then prints it again). Inject the auth header
        // through git's env-based config instead — same mechanism
        // actions/checkout uses — which keeps both argv and error messages
        // secret-free. (A `-c http.extraHeader=Basic <base64>` arg would
        // only obfuscate: base64 decodes straight back to the token.)
        const src = `https://github.com/${baseRepo}.git`;
        const dst = `https://github.com/${full}.git`;
        const gitEnv = {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
                `x-access-token:${tok}`,
            ).toString("base64")}`,
        };
        // Transient local socket errors ("Recv failure: Can't assign
        // requested address") have been observed on the very first push to a
        // just-created repo — retry the network steps instead of leaking a
        // half-set-up repo.
        await withRetry("clone base", () =>
            run("git", ["clone", "--quiet", "--bare", src, "base.git"], {
                cwd: tmp,
                env: gitEnv,
                capture: true,
            }),
        );
        // --mirror also pushes hidden refs (refs/pull/*) which GitHub
        // rejects; push branches + tags explicitly instead.
        await withRetry("push branches", () =>
            run("git", ["push", "--quiet", dst, "refs/heads/*:refs/heads/*"], {
                cwd: join(tmp, "base.git"),
                env: gitEnv,
                capture: true,
            }),
        );
        await run(
            "git",
            ["push", "--quiet", dst, "refs/tags/*:refs/tags/*"],
            { cwd: join(tmp, "base.git"), env: gitEnv, capture: true },
        ).catch(() => undefined); // tags are optional fixture content
    } catch (err) {
        // Mirror failed after the repo was created — delete it (best-effort)
        // so a transient git failure doesn't leak an empty repo the next
        // run's name can't reuse anyway.
        await deleteRepo(full).catch(() => false);
        throw err;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    log.ok(`${full} ready (branches mirrored from ${baseRepo})`);
    return full;
}

async function withRetry<T>(
    label: string,
    fn: () => Promise<T>,
    attempts = 3,
): Promise<T> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < attempts) {
                log.info(
                    `${label} failed (attempt ${i}/${attempts}) — retrying in 5s: ${(err as Error).message.split("\n")[0]}`,
                );
                await new Promise((r) => setTimeout(r, 5_000));
            }
        }
    }
    throw lastErr;
}

/** Best-effort delete. Requires the PAT to carry `delete_repo`; a 403 is
 *  logged (repos accumulate until swept by hand) instead of failing the
 *  scenario — the assertion already passed by the time cleanup runs. */
export async function deleteRepo(full: string): Promise<boolean> {
    const resp = await http(`${API}/repos/${full}`, {
        method: "DELETE",
        headers: headers(),
        timeoutMs: 30_000,
    });
    // A recreation under the SAME name (deterministic per-run slug on
    // the scenario retry path) must re-register — the webhook died with
    // this repo. Without this, registerRepo's cache skips the POST and
    // the recreated repo never gets a webhook. Invalidate on 204 AND 404:
    // a 404 means the repo is already gone (e.g. a prior DELETE whose 204
    // was lost in transport and re-attempted), and the webhook with it.
    if (resp.status === 204 || resp.status === 404) {
        invalidateRegisteredRepo(full);
    }
    if (resp.status === 204) {
        log.ok(`Deleted throwaway repo ${full}`);
        return true;
    }
    log.info(
        `Could not delete ${full} (HTTP ${resp.status}) — likely the PAT lacks delete_repo; leaving it for the stale sweep`,
    );
    return false;
}

/** Sweep throwaway repos a crashed prior run leaked: every repo under
 *  `owner` whose name starts with `prefix` and was created more than
 *  `maxAgeHours` ago. Best-effort — failures only log. */
export async function sweepStaleThrowawayRepos(
    owner: string,
    prefix: string,
    maxAgeHours = 24,
): Promise<number> {
    const resp = await http<
        Array<{ full_name: string; name: string; created_at: string }>
    >(`${API}/orgs/${owner}/repos?per_page=100&sort=created&direction=asc`, {
        headers: headers(),
        timeoutMs: 30_000,
    });
    if (resp.status !== 200 || !Array.isArray(resp.body)) return 0;

    const cutoff = Date.now() - maxAgeHours * 3_600_000;
    let swept = 0;
    for (const repo of resp.body) {
        if (!repo.name.startsWith(prefix)) continue;
        if (new Date(repo.created_at).getTime() > cutoff) continue;
        if (await deleteRepo(repo.full_name)) swept++;
    }
    if (swept) log.ok(`Swept ${swept} stale ${prefix}* repo(s)`);
    return swept;
}

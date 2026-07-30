import { ensureOk, http } from "./http.js";
import { logger } from "./log.js";

const log = logger("gh-contents");

// Minimal GitHub contents/PR client used by the centralized-config scenario to
// drive the SOURCE repo's state from the test itself: seed files, update them,
// delete them, and land a change via a real merged PR (the production
// auto-sync trigger). Everything authenticates with GH_TEST_TOKEN — the same
// PAT the provider uses — so no extra credentials are involved.

const API = "https://api.github.com";

function headers(): Record<string, string> {
    const token = process.env.GH_TEST_TOKEN;
    if (!token) throw new Error("GH_TEST_TOKEN is required for gh-contents");
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
}

async function getFileSha(
    repo: string,
    path: string,
    ref?: string,
): Promise<string | undefined> {
    const resp = await http<{ sha?: string }>(
        `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
        { headers: headers(), timeoutMs: 20_000 },
    );
    if (resp.status === 404) return undefined;
    ensureOk(resp, `gh:getFileSha ${path}`);
    return resp.body.sha;
}

// Create or update a file on a branch (default branch when omitted).
// Idempotent across runs: looks up the current sha first so an existing file
// from a previous run is overwritten instead of erroring.
export async function ghPutFile(
    repo: string,
    path: string,
    content: string,
    message: string,
    branch?: string,
): Promise<void> {
    const sha = await getFileSha(repo, path, branch);
    const resp = await http(
        `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
        {
            method: "PUT",
            headers: headers(),
            body: {
                message,
                content: Buffer.from(content, "utf8").toString("base64"),
                ...(sha ? { sha } : {}),
                ...(branch ? { branch } : {}),
            },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, `gh:putFile ${path}`);
}

// Delete a file from the default branch. Missing file is a no-op so re-runs
// after a partial failure don't trip over their own cleanup.
export async function ghDeleteFile(
    repo: string,
    path: string,
    message: string,
): Promise<void> {
    const sha = await getFileSha(repo, path);
    if (!sha) {
        log.info(`ghDeleteFile: ${path} already absent — skipping`);
        return;
    }
    const resp = await http(
        `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
        {
            method: "DELETE",
            headers: headers(),
            body: { message, sha },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, `gh:deleteFile ${path}`);
}

// Land a set of file changes on the default branch THROUGH A MERGED PR —
// the path production uses to trigger centralized-config auto-sync
// (pull-request.closed + merged). Returns the PR number for evidence.
export async function ghMergeChange(
    repo: string,
    files: Array<{ path: string; content: string }>,
    title: string,
): Promise<{ prNumber: number; branch: string }> {
    const h = headers();
    // Resolve default branch HEAD.
    const repoResp = await http<{ default_branch: string }>(
        `${API}/repos/${repo}`,
        { headers: h, timeoutMs: 20_000 },
    );
    ensureOk(repoResp, "gh:repo");
    const base = repoResp.body.default_branch;
    const refResp = await http<{ object: { sha: string } }>(
        `${API}/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`,
        { headers: h, timeoutMs: 20_000 },
    );
    ensureOk(refResp, "gh:baseRef");

    const branch = `e2e/centralized-${Date.now().toString(36)}`;
    const createRef = await http(`${API}/repos/${repo}/git/refs`, {
        method: "POST",
        headers: h,
        body: { ref: `refs/heads/${branch}`, sha: refResp.body.object.sha },
        timeoutMs: 20_000,
    });
    ensureOk(createRef, "gh:createBranch");

    for (const f of files) {
        await ghPutFile(repo, f.path, f.content, `${title} (${f.path})`, branch);
    }

    const prResp = await http<{ number: number }>(
        `${API}/repos/${repo}/pulls`,
        {
            method: "POST",
            headers: h,
            body: {
                title,
                head: branch,
                base,
                body: "Automated by the centralized-config-sync E2E scenario; merged immediately to exercise the auto-sync-on-merge trigger.",
            },
            timeoutMs: 30_000,
        },
    );
    ensureOk(prResp, "gh:openPR");
    const prNumber = prResp.body.number;

    const mergeResp = await http(
        `${API}/repos/${repo}/pulls/${prNumber}/merge`,
        {
            method: "PUT",
            headers: h,
            body: { merge_method: "squash" },
            timeoutMs: 30_000,
        },
    );
    ensureOk(mergeResp, "gh:mergePR");

    // Branch is disposable — delete best-effort.
    try {
        await http(
            `${API}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
            { method: "DELETE", headers: h, timeoutMs: 15_000 },
        );
    } catch {
        /* best effort */
    }
    return { prNumber, branch };
}

// Close a PR (used for the init(syncOption=pr) coverage — Kodus opens a real
// initialization PR on the source repo; the scenario closes it after
// asserting it exists).
export async function ghClosePR(repo: string, prNumber: number): Promise<void> {
    const resp = await http(`${API}/repos/${repo}/pulls/${prNumber}`, {
        method: "PATCH",
        headers: headers(),
        body: { state: "closed" },
        timeoutMs: 20_000,
    });
    ensureOk(resp, `gh:closePR #${prNumber}`);
}

// Read-your-writes guards: the contents API is usually consistent, but the
// tree/ref reads Kodus's sync performs can briefly lag a burst of PUTs. Wait
// until the file is visible (and carries the expected content) before asking
// Kodus to sync, so a stale tree never produces a phantom assertion failure.
export async function ghWaitFileContains(
    repo: string,
    path: string,
    needle: string,
    timeoutSec = 30,
): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        const resp = await http<{ content?: string }>(
            `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
            { headers: headers(), timeoutMs: 20_000 },
        );
        if (resp.status === 200 && resp.body.content) {
            const text = Buffer.from(resp.body.content, "base64").toString(
                "utf8",
            );
            if (text.includes(needle)) return;
        }
        await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(
        `ghWaitFileContains: ${repo}/${path} did not show expected content within ${timeoutSec}s`,
    );
}

export async function ghWaitFileGone(
    repo: string,
    path: string,
    timeoutSec = 30,
): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        const sha = await getFileSha(repo, path);
        if (!sha) return;
        await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(
        `ghWaitFileGone: ${repo}/${path} still present after ${timeoutSec}s`,
    );
}

// Newest-first list of open PRs. Used to locate the PR Kodus itself opened
// (PENDING rule-mutation flow / init-pr) without depending on its branch
// naming convention.
export async function ghListOpenPRs(
    repo: string,
): Promise<Array<{ number: number; title: string; head: string }>> {
    const resp = await http<
        Array<{ number: number; title: string; head: { ref: string } }>
    >(`${API}/repos/${repo}/pulls?state=open&sort=created&direction=desc`, {
        headers: headers(),
        timeoutMs: 20_000,
    });
    ensureOk(resp, "gh:listOpenPRs");
    return resp.body.map((p) => ({
        number: p.number,
        title: p.title,
        head: p.head.ref,
    }));
}

// Merge an EXISTING PR by number (ghMergeChange merges only the PR it
// created). Used to land the PRs Kodus opens for pending rule mutations.
export async function ghMergePRNumber(
    repo: string,
    prNumber: number,
): Promise<void> {
    const resp = await http(
        `${API}/repos/${repo}/pulls/${prNumber}/merge`,
        {
            method: "PUT",
            headers: headers(),
            body: { merge_method: "squash" },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, `gh:mergePR #${prNumber}`);
}

export async function ghGetPRState(
    repo: string,
    prNumber: number,
): Promise<string> {
    const resp = await http<{ state: string }>(
        `${API}/repos/${repo}/pulls/${prNumber}`,
        { headers: headers(), timeoutMs: 20_000 },
    );
    ensureOk(resp, `gh:getPR #${prNumber}`);
    return resp.body.state;
}

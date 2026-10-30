/**
 * GitHub App installation tokens for the e2e harness.
 *
 * WHY: the bot PATs (`kodus-e2e-bot-*`) are abuse-flagged by GitHub down to
 * ~60 req/h (healthy accounts get 5000/h), which is the root cause of the
 * quota SKIPs on GitHub cells. A GitHub App's installation token carries its
 * OWN 5000/h budget (scales with repo count), is not subject to the
 * new-account abuse heuristics, and rotates automatically — no more
 * bot-account treadmill.
 *
 * OPT-IN: only used when all three envs are set. Fully absent → the PAT
 * pool (GH_TEST_TOKENS / GH_TEST_TOKEN[_N]) keeps working unchanged.
 *
 *   GH_APP_ID               — the App's numeric id
 *   GH_APP_PRIVATE_KEY      — PEM private key (literal \n sequences OK)
 *   GH_APP_INSTALLATION_ID  — installation id on the kodus-e2e org
 *
 * KNOWN BEHAVIORAL DIFFERENCES (validate before flipping CI to App auth):
 *   - `GET /user` does not work with installation tokens, so
 *     `provider.currentUserId()` fails → self-hosted seat assignment
 *     (ensureLicenseSeat) and per-seat-license-toggle need the PAT path.
 *     The runner therefore prefers the App token ONLY for cloud cells.
 *   - PRs/comments created with the token are authored by `<app-slug>[bot]`,
 *     not a bot user account. Kodus's isKodyComment matches "kody"/"kodus"
 *     logins — an app slug containing those words would make Kody ignore
 *     the harness's own comments. Name the App accordingly (e.g. `e2e-qa-ci`).
 *
 * Tokens live ~1h; we re-mint when less than REFRESH_MARGIN_MS of validity
 * remains, so a matrix run of any length stays authenticated (the runner asks
 * per scenario).
 */
import { createSign } from "node:crypto";
import { http, ensureOk } from "./http.js";
import { logger } from "./log.js";

const log = logger("github-app");

const API = "https://api.github.com";

/**
 * Must exceed the LONGEST single scenario, not just "some slack".
 *
 * The runner resolves the token once per scenario, so a token handed out with
 * `margin - 1ms` of validity has to survive that whole scenario. Scenarios
 * poll for a review that may never come and only give up at their own timeout:
 * command-review waits 1502s and license-attribution 900s — both longer than
 * the old 10min margin. When a review failed to arrive, the token then died
 * mid-poll and the scenario reported `HTTP 401` from GitHub instead of the
 * real "no review arrived" cause, sending debugging after a credential bug
 * that did not exist (QA matrix, 2026-07-14).
 *
 * 30min: comfortably past the 25min worst case while still using each token
 * for at most half its life.
 */
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

interface CachedToken {
    token: string;
    expiresAtMs: number;
}

// Keyed by (apiBase, app id, installation id) so distinct configurations —
// different mock servers in tests, or a future GHES target — never receive
// a token minted for another API/identity.
const cache = new Map<string, CachedToken>();

function b64url(input: Buffer | string): string {
    return Buffer.from(input)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

// App JWT (RS256, 9min TTL) — the credential that authenticates the mint
// call itself. iat is backdated 60s per GitHub's clock-drift guidance.
// `iss` stays a STRING on purpose: GitHub accepts both string and numeric
// App IDs (validated live 2026-07-08 against api.github.com), and the
// now-recommended alternative — the App's Client ID ("Iv23...") — is only
// expressible as a string. Do not parseInt this; it would NaN client IDs.
function mintAppJwt(appId: string, privateKeyPem: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(
        JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer
        .sign(privateKeyPem)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `${header}.${payload}.${signature}`;
}

export function githubAppConfigured(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return Boolean(
        env.GH_APP_ID && env.GH_APP_PRIVATE_KEY && env.GH_APP_INSTALLATION_ID,
    );
}

/** Test hook: drop cached tokens so expiry/re-mint paths are exercisable. */
export function resetGithubAppTokenCache(): void {
    cache.clear();
}

/**
 * Returns a valid installation token, or undefined when the App envs are
 * not configured. Throws when configured but the mint fails (bad key,
 * revoked installation) — a half-configured App should fail loudly, not
 * silently fall back and mask the misconfiguration.
 */
export async function githubAppToken(
    env: NodeJS.ProcessEnv = process.env,
    apiBase: string = API,
): Promise<string | undefined> {
    if (!githubAppConfigured(env)) return undefined;
    const cacheKey = `${apiBase}:${env.GH_APP_ID}:${env.GH_APP_INSTALLATION_ID}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
        return cached.token;
    }
    // Secrets often carry the PEM with literal \n sequences — normalize.
    const pem = env.GH_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");
    const jwt = mintAppJwt(env.GH_APP_ID!, pem);
    const resp = await http<{ token: string; expires_at: string }>(
        `${apiBase}/app/installations/${env.GH_APP_INSTALLATION_ID}/access_tokens`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, "github-app:mintInstallationToken");
    const expiresAtMs = Date.parse(resp.body.expires_at);
    cache.set(cacheKey, {
        token: resp.body.token,
        expiresAtMs: Number.isFinite(expiresAtMs)
            ? expiresAtMs
            : Date.now() + 55 * 60 * 1000,
    });
    log.info(
        `Minted GitHub App installation token (expires ${resp.body.expires_at})`,
    );
    return resp.body.token;
}

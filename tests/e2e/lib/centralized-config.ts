import { ensureOk, http } from "./http.js";
import { logger } from "./log.js";
import type { KodusSession, ProviderRepoRef, TargetContext } from "./types.js";

const log = logger("centralized-config");

// Thin client over the team-key-authenticated Centralized Config CLI API
// (apps/api/src/controllers/cli/cli-centralized-config.controller.ts) plus the
// two JWT-authenticated helpers the scenario needs to bootstrap: minting a
// team CLI key with the config:repo:manage capability, and selecting the
// source repo so `init` can resolve it.

// Must match TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE
// (libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface.ts).
const CONFIG_REPO_MANAGE = "config:repo:manage";

export interface CentralizedStatus {
    enabled: boolean;
    repository: { id: string; name: string } | null;
}

// QA (and any deploy behind the response interceptor) wraps payloads in
// `{ data: ..., statusCode, type }`; a bare local API may not. Accept both.
function unwrap<T>(body: unknown): T {
    const b = body as { data?: T } | T;
    return ((b as { data?: T })?.data ?? b) as T;
}

// The QA proxy intermittently answers 502/503/504/408/524 while the upstream
// is still fine (same class onboarding.ts's PROXY_PENDING_STATUSES handles).
// All centralized-config mutations are idempotent or guarded server-side
// (init refuses when already enabled, sync re-reads the repo, disable/key
// mint are safe), so one retry after a short pause removes that whole flake
// class without masking real failures.
const PROXY_TRANSIENT = new Set([502, 503, 504, 408, 524]);

export async function httpRetryTransient<T = unknown>(
    url: string,
    opts: Parameters<typeof http>[1],
): Promise<Awaited<ReturnType<typeof http<T>>>> {
    const first = await http<T>(url, opts);
    if (!PROXY_TRANSIENT.has(first.status)) return first;
    log.info(
        `transient HTTP ${first.status} from ${url.split("?")[0]} — retrying once in 5s`,
    );
    await new Promise((r) => setTimeout(r, 5_000));
    return http<T>(url, opts);
}

// Mint a team CLI key with the config:repo:manage capability. The signup user
// is OWNER of their org, which is exactly the role POST /teams/:teamId/cli-keys
// requires (PolicyGuard checkRole OWNER). Returns the raw `kodus_…` secret —
// shown only once by the API, so the caller keeps it for the run.
export async function mintTeamKey(
    target: TargetContext,
    session: KodusSession,
    name: string,
): Promise<string> {
    const resp = await httpRetryTransient<{ key?: string }>(
        `${target.apiBaseUrl}/teams/${encodeURIComponent(session.teamId)}/cli-keys`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                name,
                config: { capabilities: [CONFIG_REPO_MANAGE] },
            },
            timeoutMs: 20_000,
        },
    );
    ensureOk(resp, "centralized:mintTeamKey");
    const key = unwrap<{ key?: string }>(resp.body).key;
    if (!key || !key.startsWith("kodus_")) {
        // Deliberately do NOT echo the response body here — on the happy
        // path it contains the freshly minted secret.
        throw new Error(
            `mintTeamKey: HTTP ${resp.status} response did not include a kodus_ key`,
        );
    }
    return key;
}

// Best-effort revoke of a previously minted key. Cleanup only — failures are
// swallowed so a teardown hiccup never masks the scenario's real outcome. The
// key id (uuid) is resolved by listing the team's keys and matching by name.
export async function revokeTeamKeyByName(
    target: TargetContext,
    session: KodusSession,
    name: string,
): Promise<void> {
    try {
        const list = await http<
            Array<{ uuid: string; name: string }>
        >(`${target.apiBaseUrl}/teams/${encodeURIComponent(session.teamId)}/cli-keys`, {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 15_000,
        });
        const entries = unwrap<Array<{ uuid: string; name: string }>>(
            list.body,
        );
        const key = (Array.isArray(entries) ? entries : []).find(
            (k) => k.name === name,
        );
        if (!key) return;
        await http(
            `${target.apiBaseUrl}/teams/${encodeURIComponent(session.teamId)}/cli-keys/${encodeURIComponent(key.uuid)}`,
            {
                method: "DELETE",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                timeoutMs: 15_000,
            },
        );
    } catch (err) {
        log.info(`revokeTeamKeyByName: ${(err as Error).message} (best-effort)`);
    }
}

// Select a repo by `owner/name` so `init` can resolve it as the centralized
// config source. Mirrors onboarding.registerRepo's list→replace flow, but
// targets an arbitrary repo instead of the provider's review-fixture repo.
// Safe to `replace` the selected set here because the scenario runs on a
// throwaway org whose only purpose is this test.
export async function selectRepoByFullName(
    target: TargetContext,
    session: KodusSession,
    fullName: string,
): Promise<ProviderRepoRef> {
    const listResp = await http<{
        data: Array<{
            id: string | number;
            full_name?: string;
            name?: string;
            organizationName?: string;
        }>;
    }>(
        `${target.apiBaseUrl}/code-management/repositories/org?teamId=${encodeURIComponent(session.teamId)}`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 30_000,
        },
    );
    ensureOk(listResp, "centralized:listRepos");
    const found =
        listResp.body.data?.find((r) => r.full_name === fullName) ??
        listResp.body.data?.find(
            (r) =>
                r.organizationName != null &&
                r.name != null &&
                `${r.organizationName}/${r.name}` === fullName,
        );
    if (!found) {
        throw new Error(
            `Centralized config repo ${fullName} not in integration's available list ` +
                `(${listResp.body.data?.length ?? 0} entries). Is it the right owner/name and ` +
                `is the PAT scoped to it?`,
        );
    }
    const registerResp = await http<{ data: { status: boolean } }>(
        `${target.apiBaseUrl}/code-management/repositories`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: { teamId: session.teamId, type: "replace", repositories: [found] },
            timeoutMs: 30_000,
        },
    );
    ensureOk(registerResp, "centralized:selectRepo");
    return {
        id: found.id,
        name: found.name ?? fullName.split("/").pop(),
        full_name: found.full_name ?? fullName,
    };
}

function teamKeyHeaders(teamKey: string): Record<string, string> {
    return { "x-team-key": teamKey };
}

export async function getStatus(
    target: TargetContext,
    teamKey: string,
): Promise<CentralizedStatus> {
    const resp = await httpRetryTransient<CentralizedStatus>(
        `${target.apiBaseUrl}/cli/config/centralized/status`,
        { headers: teamKeyHeaders(teamKey), timeoutMs: 20_000 },
    );
    ensureOk(resp, "centralized:status");
    return unwrap<CentralizedStatus>(resp.body);
}

export async function init(
    target: TargetContext,
    teamKey: string,
    repositoryId: string,
    syncOption: "pr" | "manual" = "manual",
): Promise<{ success: boolean; message: string; prUrl?: string }> {
    const resp = await httpRetryTransient<{ success: boolean; message: string; prUrl?: string }>(
        `${target.apiBaseUrl}/cli/config/centralized/init`,
        {
            method: "POST",
            headers: teamKeyHeaders(teamKey),
            body: { repositoryId, syncOption },
            timeoutMs: 60_000,
        },
    );
    ensureOk(resp, "centralized:init");
    return unwrap<{ success: boolean; message: string; prUrl?: string }>(resp.body);
}

export async function sync(
    target: TargetContext,
    teamKey: string,
): Promise<{ success: boolean; message: string }> {
    const resp = await httpRetryTransient<{ success: boolean; message: string }>(
        `${target.apiBaseUrl}/cli/config/centralized/sync`,
        {
            method: "POST",
            headers: teamKeyHeaders(teamKey),
            // Sync reads the centralized repo's default branch and writes
            // every discovered scope to DB params — give it room under load.
            timeoutMs: 120_000,
        },
    );
    ensureOk(resp, "centralized:sync");
    return unwrap<{ success: boolean; message: string }>(resp.body);
}

export async function disable(
    target: TargetContext,
    teamKey: string,
): Promise<{ success: boolean; message: string }> {
    const resp = await httpRetryTransient<{ success: boolean; message: string }>(
        `${target.apiBaseUrl}/cli/config/centralized/disable`,
        {
            method: "POST",
            headers: teamKeyHeaders(teamKey),
            timeoutMs: 20_000,
        },
    );
    ensureOk(resp, "centralized:disable");
    return unwrap<{ success: boolean; message: string }>(resp.body);
}

// Recursively search any JSON node for a string value that contains `needle`.
// Used to assert "the sentinel from kodus-config.yml landed in the synced
// code_review_config parameter" without hard-coding the param's nested shape
// (which differs across global/repo/directory scopes).
export function deepIncludesString(node: unknown, needle: string): boolean {
    if (typeof node === "string") return node.includes(needle);
    if (Array.isArray(node)) {
        return node.some((n) => deepIncludesString(n, needle));
    }
    if (node && typeof node === "object") {
        return Object.values(node as Record<string, unknown>).some((v) =>
            deepIncludesString(v, needle),
        );
    }
    return false;
}

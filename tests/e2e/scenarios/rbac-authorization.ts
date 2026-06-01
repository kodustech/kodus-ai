import { http } from "../lib/http.js";
import { login, signUp } from "../lib/onboarding.js";
import type { RunContext, Scenario, TargetContext } from "../lib/types.js";

// ---------------------------------------------------------------------------
// RBAC authorization matrix (full-stack).
//
// Runs against a real, provisioned target (cloud QA or self-hosted VM),
// exercising the COMPLETE request path: JwtAuthGuard → PolicyGuard →
// PermissionsAbilityFactory + the global transform/exception layers. This is
// the only place the real JWT auth + RBAC are validated together over HTTP.
//
// Isolation: the scenario signs up its OWN throwaway org (the signup creator is
// OWNER + ACTIVE even in cloud mode), so every write here — including the
// destructive BYOK delete — is contained in a disposable org and cannot affect
// anyone else's tenant.
//
// Flow:
//   1. Sign up a fresh owner (new org).
//   2. Invite one user per non-owner role, activate it, log in.
//   3. For each (endpoint, role): allowed role → NOT 401/403; denied role → 403.
//
// The provisioning endpoints below were validated live against QA on
// 2026-05-27 (see provisionUserWithRole). The expected CASES matrix reflects
// the FIXED backend (this branch): running it against a target on older code
// will surface the pre-fix bugs (e.g. contributor getting 200 on TokenUsage).
// ---------------------------------------------------------------------------

const PASSWORD = "E2eRbac!2026x";

type RbacRole = "owner" | "billing_manager" | "repo_admin" | "contributor";

type Case = {
    name: string;
    method: "get" | "post" | "delete" | "patch";
    path: string;
    body?: unknown;
    allowed: RbacRole[];
};

// Expected allow-list per endpoint, derived from ROLE_POLICIES
// (libs/identity/domain/permissions/policies/role-policies.ts).
const CASES: Case[] = [
    {
        name: "TokenUsage read",
        method: "get",
        path: "/usage/tokens/summary?startDate=2026-01-01&endDate=2026-01-31&byok=false",
        allowed: ["owner", "billing_manager", "repo_admin"],
    },
    {
        // Bug A: was reachable by anyone authenticated.
        name: "BYOK delete (OrganizationSettings)",
        method: "delete",
        path: "/organization-parameters/delete-byok-config?configType=main",
        allowed: ["owner"],
    },
    // NOTE: Cockpit analytics is intentionally NOT covered here. This scenario
    // signs up a fresh (free-tier) org, so CockpitTierGuard 403s everyone
    // regardless of role and would confound the allow assertions. Cockpit's
    // RBAC is covered by authorization-matrix.spec.ts (jest).
    {
        name: "CLI review read",
        method: "get",
        path: "/cli-reviews/executions",
        allowed: ["owner", "repo_admin", "contributor"],
    },
    {
        name: "Issues read",
        method: "get",
        path: "/issues",
        allowed: ["owner", "repo_admin", "contributor"],
    },
];

type RoleSession = { role: RbacRole; accessToken: string };

const jwtPayload = (jwt: string): Record<string, unknown> => {
    try {
        return JSON.parse(
            Buffer.from(jwt.split(".")[1], "base64").toString("utf8"),
        );
    } catch {
        return {};
    }
};

/**
 * Invite a user with a specific RBAC role into the owner's team, activate the
 * invitation (sets a password), and return an authenticated session.
 *
 * Validated end-to-end against a local instance of THIS branch on 2026-05-27
 * (16/16 matrix cells green):
 *   - POST /team-members invites the user (joiners default to CONTRIBUTOR).
 *   - GET  /team-members?teamId= returns `{ data: { members: [...] } }`; match
 *     by email and use the member's `userId`.
 *   - POST /user/invite/complete-invitation { uuid: userId, name, password }
 *     activates the user (path is `/user`, singular).
 *   - PATCH /user/:userId { role } sets the actual RBAC role — REQUIRED; the
 *     `role` field on the invite does NOT stick (everyone lands as contributor
 *     without this).
 */
async function provisionUserWithRole(
    ctx: RunContext,
    target: TargetContext,
    ownerToken: string,
    teamId: string,
    role: RbacRole,
): Promise<RoleSession> {
    const email = `e2e-rbac-${role}-${Date.now()}@kodus.local`;
    const name = `e2e ${role}`;
    const authed = { Authorization: `Bearer ${ownerToken}` };

    const invite = await http(`${target.apiBaseUrl}/team-members`, {
        method: "POST",
        headers: authed,
        body: {
            teamId,
            members: [
                {
                    email,
                    name,
                    role,
                    teamRole: "team_member",
                    active: true,
                    communicationId: email,
                },
            ],
        },
        timeoutMs: 30_000,
    });
    if (invite.status < 200 || invite.status >= 300) {
        ctx.skip(
            `provisioning: invite ${role} failed (HTTP ${invite.status}): ${invite.raw.slice(0, 250)}`,
        );
    }

    const list = await http<{
        data: { members: Array<{ email: string; userId: string }> };
    }>(`${target.apiBaseUrl}/team-members?teamId=${teamId}`, {
        method: "GET",
        headers: authed,
        timeoutMs: 20_000,
    });
    const userId = list.body?.data?.members?.find((m) => m.email === email)
        ?.userId;
    ctx.assert(
        userId,
        `provisioning: no userId for ${email}. Members: ${list.raw.slice(0, 250)}`,
    );

    const complete = await http(
        `${target.apiBaseUrl}/user/invite/complete-invitation`,
        {
            method: "POST",
            body: { uuid: userId, name, password: PASSWORD },
            timeoutMs: 20_000,
        },
    );
    if (complete.status < 200 || complete.status >= 300) {
        ctx.skip(
            `provisioning: complete-invitation ${role} failed (HTTP ${complete.status}): ${complete.raw.slice(0, 250)}`,
        );
    }

    // The invite lands the user as contributor; set the real RBAC role.
    const patch = await http(`${target.apiBaseUrl}/user/${userId}`, {
        method: "PATCH",
        headers: authed,
        body: { role },
        timeoutMs: 20_000,
    });
    if (patch.status < 200 || patch.status >= 300) {
        ctx.skip(
            `provisioning: set role ${role} failed (HTTP ${patch.status}): ${patch.raw.slice(0, 250)}`,
        );
    }

    const session = await login(target, { email, password: PASSWORD });
    return { role, accessToken: session.accessToken };
}

export const rbacAuthorization: Scenario = {
    id: "rbac-authorization",
    title: "RBAC: each role gets the expected 200 vs 403 across API endpoints",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"], // RBAC is provider-agnostic; one provider suffices
        license: ["paid", "license-paid"],
    },
    timeoutSec: 300,
    async run(ctx: RunContext) {
        // Fresh, disposable org — the signup creator is OWNER + ACTIVE.
        const ownerEmail = `e2e-rbac-owner-${Date.now()}@kodus.local`;
        await signUp(ctx.target, { email: ownerEmail, password: PASSWORD });
        const owner = await login(ctx.target, {
            email: ownerEmail,
            password: PASSWORD,
        });

        const teamRes = await http<{ data: Array<{ uuid: string }> }>(
            `${ctx.target.apiBaseUrl}/team`,
            {
                method: "GET",
                headers: { Authorization: `Bearer ${owner.accessToken}` },
                timeoutMs: 20_000,
            },
        );
        const teamId = teamRes.body?.data?.[0]?.uuid;
        ctx.assert(teamId, `could not resolve owner teamId: ${teamRes.raw.slice(0, 200)}`);

        const orgId =
            owner.organizationId ??
            (jwtPayload(owner.accessToken).organizationId as string);

        const sessions: RoleSession[] = [
            { role: "owner", accessToken: owner.accessToken },
        ];
        for (const role of [
            "billing_manager",
            "repo_admin",
            "contributor",
        ] as RbacRole[]) {
            sessions.push(
                await provisionUserWithRole(
                    ctx,
                    ctx.target,
                    owner.accessToken,
                    teamId,
                    role,
                ),
            );
        }

        const evidence: Record<string, Record<string, number>> = {};

        for (const testCase of CASES) {
            const path = testCase.path.replace("__ORG__", orgId ?? "");
            const row: Record<string, number> = {};

            for (const s of sessions) {
                const res = await http(`${ctx.target.apiBaseUrl}${path}`, {
                    method: testCase.method.toUpperCase() as
                        | "GET"
                        | "POST"
                        | "DELETE"
                        | "PATCH",
                    headers: { Authorization: `Bearer ${s.accessToken}` },
                    body: testCase.body,
                    timeoutMs: 20_000,
                });
                row[s.role] = res.status;

                const shouldAllow = testCase.allowed.includes(s.role);
                if (shouldAllow) {
                    ctx.assert(
                        res.status !== 401 && res.status !== 403,
                        `${s.role} should access "${testCase.name}" but got HTTP ${res.status}: ${res.raw.slice(0, 200)}`,
                    );
                } else {
                    ctx.assert(
                        res.status === 403,
                        `${s.role} must be forbidden on "${testCase.name}" (expected 403) but got HTTP ${res.status}: ${res.raw.slice(0, 200)}`,
                    );
                }
            }
            evidence[testCase.name] = row;
        }

        return { org: orgId, matrix: evidence };
    },
};

export default rbacAuthorization;

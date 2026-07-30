import { http } from "./http.js";
import { login, signUp } from "./onboarding.js";
import type { RunContext, TargetContext } from "./types.js";

// Shared RBAC provisioning used by both the backend (rbac-authorization) and
// frontend (rbac-frontend-routes) e2e scenarios: sign up a fresh throwaway org
// (the creator is OWNER + ACTIVE) and invite one ACTIVE user per non-owner role
// with the real RBAC role set. Same throwaway password for every test user so
// the frontend scenario can also sign them in through next-auth.

export const RBAC_PASSWORD = "E2eRbac!2026x";

export type RbacRole =
    | "owner"
    | "billing_manager"
    | "repo_admin"
    | "contributor";

export const NON_OWNER_ROLES: RbacRole[] = [
    "billing_manager",
    "repo_admin",
    "contributor",
];

export interface RoleSession {
    role: RbacRole;
    accessToken: string;
    email: string;
}

/**
 * Invite a user with a specific RBAC role into the owner's team, activate it,
 * and return an authenticated session. (Mechanics validated end-to-end against
 * QA on 2026-05-27.)
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
            body: { uuid: userId, name, password: RBAC_PASSWORD },
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

    const session = await login(target, { email, password: RBAC_PASSWORD });
    return { role, accessToken: session.accessToken, email };
}

export interface RbacOrg {
    ownerEmail: string;
    teamId: string;
    sessions: RoleSession[]; // owner + the three non-owner roles
}

/** Sign up a fresh disposable org and provision all four role sessions. */
export async function setupRbacOrg(ctx: RunContext): Promise<RbacOrg> {
    const ownerEmail = `e2e-rbac-owner-${Date.now()}@kodus.local`;
    await signUp(ctx.target, { email: ownerEmail, password: RBAC_PASSWORD });
    const owner = await login(ctx.target, {
        email: ownerEmail,
        password: RBAC_PASSWORD,
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
    ctx.assert(
        teamId,
        `could not resolve owner teamId: ${teamRes.raw.slice(0, 200)}`,
    );

    const sessions: RoleSession[] = [
        { role: "owner", accessToken: owner.accessToken, email: ownerEmail },
    ];
    for (const role of NON_OWNER_ROLES) {
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
    return { ownerEmail, teamId, sessions };
}

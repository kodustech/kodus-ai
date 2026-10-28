/**
 * Seeds a preview environment with something worth opening.
 *
 * A fresh stack boots on an empty database, so the preview URL lands on a
 * signup screen and every reviewer has to onboard an organization by hand
 * before they can look at the change. This creates that organization once, via
 * the product's own signup endpoint — going through the real onboarding path
 * instead of hand-written INSERTs that drift from it every release.
 *
 * Runs on the preview VM (from `data.seed` in .kodus/workspace.preview.yaml),
 * against the stack's own API. Idempotent: a second run logs in instead.
 *
 * Signing up is not enough to make the environment reviewable. A fresh
 * organization starts mid-onboarding, and the wizard's "Connect your Git tool"
 * step has no skip: a reviewer who opens the preview to look at a UI change is
 * trapped there, and going straight to an app route bounces back. A preview
 * has no git provider to connect and neutralized secrets, so nobody can finish
 * it. The seed marks onboarding done for the same reason it signs up at all —
 * the reviewer should land on the change, not on setup.
 *
 * Credentials come from the environment; without PREVIEW_SEED_PASSWORD the
 * script does nothing, so a developer running the preview recipe by hand never
 * gets a login with a password that is public knowledge. The password must
 * satisfy the product's own policy (8+ chars, upper, lower, number, symbol) —
 * signup rejects anything weaker.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';

const API = (
    process.env.PREVIEW_SEED_API_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');
const EMAIL = process.env.PREVIEW_SEED_EMAIL ?? 'preview@kodus.io';
const PASSWORD = process.env.PREVIEW_SEED_PASSWORD ?? '';
const NAME = process.env.PREVIEW_SEED_NAME ?? 'Preview';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForApi(timeoutSec = 300): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000;
    let lastError = '';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${API}/health/simple`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) return;
            lastError = `HTTP ${res.status}`;
        } catch (e: any) {
            lastError = e?.message ?? String(e);
        }
        await sleep(3000);
    }
    throw new Error(`API at ${API} never became healthy (${lastError})`);
}

async function login(): Promise<string | null> {
    const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
        data?: { accessToken?: string };
        accessToken?: string;
    };
    return body.data?.accessToken ?? body.accessToken ?? null;
}

/**
 * Flip `platform_configs.finishOnboard`, which is the flag the app layout
 * checks before it lets anyone past /setup. Done through the product's own
 * parameter endpoint, reading the current value first so nothing else in the
 * blob is dropped. Best-effort: a preview that seeded a login is still worth
 * more than one that failed to deploy over this.
 */
async function finishOnboarding(token: string): Promise<string | null> {
    const auth = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    };

    const teamRes = await fetch(`${API}/team`, { headers: auth });
    if (!teamRes.ok) throw new Error(`GET /team → HTTP ${teamRes.status}`);
    const teamBody = (await teamRes.json()) as any;
    const teams = teamBody?.data ?? teamBody;
    const teamId = Array.isArray(teams) ? teams[0]?.uuid : teams?.uuid;
    if (!teamId) throw new Error('no team on the seeded organization');

    const current = await fetch(
        `${API}/parameters/find-by-key?key=platform_configs&teamId=${teamId}`,
        { headers: auth },
    )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const configValue =
        (current as any)?.data?.configValue ??
        (current as any)?.configValue ??
        {};

    if (configValue.finishOnboard === true) {
        console.log('seed:preview: onboarding already finished');
        return teamId;
    }

    const res = await fetch(`${API}/parameters/create-or-update`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
            key: 'platform_configs',
            configValue: { ...configValue, finishOnboard: true },
            organizationAndTeamData: { teamId },
        }),
    });
    if (!res.ok) {
        throw new Error(
            `POST /parameters/create-or-update → HTTP ${res.status} ${(
                await res.text().catch(() => '')
            ).slice(0, 200)}`,
        );
    }
    console.log('seed:preview: onboarding marked finished');
    return teamId;
}

/**
 * Activate the seeded team.
 *
 * The app layout redirects to /setup unless the organization has an ACTIVE
 * team, and that check runs BEFORE the finishOnboard one — so marking
 * onboarding done is not enough on its own. Nothing activates a team except
 * `create-repositories`, which needs a connected git provider and a chosen
 * repository; there is no route for it, and a preview has no provider to
 * connect. So this is SQL, on purpose: it is the only path, it runs on the
 * VM against the environment's own throwaway database, and it reads the
 * credentials from the container's environment instead of hardcoding them.
 */
function activateTeam(teamId: string): void {
    const sql = `update teams set status = 'active' where uuid = '${teamId}' and status <> 'active'`;
    const out = execFileSync(
        'docker',
        [
            'exec',
            'db_postgres',
            'sh',
            '-c',
            `PGPASSWORD=$POSTGRES_PASSWORD psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${sql}"`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(
        `seed:preview: team activated (${out.trim().split('\n').pop()})`,
    );
}

/** Give the preview's Teams trial its normal minimum of five review seats. */
function ensurePreviewTrialSeats(organizationId: string, teamId: string): void {
    const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(organizationId) || !uuid.test(teamId)) {
        throw new Error('preview trial identifiers must be UUIDs');
    }

    // Billing creates a Teams trial with totalLicenses=0. That lets the
    // first PR through as a freebie but skips later PRs by the same author,
    // making approval QA look broken. Touch only this seeded trial; a paid
    // subscription keeps its Stripe-managed seat quantity.
    const sql = `update billing.organization_licenses set "totalLicenses" = greatest("totalLicenses", 5) where "organizationId" = '${organizationId}' and "teamId" = '${teamId}' and "subscriptionStatus" = 'trial' and "stripeSubscriptionId" is null and "trialEnd" > now()`;
    const out = execFileSync(
        'docker',
        [
            'exec',
            '-i',
            'db_postgres',
            'sh',
            '-c',
            'PGPASSWORD=$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
        ],
        { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(
        `seed:preview: Teams trial seats ready (${out.trim().split('\n').pop()})`,
    );
}

/** The preview skips the browser onboarding step that normally creates a trial. */
async function startPreviewTrial(token: string, teamId: string): Promise<void> {
    const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { organizationId?: string };
    if (!payload.organizationId) {
        throw new Error('preview token has no organizationId');
    }

    // Billing is only present in the cloud shape. The first seed may run
    // before its container is ready; up-profile runs this seed again after
    // readiness checks, so leave that first attempt non-fatal.
    const billing = await fetch('http://127.0.0.1:3992/api/billing/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            organizationId: payload.organizationId,
            teamId,
            byok: false,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (billing.ok || billing.status === 409) {
        ensurePreviewTrialSeats(payload.organizationId, teamId);
        console.log('seed:preview: billing trial available');
        return;
    }
    throw new Error(`billing trial returned HTTP ${billing.status}`);
}

async function main(): Promise<void> {
    if (!PASSWORD) {
        console.log(
            'seed:preview: PREVIEW_SEED_PASSWORD not set — skipping (no login will exist on this environment)',
        );
        return;
    }

    await waitForApi();

    const res = await fetch(`${API}/auth/signUp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME }),
    });

    if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
            organization?: { id?: string; name?: string };
            team?: { id?: string };
        };
        console.log(
            `seed:preview: signed up ${EMAIL} (organization ${body.organization?.id ?? '?'}, team ${
                body.team?.id ?? '?'
            })`,
        );
    } else {
        // Already seeded is the common case on a reconcile — prove it by
        // logging in rather than by pattern-matching an error message that can
        // change.
        const token = await login();
        if (!token) {
            const detail = await res.text().catch(() => '');
            const hint = detail.includes('not strong enough')
                ? ' — PREVIEW_SEED_PASSWORD needs 8+ chars with an uppercase, a lowercase, a number and a symbol'
                : '';
            throw new Error(
                `signUp failed (HTTP ${res.status}) and ${EMAIL} cannot log in: ${detail.slice(0, 400)}${hint}`,
            );
        }
        console.log(`seed:preview: ${EMAIL} already exists`);
    }

    // Runs on both paths: an environment seeded before this step existed is
    // still stuck in the wizard, and one reconcile should rescue it.
    const token = await login();
    if (!token) {
        console.warn(
            'seed:preview: could not log in to finish onboarding — the preview will open on the setup wizard',
        );
        return;
    }
    try {
        const teamId = await finishOnboarding(token);
        if (teamId) {
            activateTeam(teamId);
            try {
                await startPreviewTrial(token, teamId);
            } catch (error: any) {
                console.warn(
                    `seed:preview: billing trial unavailable for team ${teamId} (timeout 10000 ms): ${error?.message ?? error}`,
                );
            }
        }
    } catch (e: any) {
        console.warn(
            `seed:preview: could not finish onboarding (${e?.message ?? e}) — the preview will open on the setup wizard`,
        );
    }
}

main().catch((e) => {
    console.error(`seed:preview: ${e?.message ?? e}`);
    process.exit(1);
});

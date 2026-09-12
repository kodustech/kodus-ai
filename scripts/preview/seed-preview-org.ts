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
 * Credentials come from the environment; without PREVIEW_SEED_PASSWORD the
 * script does nothing, so a developer running the preview recipe by hand never
 * gets a login with a password that is public knowledge.
 */
import 'dotenv/config';

const API = (process.env.PREVIEW_SEED_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
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

async function canLogIn(): Promise<boolean> {
    const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    return res.ok;
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
        return;
    }

    // Already seeded is the common case on a reconcile — prove it by logging in
    // rather than by pattern-matching an error message that can change.
    if (await canLogIn()) {
        console.log(`seed:preview: ${EMAIL} already exists — nothing to do`);
        return;
    }

    const detail = await res.text().catch(() => '');
    throw new Error(
        `signUp failed (HTTP ${res.status}) and ${EMAIL} cannot log in: ${detail.slice(0, 400)}`,
    );
}

main().catch((e) => {
    console.error(`seed:preview: ${e?.message ?? e}`);
    process.exit(1);
});

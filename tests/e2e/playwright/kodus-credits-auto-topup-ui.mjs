#!/usr/bin/env node
// Browser-driven check of the auto top-up controls on the Kodus card:
//   1. Remove the saved card (UI) → card gone, auto top-up off;
//   2. "Save a card" → Stripe setup-mode Checkout with a card that SAVES but
//      DECLINES on charge (4000 0000 0000 0341 — attaches, then declines) → label shows •••• 0341;
//   3. switch auto top-up on (UI), pick "$20 when below $10" (UI selects),
//      stage the balance and debit under the threshold → the off-session
//      charge fails → the row shows the last error;
//   4. "Change" → setup Checkout with 4242 → toggle off/on (re-arms) → debit
//      again → charge succeeds → balance up by $20, error gone;
//   5. never-funded org: add a Kodus model through the form → lands on
//      /byok#kodus with the "Add credits to start reviewing" callout.
// Env: KODUS_E2E_EMAIL/PASSWORD (funded org), KODUS_E2E_UNFUNDED_EMAIL/PASSWORD
// (org with $0 and no purchases), BILLING_ADMIN_BASE_URL, BILLING_ADMIN_TOKEN.
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const {
    KODUS_WEB_URL = 'http://localhost:3000',
    KODUS_API_URL = 'http://localhost:3001',
    KODUS_E2E_EMAIL,
    KODUS_E2E_PASSWORD,
    KODUS_E2E_UNFUNDED_EMAIL,
    KODUS_E2E_UNFUNDED_PASSWORD,
    KODUS_E2E_SHOTS = '.playwright-shots',
    BILLING_ADMIN_BASE_URL = 'http://localhost:3992/api/billing',
    BILLING_ADMIN_TOKEN,
} = process.env;
const WEB = KODUS_WEB_URL.replace(/\/$/, ''),
    API = KODUS_API_URL.replace(/\/$/, '');
// Billing is reached directly: the browser proxy denies /credits/* (the app
// only touches credits through server actions).
const DIRECT = BILLING_ADMIN_BASE_URL.replace(/\/$/, ''),
    BILLING = DIRECT;
mkdirSync(KODUS_E2E_SHOTS, { recursive: true });
const SERVICE_SECRET = (process.env.BILLING_SERVICE_TOKEN || '').trim();
// Billing authenticates the callers of /credits/* (money routes) with a shared
// secret — the same one that signs its outbound webhooks. Signed, never sent:
// HMAC-SHA256 in `x-kodus-signature` over
// `METHOD\n/path\n<canonical query>\n<timestamp>\n<body>`, with the timestamp
// in `x-kodus-timestamp` (billing rejects anything outside a 5-minute window).
// The query is signed because the credit reads carry organizationId there.
const svc = (method, url, body) => {
    if (!SERVICE_SECRET) return {};
    const upper = String(method || 'GET').toUpperCase();
    const parsed = new URL(url, 'http://placeholder');
    const query = new URLSearchParams(parsed.search);
    query.sort();
    const raw = upper === 'GET' || upper === 'DELETE' ? '' : (body ?? '');
    const timestamp = String(Date.now());
    return {
        'x-kodus-signature': createHmac('sha256', SERVICE_SECRET)
            .update(
                [upper, parsed.pathname, query.toString(), timestamp, raw].join(
                    '\n',
                ),
            )
            .digest('hex'),
        'x-kodus-timestamp': timestamp,
    };
};

const log = (...a) => console.log('[auto-topup-ui]', ...a);
const fail = (m) => {
    console.error(`[auto-topup-ui] FAIL: ${m}`);
    process.exit(1);
};

async function apiLogin(email, password) {
    const r = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const b = await r.json();
    const t = b.accessToken ?? b.data?.accessToken;
    if (!t) throw new Error('login');
    return t;
}
async function ids(token) {
    // No billing secret on API calls: it validates nothing there and would
    // only land in that service's access log.
    const b = await fetch(`${API}/user/info`, {
        headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const d = b.data ?? b;
    return {
        organizationId: d.organization.uuid,
        teamId: d.teamMember[0].team.uuid,
    };
}
async function balance(token, qs) {
    const url = `${BILLING}/credits/balance${qs}`;
    const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, ...svc('GET', url) },
    });
    if (r.status !== 200) fail(`credits/balance HTTP ${r.status}`);
    const b = await r.json();
    if (!b?.autoTopUp)
        fail(
            `credits/balance answered without autoTopUp: ${JSON.stringify(b).slice(0, 200)}`,
        );
    return b;
}
async function stage(organizationId, teamId, target, current, stamp) {
    const url = `${DIRECT}/credits/adjust`;
    const payload = JSON.stringify({
        organizationId,
        teamId,
        amountUsd: target - current,
        usageKey: `e2e:ui:stage:${stamp}`,
        reason: 'e2e ui',
        adminToken: BILLING_ADMIN_TOKEN,
    });
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...svc('POST', url, payload),
        },
        body: payload,
    });
    if (r.status !== 200) fail(`adjust HTTP ${r.status}`);
}
async function debit(organizationId, teamId, amountUsd, stamp) {
    const url = `${DIRECT}/credits/debit`;
    const payload = JSON.stringify({
        organizationId,
        teamId,
        entries: [
            {
                usageKey: `e2e:ui:debit:${stamp}`,
                amountUsd,
                metadata: { model: 'e2e' },
            },
        ],
    });
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...svc('POST', url, payload),
        },
        body: payload,
    });
    const b = await r.json();
    if (r.status !== 200) fail(`debit HTTP ${r.status}`);
    return b.balanceUsd;
}
async function poll(pred, { timeoutMs, label }) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        const r = await pred();
        last = r.snapshot;
        if (r.match) return r.snapshot;
        await new Promise((z) => setTimeout(z, 3000));
    }
    fail(
        `timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 300)}`,
    );
}
async function webLogin(page, email, password) {
    await page.goto(`${WEB}/sign-in`, {
        waitUntil: 'networkidle',
        timeout: 240_000,
    });
    await page.waitForTimeout(1_200);
    await page
        .locator('input[type="email"]')
        .first()
        .fill(email, { timeout: 120_000 });
    const pwd = page.locator('input[type="password"]').first();
    for (let i = 0; i < 10; i++) {
        await page
            .getByRole('button', { name: /continue/i })
            .first()
            .click({ timeout: 30_000 })
            .catch(() => {});
        if (
            await pwd
                .waitFor({ timeout: 10_000 })
                .then(() => true)
                .catch(() => false)
        )
            break;
        await page.waitForTimeout(3000);
    }
    await pwd.fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !/sign-in/.test(u.toString()), {
        timeout: 240_000,
    });
}
async function stripeSetup(page, card) {
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    await page
        .waitForLoadState('networkidle', { timeout: 20_000 })
        .catch(() => {});
    const email = page.locator('input#email, input[name="email"]').first();
    if (await email.count())
        await email.fill('kodus-e2e@kodus.io').catch(() => {});
    await page.locator('input#cardNumber').fill(card);
    await page.locator('input#cardExpiry').fill('1234');
    await page.locator('input#cardCvc').fill('123');
    const name = page
        .locator('input[autocomplete="cc-name"], input#billingName')
        .first();
    if (await name.count()) await name.fill('Kodus E2E');
    const zip = page
        .locator('input[autocomplete="postal-code"], input#billingPostalCode')
        .first();
    if (await zip.count()) await zip.fill('12345');
    const phone = page
        .locator(
            'input#phoneNumber, input[name="phoneNumber"], input[autocomplete="tel"], input[type="tel"]',
        )
        .first();
    if (await phone.count()) await phone.fill('2015550123').catch(() => {});
    const linkOptIn = page
        .locator('input#enableStripePass, input[name="enableStripePass"]')
        .first();
    if (
        (await linkOptIn.count()) &&
        (await linkOptIn.isChecked().catch(() => false))
    )
        await linkOptIn.uncheck({ force: true }).catch(() => {});
    const submit = page
        .locator(
            'button[data-testid="hosted-payment-submit-button"], button[type="submit"]',
        )
        .first();
    await submit.waitFor({ timeout: 10_000 });
    await submit.click();
    try {
        await page.waitForURL(
            (u) => !/checkout\.stripe\.com/.test(u.toString()),
            { timeout: 90_000 },
        );
    } catch {
        const err = await page
            .locator('[role="alert"], [data-testid*="error"], .CheckoutError')
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null);
        await page.screenshot({
            path: `${KODUS_E2E_SHOTS}/stripe-setup-stuck.png`,
            fullPage: true,
        });
        throw new Error(
            `setup Checkout did not redirect. inline_error=${err ?? '(none)'} url=${page.url()}`,
        );
    }
}
async function openCard(page) {
    await page.goto(`${WEB}/byok?r=${Date.now()}#kodus`, {
        waitUntil: 'load',
        timeout: 240_000,
    });
    await page.getByTestId('kodus-auto-topup').waitFor({ timeout: 120_000 });
}
/** Click the auto top-up switch until billing reports `wanted` — a click can
 *  land while the row is disabled (busy) right after a refresh. */
async function setAutoTopUp(page, token, qs, wanted, label) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const b = await balance(token, qs);
        if (b.autoTopUp.enabled === wanted) return b;
        const sw = page.getByTestId('kodus-auto-topup-switch');
        await sw.waitFor({ timeout: 30_000 });
        await page
            .waitForFunction(
                () => {
                    const el = document.querySelector(
                        '[data-testid="kodus-auto-topup-switch"]',
                    );
                    return (
                        el &&
                        !el.hasAttribute('disabled') &&
                        el.getAttribute('data-disabled') === null
                    );
                },
                null,
                { timeout: 30_000 },
            )
            .catch(() => {});
        await sw.click();
        await page.waitForTimeout(4_000);
    }
    fail(`could not switch auto top-up ${wanted ? 'on' : 'off'} (${label})`);
}

async function pickSelect(page, ariaLabel, optionText) {
    await page.getByRole('combobox', { name: ariaLabel }).click();
    await page.getByRole('option', { name: optionText, exact: true }).click();
}

if (!KODUS_E2E_EMAIL || !BILLING_ADMIN_TOKEN)
    fail('KODUS_E2E_EMAIL and BILLING_ADMIN_TOKEN are required');
const token = await apiLogin(KODUS_E2E_EMAIL, KODUS_E2E_PASSWORD);
const { organizationId, teamId } = await ids(token);
const qs = `?organizationId=${organizationId}&teamId=${teamId}`;
const browser = await chromium.launch({ headless: true });
try {
    const page = await (
        await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    ).newPage();
    await webLogin(page, KODUS_E2E_EMAIL, KODUS_E2E_PASSWORD);
    await openCard(page);

    // 1. Remove the saved card through the UI.
    if (await page.getByTestId('kodus-auto-topup-card').count()) {
        await page
            .getByTestId('kodus-auto-topup')
            .getByRole('button', { name: 'Remove', exact: true })
            .click();
        await page
            .getByTestId('kodus-auto-topup')
            .getByRole('button', { name: /save a card/i })
            .waitFor({ timeout: 60_000 });
        const b = await balance(token, qs);
        if (b.autoTopUp.paymentMethod !== null || b.autoTopUp.enabled)
            fail(`after Remove: ${JSON.stringify(b.autoTopUp)}`);
        log('PASS Remove: card forgotten, auto top-up off (UI + billing)');
    }

    // 2. Save a card that declines on charge.
    await page
        .getByTestId('kodus-auto-topup')
        .getByRole('button', { name: /save a card/i })
        .click();
    await stripeSetup(page, '4000000000000341');
    if (!/credits=card_saved/.test(page.url()))
        fail(`expected credits=card_saved, got ${page.url()}`);
    const saved = await poll(
        async () => {
            const b = await balance(token, qs);
            return {
                match: /0341$/.test(b.autoTopUp.paymentMethod ?? ''),
                snapshot: b.autoTopUp,
            };
        },
        { timeoutMs: 60_000, label: 'setup session to record the card' },
    );
    log(
        `PASS setup Checkout saved the card without a purchase: ${saved.paymentMethod}`,
    );

    // 3. Switch on + pick amounts through the UI, then trigger a failing charge.
    await openCard(page);
    await pickSelect(page, 'Auto top-up amount', '$20');
    await pickSelect(page, 'Auto top-up threshold', '$10');
    const on = (
        await setAutoTopUp(page, token, qs, true, 'first enable from the UI')
    ).autoTopUp;
    if (!(on.amountUsd === 20 && on.thresholdUsd === 10))
        fail(`UI should have saved $20 below $10: ${JSON.stringify(on)}`);
    log(
        `PASS UI saved auto top-up: add $${on.amountUsd} below $${on.thresholdUsd}`,
    );
    // The threshold picker must not offer values above the amount.
    await page.getByRole('combobox', { name: 'Auto top-up threshold' }).click();
    const opt50 = page.getByRole('option', { name: '$50', exact: true });
    const disabled50 =
        (await opt50.getAttribute('aria-disabled')) === 'true' ||
        (await opt50.getAttribute('data-disabled')) !== null;
    await page.keyboard.press('Escape');
    if (!disabled50)
        fail('threshold $50 should be disabled when the amount is $20');
    log('PASS thresholds above the amount are disabled in the picker');

    let stamp = Date.now();
    const before = (await balance(token, qs)).balanceUsd;
    await stage(organizationId, teamId, 12, before, stamp);
    await debit(organizationId, teamId, 3, stamp);
    const failed = await poll(
        async () => {
            const b = await balance(token, qs);
            return { match: !!b.autoTopUp.lastError, snapshot: b.autoTopUp };
        },
        {
            timeoutMs: 90_000,
            label: 'the declined off-session charge to be recorded',
        },
    );
    log(`PASS declined card recorded: "${failed.lastError}"`);
    await openCard(page);
    await page
        .getByTestId('kodus-auto-topup-error')
        .waitFor({ timeout: 60_000 });
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/08-auto-topup-declined.png`,
        fullPage: true,
    });
    log('PASS the row shows the last failed charge (screenshot 08)');
    if ((await balance(token, qs)).balanceUsd !== 9)
        fail('a declined charge must not credit anything');

    // 4. Change the card to one that works, re-arm, debit again → success.
    await page
        .getByTestId('kodus-auto-topup')
        .getByRole('button', { name: 'Change', exact: true })
        .click();
    await stripeSetup(page, '4242424242424242');
    await poll(
        async () => {
            const b = await balance(token, qs);
            return {
                match: /4242$/.test(b.autoTopUp.paymentMethod ?? ''),
                snapshot: b.autoTopUp,
            };
        },
        { timeoutMs: 60_000, label: 'the replacement card' },
    );
    await openCard(page);
    await setAutoTopUp(page, token, qs, false, 'off after the card change');
    const rearmed = await setAutoTopUp(
        page,
        token,
        qs,
        true,
        'on again → re-arms the hourly window',
    );
    if (rearmed.autoTopUp.lastError !== null)
        fail(
            `re-enabling must clear the last error: ${JSON.stringify(rearmed.autoTopUp)}`,
        );
    stamp = Date.now();
    const b2 = (await balance(token, qs)).balanceUsd;
    await stage(organizationId, teamId, 12, b2, stamp);
    await debit(organizationId, teamId, 3, stamp);
    const ok = await poll(
        async () => {
            const b = await balance(token, qs);
            return {
                match: b.balanceUsd >= 29 - 1e-6 && !b.autoTopUp.lastError,
                snapshot: b,
            };
        },
        { timeoutMs: 90_000, label: 'the successful off-session charge' },
    );
    log(
        `PASS replacement card charged off-session: balance $${ok.balanceUsd}, no error`,
    );
    await openCard(page);
    await page.waitForFunction(
        () => document.body.innerText.includes('$29.00'),
        null,
        { timeout: 60_000 },
    );
    if (await page.getByTestId('kodus-auto-topup-error').count())
        fail('error line should be gone after a successful charge');
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/09-auto-topup-recovered.png`,
        fullPage: true,
    });
    log('PASS row recovered (screenshot 09)');
    // Leave it off.
    await setAutoTopUp(page, token, qs, false, 'cleanup');

    // 5. Never-funded org: add a Kodus model through the form.
    if (KODUS_E2E_UNFUNDED_EMAIL) {
        const ctx2 = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
        });
        const p2 = await ctx2.newPage();
        await webLogin(
            p2,
            KODUS_E2E_UNFUNDED_EMAIL,
            KODUS_E2E_UNFUNDED_PASSWORD,
        );
        await p2.goto(`${WEB}/byok/manual?provider=kodus`, {
            waitUntil: 'load',
            timeout: 240_000,
        });
        await p2.getByRole('combobox').first().click({ timeout: 120_000 });
        // Pick whichever catalog model is still offered (a model the org
        // already connected is not listed again on re-runs).
        const option = p2
            .getByRole('option')
            .filter({ hasText: /DeepSeek|Kimi|GLM/ })
            .first();
        await option.waitFor({ timeout: 60_000 });
        await option.click();
        await p2.getByRole('button', { name: /test & save/i }).click();
        await p2.waitForURL(/\/byok(\?|#|$)/, { timeout: 180_000 });
        if (!/#kodus/.test(p2.url()))
            fail(
                `saving a Kodus model should land on /byok#kodus, got ${p2.url()}`,
            );
        await p2
            .getByTestId('kodus-credits-never-funded')
            .waitFor({ timeout: 120_000 });
        // The model that was just saved shows up as a row with its list price
        // (the option's own label carries its description, so assert on the
        // row's stable marker instead of re-matching the picker text).
        await p2
            .getByTestId('kodus-model-tariff')
            .first()
            .waitFor({ timeout: 60_000 });
        await p2.screenshot({
            path: `${KODUS_E2E_SHOTS}/10-after-first-save.png`,
            fullPage: true,
        });
        log(
            'PASS form save lands on the card with the add-credits callout (screenshot 10)',
        );
        await ctx2.close();
    }
} finally {
    await browser.close();
}
log('ALL PASS');

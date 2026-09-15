#!/usr/bin/env node
// Live check of the prepaid-credit PURCHASE path ("Kodus as the provider"):
//   1. API login → billing `credits/checkout` (through the web proxy, as the
//      app does) for the smallest pack;
//   2. complete Stripe hosted Checkout in TEST mode (card 4242…);
//   3. Stripe → `checkout.session.completed` → billing ledger `purchase`
//      (delivered by `stripe listen` when the billing service isn't public);
//   4. balance == pack through the proxy; the license carries it;
//   5. the web UI (logged in) lands on the Kodus provider card (/byok#kodus)
//      whose wallet strip shows the new balance, the History drawer lists
//      the top-up, the avatar menu hints the balance on BYOK, and the
//      subscription page only points at the wallet — screenshotted.
//
// Env: KODUS_WEB_URL (default http://localhost:3000), KODUS_API_URL
// (default http://localhost:3001), KODUS_E2E_EMAIL,
// KODUS_E2E_PASSWORD, KODUS_E2E_HEADLESS=0 to watch, KODUS_E2E_SHOTS (dir).
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const {
    KODUS_WEB_URL = 'http://localhost:3000',
    KODUS_API_URL = 'http://localhost:3001',
    KODUS_E2E_EMAIL,
    KODUS_E2E_PASSWORD,
    KODUS_E2E_HEADLESS = '1',
    KODUS_E2E_SHOTS = '.playwright-shots',
} = process.env;

if (!KODUS_E2E_EMAIL || !KODUS_E2E_PASSWORD) {
    console.error('error: KODUS_E2E_EMAIL and KODUS_E2E_PASSWORD must be set');
    process.exit(2);
}

const WEB = KODUS_WEB_URL.replace(/\/$/, '');
// The API is reached directly (the web proxy for /api is cookie-gated). The
// billing service is reached DIRECTLY too: the browser proxy denies every
// /credits/* route (client-chosen organizationId), and the app itself only
// touches credits through server actions.
const API = KODUS_API_URL.replace(/\/$/, '');
const BILLING = (
    process.env.BILLING_ADMIN_BASE_URL || 'http://localhost:3992/api/billing'
).replace(/\/$/, '');
const headless = KODUS_E2E_HEADLESS !== '0';
mkdirSync(KODUS_E2E_SHOTS, { recursive: true });

const TEST_CARD = '4242424242424242';
const TEST_EXPIRY = '1234';
const TEST_CVC = '123';
const TEST_ZIP = '12345';
const TEST_PHONE = '2015550123';

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
    const raw = body ?? '';
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

const log = (...a) => console.log('[kodus-credits]', ...a);
const fail = (msg) => {
    console.error(`[kodus-credits] FAIL: ${msg}`);
    process.exit(1);
};

async function login(email, password) {
    const resp = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const body = await resp.json().catch(() => null);
    if (resp.status >= 300) throw new Error(`login HTTP ${resp.status}`);
    const token = body?.accessToken ?? body?.data?.accessToken;
    if (!token) throw new Error('login: no accessToken');
    return token;
}

async function userInfo(token) {
    // The Kodus API never validates the billing service secret — do not put
    // a money-scoped credential in its request (or its access log).
    const resp = await fetch(`${API}/user/info`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status !== 200) throw new Error(`/user/info HTTP ${resp.status}`);
    const body = await resp.json();
    const data = body?.data ?? body;
    return {
        organizationId: data?.organization?.uuid,
        teamId: data?.teamMember?.[0]?.team?.uuid,
    };
}

async function billingFetch(token, path, init = {}) {
    const url = `${BILLING}${path}`;
    const resp = await fetch(url, {
        ...init,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...svc(init.method ?? 'GET', url, init.body),
            ...(init.headers ?? {}),
        },
    });
    const text = await resp.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: resp.status, body };
}

async function pollUntil(pred, { timeoutMs, intervalMs = 3000, label }) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        const r = await pred();
        last = r.snapshot;
        if (r.match) return r.snapshot;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
        `timeout waiting for ${label}; last=${JSON.stringify(last)}`,
    );
}

async function completeStripeCheckout(page) {
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    await page
        .waitForLoadState('networkidle', { timeout: 20_000 })
        .catch(() => {});
    log(`stripe checkout loaded: ${page.url()}`);
    const email = page.locator('input#email, input[name="email"]').first();
    if (await email.count()) await email.fill('kodus-e2e@kodus.io');
    const linkOptIn = page
        .locator(
            'input#enableStripePass, input[name="enableStripePass"], input[type="checkbox"][aria-label*="Save my information" i]',
        )
        .first();
    if (
        (await linkOptIn.count()) &&
        (await linkOptIn.isChecked().catch(() => false))
    ) {
        await linkOptIn.uncheck({ force: true }).catch(() => {});
    }
    // A customer with a card already on file (saved off-session by an earlier
    // pack purchase) gets the saved card pre-selected and no card form: then
    // there is nothing to type, just confirm.
    const cardNumber = page.locator('input#cardNumber');
    const submitBtn = page
        .locator(
            'button[data-testid="hosted-payment-submit-button"], button[type="submit"]',
        )
        .first();
    // Wait for either state to be REAL: the card form, or a ready submit
    // button with no card form (saved card pre-selected). Neither in time
    // is a failure, never a silent empty submit.
    await Promise.race([
        cardNumber.waitFor({ timeout: 60_000 }),
        submitBtn.waitFor({ timeout: 60_000 }),
    ]).catch(() => {});
    const hasCardForm = (await cardNumber.count()) > 0;
    if (!hasCardForm && !(await submitBtn.count())) {
        await page.screenshot({
            path: `${KODUS_E2E_SHOTS}/01-stripe-unknown-state.png`,
            fullPage: true,
        });
        fail(
            `Stripe Checkout showed neither a card form nor a submit button: ${page.url()}`,
        );
    }
    if (hasCardForm) {
        await cardNumber.fill(TEST_CARD);
        await page.locator('input#cardExpiry').fill(TEST_EXPIRY);
        await page.locator('input#cardCvc').fill(TEST_CVC);
        const nameField = page
            .locator('input[autocomplete="cc-name"], input#billingName')
            .first();
        if (await nameField.count()) await nameField.fill('Kodus E2E');
        const zip = page
            .locator(
                'input[autocomplete="postal-code"], input#billingPostalCode',
            )
            .first();
        if (await zip.count()) await zip.fill(TEST_ZIP);
        const phone = page
            .locator(
                'input#phoneNumber, input[name="phoneNumber"], input[autocomplete="tel"], input[type="tel"]',
            )
            .first();
        if (await phone.count()) await phone.fill(TEST_PHONE);
    } else {
        log(
            'stripe checkout: no card form (saved card pre-selected) — confirming as is',
        );
    }
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/01-stripe-checkout.png`,
        fullPage: true,
    });
    const submit = page
        .locator(
            'button[data-testid="hosted-payment-submit-button"], button[type="submit"]:has-text("Pay"), button[type="submit"]:has-text("Subscribe")',
        )
        .first();
    await submit.waitFor({ timeout: 10_000 });
    await submit.click();
    try {
        await page.waitForURL(
            (u) => {
                try {
                    return (
                        new URL(u.toString()).hostname !== 'checkout.stripe.com'
                    );
                } catch {
                    return true;
                }
            },
            { timeout: 60_000 },
        );
    } catch {
        const errText = await page
            .locator('[role="alert"], .CheckoutError, [data-testid*="error"]')
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null);
        await page.screenshot({
            path: `${KODUS_E2E_SHOTS}/01-stripe-stuck.png`,
            fullPage: true,
        });
        throw new Error(
            `Stripe checkout did not redirect. inline_error=${errText ?? '(none)'} url=${page.url()}`,
        );
    }
    log(`stripe checkout completed → ${page.url()}`);
}

const token = await login(KODUS_E2E_EMAIL, KODUS_E2E_PASSWORD);
const { organizationId, teamId } = await userInfo(token);
if (!organizationId || !teamId) fail('could not resolve org/team');
log(`org=${organizationId} team=${teamId}`);

const qs = `?organizationId=${organizationId}&teamId=${teamId}`;
const before = await billingFetch(token, `/credits/balance${qs}`);
if (before.status !== 200) fail(`credits/balance HTTP ${before.status}`);
const pack = before.body.packsUsd[0];
log(
    `balance before: $${before.body.balanceUsd}; buying pack $${pack} (markup ${before.body.markupPct}%)`,
);

const checkout = await billingFetch(token, `/credits/checkout`, {
    method: 'POST',
    body: JSON.stringify({ organizationId, teamId, creditUsd: pack }),
});
if (checkout.status !== 200 || !checkout.body?.url) {
    fail(
        `credits/checkout HTTP ${checkout.status} ${JSON.stringify(checkout.body).slice(0, 200)}`,
    );
}
log(
    `quote: credit $${checkout.body.creditUsd} → charge $${checkout.body.chargeUsd}`,
);

const browser = await chromium.launch({ headless });
try {
    const ctx = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
    });
    const page = await ctx.newPage();

    // Log the BROWSER in first so the post-checkout redirect lands on the
    // wallet (an anonymous context is bounced to /sign-in and the success
    // query is lost).
    // Two-step form: email → Continue → password → submit.
    await page.goto(`${WEB}/sign-in`, {
        waitUntil: 'networkidle',
        timeout: 240_000,
    });
    await page.waitForTimeout(1_200);
    await page
        .locator('input[type="email"], input[name="email"]')
        .first()
        .fill(KODUS_E2E_EMAIL);
    const pwd = page.locator('input[type="password"]').first();
    // The click can land before hydration and be swallowed (a dev server
    // compiling the page makes this worse): retry until the password step
    // actually appears.
    for (let attempt = 0; attempt < 12; attempt++) {
        await page
            .getByRole('button', { name: /continue/i })
            .first()
            .click({ timeout: 30_000 })
            .catch(() => {});
        const shown = await pwd
            .waitFor({ timeout: 8_000 })
            .then(() => true)
            .catch(() => false);
        if (shown) break;
        await page.waitForTimeout(2_500);
    }
    await pwd.waitFor({ timeout: 30_000 });
    await pwd.fill(KODUS_E2E_PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !/sign-in|login/.test(u.toString()), {
        timeout: 240_000,
    });
    log(`web login ok → ${page.url()}`);

    await page.goto(checkout.body.url, { waitUntil: 'domcontentloaded' });
    await completeStripeCheckout(page);
    if (!/credits=success/.test(page.url()))
        fail(`expected success redirect, got ${page.url()}`);
    log(`PASS redirected back with credits=success`);

    const after = await pollUntil(
        async () => {
            const r = await billingFetch(token, `/credits/balance${qs}`);
            return {
                match:
                    r.status === 200 &&
                    Math.abs(
                        r.body.balanceUsd - (before.body.balanceUsd + pack),
                    ) < 1e-6,
                snapshot: r.body,
            };
        },
        { timeoutMs: 90_000, label: 'ledger credited by the Stripe webhook' },
    );
    log(
        `PASS balance after webhook: $${after.balanceUsd} (lifetime purchased $${after.lifetimePurchasedUsd})`,
    );

    const ledger = await billingFetch(token, `/credits/ledger${qs}`);
    const purchase = (ledger.body?.entries ?? []).find(
        (e) => e.type === 'purchase',
    );
    if (!purchase || purchase.amountUsd !== pack)
        fail(
            `no purchase entry of $${pack}: ${JSON.stringify(ledger.body).slice(0, 300)}`,
        );
    if (!/^stripe:checkout:cs_/.test(purchase.usageKey))
        fail(
            `purchase usageKey must be the Stripe session: ${purchase.usageKey}`,
        );
    log(
        `PASS ledger purchase entry ${purchase.usageKey} chargeUsd=${purchase.metadata?.chargeUsd}`,
    );

    const lic = await billingFetch(token, `/validate-org-license${qs}`);
    if (lic.body?.creditBalanceUsd !== after.balanceUsd)
        fail(
            `license creditBalanceUsd=${lic.body?.creditBalanceUsd} != ${after.balanceUsd}`,
        );
    log(
        `PASS validate-org-license carries creditBalanceUsd=${lic.body.creditBalanceUsd}`,
    );

    // The page we were redirected to: the Kodus provider card, whose wallet
    // strip carries the new balance. No Credits tab exists any more.
    if (!/\/byok(\?|#)/.test(page.url()) || !/#kodus/.test(page.url()))
        fail(`expected the Kodus card (/byok…#kodus), got ${page.url()}`);
    await page.waitForLoadState('load', { timeout: 240_000 }).catch(() => {});
    const balanceText = `$${after.balanceUsd.toFixed(2)}`;
    if (await page.getByRole('tab', { name: /credits/i }).count())
        fail(
            'a Credits tab still renders — the wallet must live on the provider card',
        );
    const card = page.locator('#kodus');
    await card.waitFor({ timeout: 180_000 });
    await card
        .getByTestId('kodus-credits-balance')
        .getByText(balanceText, { exact: false })
        .waitFor({ timeout: 120_000 });
    const providerText =
        (await page.getByTestId('kodus-provider-balance').textContent()) ?? '';
    if (!providerText.includes(balanceText))
        fail(
            `Kodus provider header shows "${providerText}", expected ${balanceText}`,
        );
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/02-byok-kodus-card-wallet.png`,
        fullPage: true,
    });
    log(
        `PASS Kodus provider card shows ${balanceText} in the header and the wallet strip (screenshot 02)`,
    );

    // History drawer: the money ledger with the top-up + charges by review.
    await card.getByRole('button', { name: /history/i }).click();
    const drawer = page.getByRole('dialog');
    await drawer
        .getByText('Money movements', { exact: true })
        .waitFor({ timeout: 60_000 });
    // The ledger row for the pack we just bought (not the "top-ups" copy).
    await drawer
        .getByRole('cell', { name: /credit pack/i })
        .first()
        .waitFor({ timeout: 60_000 });
    await drawer
        .getByText('Charges by review', { exact: true })
        .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(700); // slide-in animation
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/03-history-drawer.png`,
        fullPage: false,
    });
    log(
        `PASS History drawer lists the top-up and charges by review (screenshot 03)`,
    );
    await page.keyboard.press('Escape');

    // Avatar menu: the BYOK entry carries the balance as a quiet hint.
    await page.getByTestId('user-nav-trigger').click();
    const hint = page.getByTestId('user-nav-credits');
    await hint.waitFor({ timeout: 60_000 });
    const hintText = (await hint.textContent()) ?? '';
    if (!hintText.includes(balanceText))
        fail(
            `avatar menu BYOK hint shows "${hintText}", expected ${balanceText}`,
        );
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/05-avatar-menu.png`,
        clip: { x: 900, y: 0, width: 500, height: 420 },
    });
    await page.keyboard.press('Escape');
    log(`PASS avatar menu BYOK entry shows ${balanceText} (screenshot 04)`);

    // The pack's card was saved for auto top-up (setup_future_usage) — the
    // strip shows it; the model row shows the catalog tariff.
    await page.goto(`${WEB}/byok#kodus`, {
        waitUntil: 'load',
        timeout: 240_000,
    });
    await page
        .getByTestId('kodus-model-tariff')
        .first()
        .waitFor({ timeout: 120_000 });
    const cardLabel = page.getByTestId('kodus-auto-topup-card');
    await cardLabel.waitFor({ timeout: 120_000 });
    const cardText = (await cardLabel.textContent()) ?? '';
    if (!/4242/.test(cardText))
        fail(`saved card label "${cardText}" should end in 4242`);
    log(
        `PASS the Checkout card was saved for auto top-up (${cardText.trim()}); model row shows the tariff`,
    );

    // Turn auto top-up on (threshold $50, add $20) through the same billing
    // proxy the UI uses, then drive the balance under the threshold with a
    // real debit: the billing service charges the saved card off-session and
    // credits the ledger on its own.
    // The threshold must not exceed the amount (a top-up that leaves the
    // balance still under the threshold would re-trigger every hour).
    const AUTO_THRESHOLD = 10;
    const AUTO_AMOUNT = pack;
    const auto = await billingFetch(token, `/credits/auto-topup`, {
        method: 'POST',
        body: JSON.stringify({
            organizationId,
            teamId,
            enabled: true,
            thresholdUsd: AUTO_THRESHOLD,
            amountUsd: AUTO_AMOUNT,
        }),
    });
    if (auto.status !== 200 || auto.body?.enabled !== true)
        fail(
            `credits/auto-topup HTTP ${auto.status} ${JSON.stringify(auto.body).slice(0, 200)}`,
        );
    log(
        `PASS auto top-up enabled: add $${AUTO_AMOUNT} when below $${AUTO_THRESHOLD}`,
    );

    const BILLING_DIRECT = (
        process.env.BILLING_ADMIN_BASE_URL ||
        'http://localhost:3992/api/billing'
    ).replace(/\/$/, '');
    const adminToken = process.env.BILLING_ADMIN_TOKEN;
    if (!adminToken)
        fail(
            'BILLING_ADMIN_TOKEN is required to stage the balance for the auto top-up check',
        );
    const stamp = Date.now();
    const current = (await billingFetch(token, `/credits/balance${qs}`)).body
        .balanceUsd;
    const target = AUTO_THRESHOLD + 2; // just above: the $3 debit below crosses it
    const adj = await fetch(`${BILLING_DIRECT}/credits/adjust`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...svc(
                'POST',
                `${BILLING_DIRECT}/credits/adjust`,
                JSON.stringify({
                    organizationId,
                    teamId,
                    amountUsd: target - current,
                    usageKey: `e2e:auto:stage:${stamp}`,
                    reason: 'e2e: stage balance under the auto top-up threshold',
                    adminToken,
                }),
            ),
        },
        body: JSON.stringify({
            organizationId,
            teamId,
            amountUsd: target - current,
            usageKey: `e2e:auto:stage:${stamp}`,
            reason: 'e2e: stage balance under the auto top-up threshold',
            adminToken,
        }),
    });
    if (adj.status !== 200) fail(`credits/adjust HTTP ${adj.status}`);
    const debit = await fetch(`${BILLING_DIRECT}/credits/debit`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...svc(
                'POST',
                `${BILLING_DIRECT}/credits/debit`,
                JSON.stringify({
                    organizationId,
                    teamId,
                    entries: [
                        {
                            usageKey: `e2e:auto:debit:${stamp}`,
                            amountUsd: 3,
                            metadata: {
                                model: 'e2e',
                                reason: 'auto top-up trigger',
                            },
                        },
                    ],
                }),
            ),
        },
        body: JSON.stringify({
            organizationId,
            teamId,
            entries: [
                {
                    usageKey: `e2e:auto:debit:${stamp}`,
                    amountUsd: 3,
                    metadata: { model: 'e2e', reason: 'auto top-up trigger' },
                },
            ],
        }),
    });
    const debitBody = await debit.json().catch(() => ({}));
    if (debit.status !== 200)
        fail(
            `credits/debit HTTP ${debit.status} ${JSON.stringify(debitBody).slice(0, 200)}`,
        );
    log(
        `debit applied → balance $${debitBody.balanceUsd} (below $${AUTO_THRESHOLD}); waiting for the off-session charge`,
    );

    const autoBalance = await pollUntil(
        async () => {
            const r = await billingFetch(token, `/credits/balance${qs}`);
            return {
                match:
                    r.status === 200 &&
                    r.body.balanceUsd >= target - 3 + AUTO_AMOUNT - 1e-6,
                snapshot: r.body,
            };
        },
        { timeoutMs: 90_000, label: 'auto top-up to credit the ledger' },
    );
    if (autoBalance.autoTopUp?.lastError)
        fail(
            `auto top-up recorded an error: ${autoBalance.autoTopUp.lastError}`,
        );
    const autoLedger = await billingFetch(token, `/credits/ledger${qs}`);
    const autoEntry = (autoLedger.body?.entries ?? []).find(
        (e) => e.type === 'purchase' && e.metadata?.auto === true,
    );
    if (!autoEntry || autoEntry.amountUsd !== AUTO_AMOUNT)
        fail(
            `no automatic purchase of $${AUTO_AMOUNT} in the ledger: ${JSON.stringify(autoLedger.body).slice(0, 300)}`,
        );
    if (!/^stripe:pi:/.test(autoEntry.usageKey))
        fail(
            `auto top-up usageKey must be the PaymentIntent: ${autoEntry.usageKey}`,
        );
    log(
        `PASS auto top-up charged the saved card off-session: +$${AUTO_AMOUNT} → balance $${autoBalance.balanceUsd} (${autoEntry.usageKey})`,
    );

    // A hash-only navigation would not reload the page (and the 30s query
    // cache would keep the old balance), so bust it with a query param.
    await page.goto(`${WEB}/byok?r=${Date.now()}#kodus`, {
        waitUntil: 'load',
        timeout: 240_000,
    });
    await page.getByTestId('kodus-auto-topup').waitFor({ timeout: 120_000 });
    await page.waitForFunction(
        (b) => document.body.innerText.includes(b),
        `$${autoBalance.balanceUsd.toFixed(2)}`,
        { timeout: 60_000 },
    );
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/04-auto-topup-row.png`,
        fullPage: true,
    });
    log(`PASS wallet shows the auto top-up row + new balance (screenshot 04)`);

    // Leave the org as it was: auto top-up off (the card stays).
    await billingFetch(token, `/credits/auto-topup`, {
        method: 'POST',
        body: JSON.stringify({ organizationId, teamId, enabled: false }),
    });

    // Subscription page: a pointer to the wallet, not a second wallet.
    await page.goto(`${WEB}/settings/subscription`, {
        waitUntil: 'load',
        timeout: 240_000,
    });
    await page
        .getByText('Kodus credits', { exact: false })
        .first()
        .waitFor({ timeout: 180_000 });
    // Decorative buttons render as <span> inside the link, so look for the link.
    await page
        .getByRole('link', { name: /manage credits|top up/i })
        .first()
        .waitFor({ timeout: 60_000 });
    const topUpButtons = await page
        .getByRole('button', { name: /^\+\$/ })
        .count();
    if (topUpButtons !== 0)
        fail(
            `subscription page still renders ${topUpButtons} pack buttons — the wallet must live in BYOK only`,
        );
    await page.screenshot({
        path: `${KODUS_E2E_SHOTS}/06-subscription-pointer.png`,
        fullPage: true,
    });
    log(
        `PASS subscription page points at the wallet without duplicating it (screenshot 06)`,
    );
    await ctx.close();
} finally {
    await browser.close();
}
log('ALL PASS');

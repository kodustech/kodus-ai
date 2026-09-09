#!/usr/bin/env node
// Live check of the prepaid-credit PURCHASE path ("Kodus as the provider"):
//   1. API login → billing `credits/checkout` (through the web proxy, as the
//      app does) for the smallest pack;
//   2. complete Stripe hosted Checkout in TEST mode (card 4242…);
//   3. Stripe → `checkout.session.completed` → billing ledger `purchase`
//      (delivered by `stripe listen` when the billing service isn't public);
//   4. balance == pack through the proxy; the license carries it;
//   5. the web UI (logged in) lands on the wallet (BYOK → Credits) with the
//      new balance and the top-up entry, the navbar wallet chip shows the
//      balance, the Kodus provider card shows it, and the subscription page
//      only points at the wallet — screenshotted as evidence.
//
// Env: KODUS_WEB_URL (default http://localhost:3000), KODUS_API_URL
// (default http://localhost:3001), KODUS_E2E_EMAIL,
// KODUS_E2E_PASSWORD, KODUS_E2E_HEADLESS=0 to watch, KODUS_E2E_SHOTS (dir).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const {
    KODUS_WEB_URL = "http://localhost:3000",
    KODUS_API_URL = "http://localhost:3001",
    KODUS_E2E_EMAIL,
    KODUS_E2E_PASSWORD,
    KODUS_E2E_HEADLESS = "1",
    KODUS_E2E_SHOTS = ".playwright-shots",
} = process.env;

if (!KODUS_E2E_EMAIL || !KODUS_E2E_PASSWORD) {
    console.error("error: KODUS_E2E_EMAIL and KODUS_E2E_PASSWORD must be set");
    process.exit(2);
}

const WEB = KODUS_WEB_URL.replace(/\/$/, "");
// The API is reached directly (the web proxy for /api is cookie-gated); the
// billing service goes through the proxy exactly as the app does.
const API = KODUS_API_URL.replace(/\/$/, "");
const BILLING = `${WEB}/api/proxy/billing`;
const headless = KODUS_E2E_HEADLESS !== "0";
mkdirSync(KODUS_E2E_SHOTS, { recursive: true });

const TEST_CARD = "4242424242424242";
const TEST_EXPIRY = "1234";
const TEST_CVC = "123";
const TEST_ZIP = "12345";
const TEST_PHONE = "2015550123";

const log = (...a) => console.log("[kodus-credits]", ...a);
const fail = (msg) => {
    console.error(`[kodus-credits] FAIL: ${msg}`);
    process.exit(1);
};

async function login(email, password) {
    const resp = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    const body = await resp.json().catch(() => null);
    if (resp.status >= 300) throw new Error(`login HTTP ${resp.status}`);
    const token = body?.accessToken ?? body?.data?.accessToken;
    if (!token) throw new Error("login: no accessToken");
    return token;
}

async function userInfo(token) {
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
    const resp = await fetch(`${BILLING}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
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
    throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function completeStripeCheckout(page) {
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    log(`stripe checkout loaded: ${page.url()}`);
    const email = page.locator('input#email, input[name="email"]').first();
    if (await email.count()) await email.fill("kodus-e2e@kodus.io");
    const linkOptIn = page
        .locator(
            'input#enableStripePass, input[name="enableStripePass"], input[type="checkbox"][aria-label*="Save my information" i]',
        )
        .first();
    if ((await linkOptIn.count()) && (await linkOptIn.isChecked().catch(() => false))) {
        await linkOptIn.uncheck({ force: true }).catch(() => {});
    }
    await page.locator("input#cardNumber").fill(TEST_CARD);
    await page.locator("input#cardExpiry").fill(TEST_EXPIRY);
    await page.locator("input#cardCvc").fill(TEST_CVC);
    const nameField = page.locator('input[autocomplete="cc-name"], input#billingName').first();
    if (await nameField.count()) await nameField.fill("Kodus E2E");
    const zip = page.locator('input[autocomplete="postal-code"], input#billingPostalCode').first();
    if (await zip.count()) await zip.fill(TEST_ZIP);
    const phone = page
        .locator('input#phoneNumber, input[name="phoneNumber"], input[autocomplete="tel"], input[type="tel"]')
        .first();
    if (await phone.count()) await phone.fill(TEST_PHONE);
    await page.screenshot({ path: `${KODUS_E2E_SHOTS}/01-stripe-checkout.png`, fullPage: true });
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
                    return new URL(u.toString()).hostname !== "checkout.stripe.com";
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
        await page.screenshot({ path: `${KODUS_E2E_SHOTS}/01-stripe-stuck.png`, fullPage: true });
        throw new Error(`Stripe checkout did not redirect. inline_error=${errText ?? "(none)"} url=${page.url()}`);
    }
    log(`stripe checkout completed → ${page.url()}`);
}

const token = await login(KODUS_E2E_EMAIL, KODUS_E2E_PASSWORD);
const { organizationId, teamId } = await userInfo(token);
if (!organizationId || !teamId) fail("could not resolve org/team");
log(`org=${organizationId} team=${teamId}`);

const qs = `?organizationId=${organizationId}&teamId=${teamId}`;
const before = await billingFetch(token, `/credits/balance${qs}`);
if (before.status !== 200) fail(`credits/balance HTTP ${before.status}`);
const pack = before.body.packsUsd[0];
log(`balance before: $${before.body.balanceUsd}; buying pack $${pack} (markup ${before.body.markupPct}%)`);

const checkout = await billingFetch(token, `/credits/checkout`, {
    method: "POST",
    body: JSON.stringify({ organizationId, teamId, creditUsd: pack }),
});
if (checkout.status !== 200 || !checkout.body?.url) {
    fail(`credits/checkout HTTP ${checkout.status} ${JSON.stringify(checkout.body).slice(0, 200)}`);
}
log(`quote: credit $${checkout.body.creditUsd} → charge $${checkout.body.chargeUsd}`);

const browser = await chromium.launch({ headless });
try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();

    // Log the BROWSER in first so the post-checkout redirect lands on the
    // wallet (an anonymous context is bounced to /sign-in and the success
    // query is lost).
    // Two-step form: email → Continue → password → submit.
    await page.goto(`${WEB}/sign-in`, { waitUntil: "load", timeout: 240_000 });
    await page.locator('input[type="email"], input[name="email"]').first().fill(KODUS_E2E_EMAIL);
    const pwd = page.locator('input[type="password"], input[name="password"]').first();
    // The click can land before hydration and be swallowed: retry until the
    // password step actually appears.
    for (let attempt = 0; attempt < 6; attempt++) {
        await page.getByRole("button", { name: /continue/i }).first().click({ timeout: 30_000 }).catch(() => {});
        const shown = await pwd.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
        if (shown) break;
        await page.waitForTimeout(2_000);
    }
    await pwd.waitFor({ timeout: 30_000 });
    await pwd.fill(KODUS_E2E_PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !/sign-in|login/.test(u.toString()), { timeout: 240_000 });
    log(`web login ok → ${page.url()}`);

    await page.goto(checkout.body.url, { waitUntil: "domcontentloaded" });
    await completeStripeCheckout(page);
    if (!/credits=success/.test(page.url())) fail(`expected success redirect, got ${page.url()}`);
    log(`PASS redirected back with credits=success`);

    const after = await pollUntil(
        async () => {
            const r = await billingFetch(token, `/credits/balance${qs}`);
            return {
                match: r.status === 200 && Math.abs(r.body.balanceUsd - (before.body.balanceUsd + pack)) < 1e-6,
                snapshot: r.body,
            };
        },
        { timeoutMs: 90_000, label: "ledger credited by the Stripe webhook" },
    );
    log(`PASS balance after webhook: $${after.balanceUsd} (lifetime purchased $${after.lifetimePurchasedUsd})`);

    const ledger = await billingFetch(token, `/credits/ledger${qs}`);
    const purchase = (ledger.body?.entries ?? []).find((e) => e.type === "purchase");
    if (!purchase || purchase.amountUsd !== pack) fail(`no purchase entry of $${pack}: ${JSON.stringify(ledger.body).slice(0, 300)}`);
    if (!/^stripe:checkout:cs_/.test(purchase.usageKey)) fail(`purchase usageKey must be the Stripe session: ${purchase.usageKey}`);
    log(`PASS ledger purchase entry ${purchase.usageKey} chargeUsd=${purchase.metadata?.chargeUsd}`);

    const lic = await billingFetch(token, `/validate-org-license${qs}`);
    if (lic.body?.creditBalanceUsd !== after.balanceUsd) fail(`license creditBalanceUsd=${lic.body?.creditBalanceUsd} != ${after.balanceUsd}`);
    log(`PASS validate-org-license carries creditBalanceUsd=${lic.body.creditBalanceUsd}`);

    // The page we were redirected to: the wallet (BYOK → Credits) with the
    // new balance and the top-up entry.
    if (!/\/byok\?tab=credits/.test(page.url())) fail(`expected the wallet (/byok?tab=credits), got ${page.url()}`);
    await page.waitForLoadState("load", { timeout: 240_000 }).catch(() => {});
    const balanceText = `$${after.balanceUsd.toFixed(2)}`;
    const wallet = page.getByTestId("kodus-credits-balance");
    await wallet.waitFor({ timeout: 180_000 });
    await page.getByTestId("kodus-credits-balance").getByText(balanceText, { exact: false }).waitFor({ timeout: 120_000 });
    await page.getByText("Top-up", { exact: false }).first().waitFor({ timeout: 60_000 });
    await page.getByText("Charges by review", { exact: false }).first().waitFor({ timeout: 60_000 });
    await page.screenshot({ path: `${KODUS_E2E_SHOTS}/02-byok-wallet.png`, fullPage: true });
    log(`PASS wallet shows ${balanceText}, the top-up entry and charges by review (screenshot 02)`);

    // Navbar wallet chip: balance, linking to the wallet.
    const chip = page.getByTestId("kodus-credits-badge");
    await chip.waitFor({ timeout: 60_000 });
    const chipText = (await chip.textContent()) ?? "";
    if (!chipText.includes(balanceText)) fail(`navbar credits chip shows "${chipText}", expected ${balanceText}`);
    log(`PASS navbar wallet chip shows ${balanceText}`);

    // Providers tab: the Kodus provider card carries the balance + Top up.
    await page.goto(`${WEB}/byok`, { waitUntil: "load", timeout: 240_000 });
    const providerBalance = page.getByTestId("kodus-provider-balance");
    await providerBalance.waitFor({ timeout: 180_000 });
    const providerText = (await providerBalance.textContent()) ?? "";
    if (!providerText.includes(balanceText)) fail(`Kodus provider card shows "${providerText}", expected ${balanceText}`);
    await page.getByRole("button", { name: /top up/i }).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: `${KODUS_E2E_SHOTS}/03-byok-providers-balance.png`, fullPage: true });
    log(`PASS Kodus provider card shows ${balanceText} + Top up (screenshot 03)`);

    // Subscription page: a pointer to the wallet, not a second wallet.
    await page.goto(`${WEB}/settings/subscription`, { waitUntil: "load", timeout: 240_000 });
    await page.getByText("Kodus credits", { exact: false }).first().waitFor({ timeout: 180_000 });
    // Decorative buttons render as <span> inside the link, so look for the link.
    await page.getByRole("link", { name: /manage credits|top up/i }).first().waitFor({ timeout: 60_000 });
    const topUpButtons = await page.getByRole("button", { name: /^\+\$/ }).count();
    if (topUpButtons !== 0) fail(`subscription page still renders ${topUpButtons} pack buttons — the wallet must live in BYOK only`);
    await page.screenshot({ path: `${KODUS_E2E_SHOTS}/04-subscription-pointer.png`, fullPage: true });
    log(`PASS subscription page points at the wallet without duplicating it (screenshot 04)`);
    await ctx.close();
} finally {
    await browser.close();
}
log("ALL PASS");

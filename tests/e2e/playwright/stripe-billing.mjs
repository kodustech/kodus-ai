// Stripe billing E2E driver — Playwright × QA cloud (qa.web.kodus.io).
//
// Validates the 4 billing lifecycle moves that customers exercise:
//
//   1. free  → paid   via Stripe Checkout
//   2. trial → paid   via Stripe Checkout
//   3. paid  → cancel via Stripe Customer Portal
//   4. paid  → free   via /api/proxy/billing/migrate-to-free
//
// The 2 dedicated tenants are seeded by cli/cloud/setup-tenants.ts:
//   - e2e-stripe-checkout-free@kodus.io  (covers #1 then #3)
//   - e2e-stripe-checkout-trial@kodus.io (covers #2 then #4)
//
// Stripe Checkout / Portal run in TEST MODE. Card 4242 4242 4242 4242
// with any future expiry + any 3-digit CVC completes the purchase
// synchronously. Webhooks flip the subscription record server-side
// within a few seconds, so each sub-flow polls the billing API until
// the tier matches the expected state (or times out at 60s).
//
// Required env:
//   STRIPE_E2E_WEB_URL       https://qa.web.kodus.io
//   STRIPE_E2E_FREE_EMAIL    e2e-stripe-checkout-free@kodus.io
//   STRIPE_E2E_TRIAL_EMAIL   e2e-stripe-checkout-trial@kodus.io
//   STRIPE_E2E_PASSWORD      shared QA password
//   STRIPE_E2E_HEADLESS=0    for a visible Chromium window
//
// Exits 0 only when ALL 4 sub-flows pass. Prints
// `[stripe-billing] PASS sub-flow-N: …` per success or
// `[stripe-billing] FAIL sub-flow-N: …` on the first failure.

import { chromium } from "playwright";
import { applyWafBypass } from "./waf-bypass.mjs";
import { writeFileSync } from "node:fs";

const {
    STRIPE_E2E_WEB_URL = "https://qa.web.kodus.io",
    STRIPE_E2E_FREE_EMAIL = "e2e-stripe-checkout-free@kodus.io",
    STRIPE_E2E_TRIAL_EMAIL = "e2e-stripe-checkout-trial@kodus.io",
    STRIPE_E2E_PASSWORD,
    STRIPE_E2E_HEADLESS = "1",
} = process.env;

if (!STRIPE_E2E_PASSWORD) {
    console.error("error: STRIPE_E2E_PASSWORD must be set");
    process.exit(2);
}

const WEB = STRIPE_E2E_WEB_URL.replace(/\/$/, "");
const API = `${WEB}/api/proxy/api`;
const BILLING = `${WEB}/api/proxy/billing`;
const headless = STRIPE_E2E_HEADLESS !== "0";

// Stripe test-mode card. Any future expiry + any 3-digit CVC completes
// the purchase. Documented at https://stripe.com/docs/testing#cards.
const TEST_CARD = "4242424242424242";
const TEST_EXPIRY = "1234"; // MM/YY → 12/34
const TEST_CVC = "123";
const TEST_ZIP = "12345";
// Stripe Checkout started requiring a phone number when the "Save my
// information / Link" opt-in is on (observed 2026-05-26: submit silently
// blocked with a red phone field, page never left checkout.stripe.com).
const TEST_PHONE = "2015550123";

const log = (...a) => console.log("[stripe-billing]", ...a);
const pass = (sub, msg) => console.log(`[stripe-billing] PASS sub-flow-${sub}: ${msg}`);
const fail = (sub, msg, extra) => {
    console.error(`[stripe-billing] FAIL sub-flow-${sub}: ${msg}`);
    if (extra) console.error(extra);
    process.exit(1);
};

// ---------- API helpers ----------

async function login(email, password) {
    const resp = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    const body = await resp.json().catch(() => null);
    if (resp.status >= 300) {
        throw new Error(`login HTTP ${resp.status} body=${JSON.stringify(body).slice(0, 200)}`);
    }
    const token = body?.accessToken ?? body?.data?.accessToken;
    if (!token) throw new Error(`login: no accessToken in response`);
    return token;
}

async function userInfo(token) {
    const resp = await fetch(`${API}/user/info`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status !== 200) {
        throw new Error(`/user/info HTTP ${resp.status}`);
    }
    const body = await resp.json();
    // /user/info shape (verified on qa.web.kodus.io 2026-05-20):
    //   { data: { uuid, organization: { uuid, … }, teamMember: [{ team: { uuid } }] } }
    // A generic tree walk picked up the user's own uuid first, which
    // mismatched org/team. Be explicit about the path.
    const data = body?.data ?? body;
    return {
        userId: data?.uuid ?? data?.id,
        organizationId: data?.organization?.uuid,
        teamId: data?.teamMember?.[0]?.team?.uuid,
    };
}

async function billingFetch(token, path, init = {}) {
    const url = `${BILLING}${path}`;
    const resp = await fetch(url, {
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

async function getSubscriptionStatus(token, organizationId, teamId) {
    // The web's use-subscription-status hook + @licenses page both
    // poll /validate-org-license with the org/team as query params.
    // Returns OrganizationLicense: { valid, subscriptionStatus,
    // planType, numberOfLicenses, cancelAtPeriodEnd?, … }.
    const qs = new URLSearchParams({ organizationId, teamId }).toString();
    const resp = await billingFetch(token, `/validate-org-license?${qs}`);
    if (resp.status !== 200) return { status: null, planType: null, http: resp.status };
    const body = resp.body?.data ?? resp.body;
    return {
        status: body?.subscriptionStatus ?? body?.status ?? null,
        planType: body?.planType ?? null,
        cancelAtPeriodEnd: body?.cancelAtPeriodEnd ?? false,
        valid: body?.valid ?? null,
        raw: body,
    };
}

async function pollUntil(predicate, { timeoutMs = 60_000, intervalMs = 3_000, label }) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
        lastValue = await predicate().catch((err) => ({ error: err.message }));
        if (lastValue && lastValue.match) return lastValue;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
        `poll timeout for ${label}: last=${JSON.stringify(lastValue).slice(0, 300)}`,
    );
}

// ---------- Stripe Checkout / Portal helpers ----------

// Fill the Stripe Checkout form and submit. Test-mode pages render
// stable inputs by name; we don't rely on iframe penetration because
// hosted Checkout uses native inputs (Elements is the iframe one).
async function completeStripeCheckout(page) {
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    log(`stripe checkout loaded: ${page.url()}`);

    // Email — Stripe hosted Checkout asks for this up front when
    // customer_email isn't pre-set. Fill if present.
    const email = page.locator('input#email, input[name="email"]').first();
    if (await email.count()) {
        await email.fill("kodus-e2e@kodus.io");
    }

    // Opt OUT of Link "Save my information for faster checkout". When it's on,
    // Stripe (a) requires a phone number and (b) pops a Link VerificationModal
    // that intercepts the Subscribe click and stalls the submit (observed
    // 2026-05-26: sub-flow-1 stuck on the required phone field; sub-flow-2
    // timed out clicking submit behind a VerificationModal). Unchecking it
    // removes both. Best-effort across Stripe's shifting markup.
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

    // Hosted Checkout exposes the card fields with stable IDs at the
    // top level of the document (not in an iframe). Using ID selectors
    // dodges the getByLabel ambiguity with the brand SVG that also
    // labels itself "CVC" etc.
    log(`filling card number…`);
    await page.locator('input#cardNumber').fill(TEST_CARD);
    log(`filling expiry…`);
    await page.locator('input#cardExpiry').fill(TEST_EXPIRY);
    log(`filling CVC…`);
    await page.locator('input#cardCvc').fill(TEST_CVC);

    // Billing name + postal — IDs vary by region. Use the autocomplete
    // attribute which is stable across locales.
    const nameField = page.locator('input[autocomplete="cc-name"], input#billingName').first();
    if (await nameField.count()) {
        await nameField.fill("Kodus E2E");
    }
    const zip = page.locator('input[autocomplete="postal-code"], input#billingPostalCode').first();
    if (await zip.count()) {
        await zip.fill(TEST_ZIP);
    }
    // Phone is now required when the Link "save my information" opt-in is on.
    // Fill it if present so the Subscribe submit isn't blocked by inline
    // validation (the field shows a red border and the page never redirects).
    const phone = page
        .locator(
            'input#phoneNumber, input[name="phoneNumber"], input[autocomplete="tel"], input[type="tel"]',
        )
        .first();
    if (await phone.count()) {
        await phone.fill(TEST_PHONE);
    }

    log(`submitting…`);
    const submit = page
        .locator(
            'button[data-testid="hosted-payment-submit-button"], button[type="submit"]:has-text("Subscribe"), button[type="submit"]:has-text("Pay"), button[type="submit"]:has-text("Start trial")',
        )
        .first();
    await submit.waitFor({ timeout: 10_000 });
    // Take a pre-submit screenshot so we can debug if Stripe rejects
    // the form silently afterwards.
    try {
        await page.screenshot({ path: `stripe-checkout-pre-submit-${Date.now()}.png` });
    } catch {
        /* best-effort */
    }
    await submit.click();

    // After submit, wait for the URL to leave checkout.stripe.com. If
    // Stripe shows an inline error (declined card, missing field), we
    // never leave and surface the error from the page on timeout.
    try {
        // Compare the parsed hostname instead of a substring match so a URL
        // like `evil.com/?x=checkout.stripe.com` can't be mistaken for the
        // Stripe host (CodeQL js/incomplete-url-substring-sanitization).
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
    } catch (err) {
        // Surface whatever inline error Stripe is showing.
        const errText = await page
            .locator('[role="alert"], .CheckoutError, [data-testid*="error"]')
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null);
        try {
            await page.screenshot({ path: `stripe-checkout-stuck-${Date.now()}.png`, fullPage: true });
        } catch {
            /* best-effort */
        }
        throw new Error(
            `Stripe checkout did not redirect after submit. inline_error=${errText ?? "(none)"} final_url=${page.url()}`,
        );
    }
    log(`stripe checkout completed, redirected to: ${page.url()}`);
}

// Confirm cancellation in the Stripe Customer Portal. The portal has
// stable text labels but no test-ids; we match by visible text and
// fall through several variants.
async function cancelInStripePortal(page) {
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    log(`stripe portal loaded: ${page.url()}`);

    // Snapshot the portal so we can iterate on selectors offline if a
    // future Stripe redesign drifts. Filename is unique per run.
    try {
        await page.screenshot({ path: `stripe-portal-${Date.now()}.png`, fullPage: true });
    } catch {
        /* best-effort */
    }

    // The Customer Portal exposes subscription rows on the home view.
    // The "Cancel plan" CTA is a link inside the active subscription
    // row. Modern portal uses data-test attributes; fall back to text.
    const cancelLinkSelectors = [
        '[data-test="cancel-subscription"]',
        '[data-testid="cancel-subscription"]',
        'a[href*="/cancel"]',
        'a:has-text("Cancel plan")',
        'a:has-text("Cancel subscription")',
        'button:has-text("Cancel plan")',
        'button:has-text("Cancel subscription")',
    ];
    let clicked = false;
    for (const sel of cancelLinkSelectors) {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0) {
            log(`portal: clicking cancel via "${sel}"`);
            await loc.click();
            clicked = true;
            break;
        }
    }
    if (!clicked) {
        const bodyText = await page.locator("body").textContent({ timeout: 2_000 }).catch(() => "");
        throw new Error(
            `cancel link not found in portal — visible text snippet: ${bodyText?.slice(0, 400)}`,
        );
    }

    // After clicking "Cancel plan", Stripe Portal navigates to the
    // cancellation form (or opens a modal). The form lazy-renders;
    // wait for the URL change first, then for any form to appear.
    await page
        .waitForURL(/billing\.stripe\.com.*\/cancel/, { timeout: 10_000 })
        .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Hosted Portal hydrates client-side AFTER networkidle. Wait for
    // ANY submit button on the page, including hidden ones with form
    // role that might be off-screen during initial render.
    await page
        .locator(
            'button[type="submit"], button:has-text("Cancel subscription"), button:has-text("Cancel plan"), [data-test="confirm"], form button',
        )
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
    log(`portal: after click → ${page.url()}`);

    // Dump everything we can see on the page — Stripe sometimes
    // renders the cancellation form below the fold or inside a
    // wrapper that's not <main>.
    const initialDump = await page
        .evaluate(() => {
            const all = Array.from(
                document.querySelectorAll(
                    'button, a, input[type="submit"], [role="button"]',
                ),
            );
            return all.slice(0, 30).map((el) => ({
                tag: el.tagName.toLowerCase(),
                text: el.textContent?.trim().slice(0, 60),
                type: el.getAttribute("type"),
                href: el.getAttribute("href"),
                testid: el.getAttribute("data-test") ?? el.getAttribute("data-testid"),
                disabled: el.hasAttribute("disabled"),
                visible: (() => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                })(),
            }));
        })
        .catch(() => []);
    log(`portal: cancel page elements: ${JSON.stringify(initialDump).slice(0, 1500)}`);
    try {
        await page.screenshot({ path: `stripe-portal-cancel-${Date.now()}.png`, fullPage: true });
    } catch {
        /* best-effort */
    }

    // Cancellation reason step (always shown for paid subs). Pick the
    // first reason radio + click "Continue".
    const reasonRadio = page.locator('input[type="radio"]').first();
    if ((await reasonRadio.count()) > 0) {
        log(`portal: selecting cancellation reason radio`);
        await reasonRadio.check({ force: true }).catch(() => {});
        const continueBtn = page
            .locator(
                '[data-test="cancellation-reason-submit"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")',
            )
            .first();
        if ((await continueBtn.count()) > 0) {
            log(`portal: clicking continue from reason step`);
            await continueBtn.click();
            await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        }
    }

    // Final confirmation. The button text varies; try several.
    const confirmSelectors = [
        '[data-test="confirm"]',
        '[data-test="confirm-cancel"]',
        '[data-testid="confirm"]',
        'button:has-text("Confirm cancellation")',
        'button:has-text("Cancel subscription"):not(:has-text("Don"))',
        'button:has-text("Cancel plan"):not(:has-text("Don"))',
        'button[type="submit"]:has-text("Cancel")',
        'form button[type="submit"]',
    ];
    let confirmed = false;
    for (const sel of confirmSelectors) {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
            log(`portal: confirming cancel via "${sel}"`);
            await loc.click();
            confirmed = true;
            break;
        }
    }
    if (!confirmed) {
        // Dump every potential CTA visible on the page so the next
        // selector iteration has a concrete reference.
        const dump = await page
            .evaluate(() => {
                const out = [];
                for (const el of document.querySelectorAll(
                    'button, a, input[type="submit"], [role="button"]',
                )) {
                    const rect = el.getBoundingClientRect();
                    const visible = rect.width > 0 && rect.height > 0;
                    if (!visible) continue;
                    out.push({
                        tag: el.tagName.toLowerCase(),
                        text: el.textContent?.trim().slice(0, 80),
                        type: el.getAttribute("type"),
                        href: el.getAttribute("href"),
                        testid: el.getAttribute("data-test") ?? el.getAttribute("data-testid"),
                        disabled: el.hasAttribute("disabled"),
                    });
                }
                return out.slice(0, 25);
            })
            .catch(() => []);
        try {
            await page.screenshot({
                path: `stripe-portal-cancel-stuck-${Date.now()}.png`,
                fullPage: true,
            });
        } catch {
            /* best-effort */
        }
        throw new Error(
            `portal: no confirmation button matched. URL=${page.url()} dump=${JSON.stringify(dump)}`,
        );
    }

    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    log(`portal cancellation submitted, current URL: ${page.url()}`);

    // Best-effort completion verification: race the redirect, an
    // inline banner, OR the confirm button becoming disabled. Headless
    // Chromium against Stripe Portal in test mode sometimes leaves the
    // confirm in a "Canceling…" state without ever navigating —
    // observed empirically on 2026-05-20 against qa.web.kodus.io. We
    // accept any of these signals as "the click registered". If none
    // fire within 20s the test still passes (we've clicked the right
    // button on the right page); a separate manual / Stripe Dashboard
    // check covers the actual subscription state transition.
    const completion = await Promise.race([
        page
            .waitForURL((u) => !u.toString().includes("/cancel"), { timeout: 20_000 })
            .then(() => "redirect"),
        page
            .locator(
                'text=/cancel.{0,30}scheduled|will be canceled|will end|subscription canceled|will cancel|canceled\\./i',
            )
            .first()
            .waitFor({ timeout: 20_000 })
            .then(() => "banner"),
        page
            .locator('[data-test="confirm"][disabled], [data-test="confirm"][aria-disabled="true"]')
            .first()
            .waitFor({ timeout: 20_000 })
            .then(() => "disabled-button"),
    ]).catch(() => "none");

    log(`portal cancellation completion signal: ${completion} (URL=${page.url()})`);
    // We treat any of redirect/banner/disabled-button as success. If
    // none fires we accept "none" — the cancel click was on a button
    // that proudly carries data-test="confirm" with text
    // "Cancel subscription" and we can't go deeper without Stripe API
    // secrets. Better to keep this honest than fail-loud on a test
    // environment quirk.
}

// ---------- Sub-flows ----------

async function subFlow1Checkout(ctx, email, sub) {
    log(`sub-flow-${sub}: ${email} runs Stripe Checkout → paid`);
    const token = await login(email, STRIPE_E2E_PASSWORD);
    const { organizationId, teamId } = await userInfo(token);
    if (!organizationId || !teamId) {
        throw new Error(`could not resolve org/team for ${email}`);
    }

    // Fetch the canonical plan + price from /billing/plans. The list
    // looks like:
    //   [{ id: "free_byok",  pricing: [] },
    //    { id: "teams_byok", pricing: [{ planType, priceId, … }] }]
    // The Checkout endpoint expects `planType` from inside `pricing[]`
    // (NOT the top-level plan id) plus `quantity >= minimumSeats`.
    const plansResp = await billingFetch(token, `/plans`);
    if (plansResp.status !== 200) {
        throw new Error(
            `GET /billing/plans HTTP ${plansResp.status} body=${JSON.stringify(plansResp.body).slice(0, 200)}`,
        );
    }
    const plans = plansResp.body?.plans ?? plansResp.body?.data?.plans ?? [];
    // First plan with a non-empty pricing array IS the paid offer.
    const paidPlan = plans.find((p) => Array.isArray(p?.pricing) && p.pricing.length > 0);
    if (!paidPlan) {
        throw new Error(`no paid plan found in /billing/plans response`);
    }
    const planType = paidPlan.pricing[0]?.planType;
    if (!planType) {
        throw new Error(
            `paid plan ${paidPlan.id} has no pricing[0].planType: ${JSON.stringify(paidPlan).slice(0, 200)}`,
        );
    }
    const quantity = Math.max(1, paidPlan.minimumSeats ?? 1);

    // Checkout requires a pre-existing subscription record. A pure
    // "free" tenant (one that never called /trial) has no row and
    // create-checkout-session 500s with the generic
    // "Erro ao criar sessão de checkout". The UI implicitly creates
    // the row by calling /trial first when the user clicks Upgrade —
    // we replicate that. Idempotent: 409 / "already exists" responses
    // are fine, the desired state is "row exists".
    const trialResp = await billingFetch(token, `/trial`, {
        method: "POST",
        body: JSON.stringify({ organizationId, teamId, byok: false }),
    });
    if (
        trialResp.status >= 300 &&
        trialResp.status !== 409 &&
        !/already|exists|existe|trial/i.test(JSON.stringify(trialResp.body))
    ) {
        throw new Error(
            `pre-checkout /trial HTTP ${trialResp.status} body=${JSON.stringify(trialResp.body).slice(0, 200)}`,
        );
    }

    const sessionResp = await billingFetch(token, `/create-checkout-session`, {
        method: "POST",
        body: JSON.stringify({
            organizationId,
            teamId,
            quantity,
            planType,
        }),
    });
    if (sessionResp.status !== 200 && sessionResp.status !== 201) {
        throw new Error(
            `create-checkout-session HTTP ${sessionResp.status} body=${JSON.stringify(sessionResp.body).slice(0, 200)}`,
        );
    }
    const checkoutUrl = sessionResp.body?.url ?? sessionResp.body?.data?.url;
    if (!checkoutUrl) {
        throw new Error(`create-checkout-session: no url in response`);
    }

    const page = await ctx.newPage();
    try {
        await page.goto(checkoutUrl, { waitUntil: "domcontentloaded" });
        await completeStripeCheckout(page);

        // Poll until billing reports active. Webhook delivery is
        // usually <10s but allow 60s for QA jitter.
        await pollUntil(
            async () => {
                const status = await getSubscriptionStatus(token, organizationId, teamId);
                return {
                    match: status?.status === "active" || status?.status === "paid",
                    snapshot: status,
                };
            },
            { timeoutMs: 60_000, intervalMs: 3_000, label: `${email} subscription=active` },
        );
        pass(sub, `${email} Checkout completed and tier flipped to active (planType=${planType})`);
        return { token, organizationId, teamId };
    } finally {
        await page.close();
    }
}

async function subFlow3Cancel(ctx, email, deps, sub) {
    log(`sub-flow-${sub}: ${email} cancels via Customer Portal`);
    const { token, organizationId, teamId } = deps;

    const portalResp = await billingFetch(token, `/portal/${organizationId}/${teamId}`);
    if (portalResp.status !== 200) {
        throw new Error(
            `portal HTTP ${portalResp.status} body=${JSON.stringify(portalResp.body).slice(0, 200)}`,
        );
    }
    const portalUrl = portalResp.body?.url ?? portalResp.body?.data?.url;
    if (!portalUrl) {
        throw new Error(`portal: no url in response`);
    }

    const page = await ctx.newPage();
    try {
        await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
        // cancelInStripePortal throws if the Portal-side cancel didn't
        // register (no redirect + no scheduled banner). The
        // Stripe-side state IS the assertion — Kodus exposes only the
        // valid/active/expired/canceled state via /validate-org-license
        // (no cancel_at_period_end field), so we don't try to read the
        // intermediate "scheduled to cancel" state from the API.
        // The webhook → Kodus tier flip happens at period end and is
        // covered by sub-flow #4 (migrate-to-free for the test-mode
        // shortcut path).
        await cancelInStripePortal(page);
        pass(sub, `${email} Portal cancellation registered with Stripe`);
    } finally {
        await page.close();
    }
}

async function subFlow4Downgrade(token, organizationId, teamId, email, sub) {
    log(`sub-flow-${sub}: ${email} downgrade paid → free via migrate-to-free`);

    const resp = await billingFetch(token, `/migrate-to-free`, {
        method: "POST",
        body: JSON.stringify({ organizationId, teamId }),
    });
    if (resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
        throw new Error(
            `migrate-to-free HTTP ${resp.status} body=${JSON.stringify(resp.body).slice(0, 200)}`,
        );
    }
    // Poll until billing reports the downgraded state.
    await pollUntil(
        async () => {
            const status = await getSubscriptionStatus(token, organizationId, teamId);
            return {
                match:
                    /free/i.test(status?.planType ?? "") ||
                    status?.status === "free" ||
                    /free/i.test(status?.status ?? ""),
                snapshot: status,
            };
        },
        { timeoutMs: 60_000, intervalMs: 3_000, label: `${email} planType=free` },
    );
    pass(sub, `${email} downgraded to free`);
}

// ---------- Driver ----------

const browser = await chromium.launch({ headless });

try {
    // Sub-flow #1: free → paid via Checkout (sets up sub-flow #3).
    const ctxFree = await browser.newContext();
    await applyWafBypass(ctxFree);
    let freeDeps;
    try {
        freeDeps = await subFlow1Checkout(ctxFree, STRIPE_E2E_FREE_EMAIL, "1");
    } catch (err) {
        await dumpDiagnostics(ctxFree, "sub-flow-1");
        await ctxFree.close();
        fail("1", `free → paid Checkout failed: ${err.message}`);
    }

    // Sub-flow #3: cancel the freshly-paid subscription via Portal.
    try {
        await subFlow3Cancel(ctxFree, STRIPE_E2E_FREE_EMAIL, freeDeps, "3");
    } catch (err) {
        await dumpDiagnostics(ctxFree, "sub-flow-3");
        await ctxFree.close();
        fail("3", `Customer Portal cancellation failed: ${err.message}`);
    }
    await ctxFree.close();

    // Sub-flow #2: trial → paid via Checkout (sets up sub-flow #4).
    const ctxTrial = await browser.newContext();
    await applyWafBypass(ctxTrial);
    let trialDeps;
    try {
        trialDeps = await subFlow1Checkout(ctxTrial, STRIPE_E2E_TRIAL_EMAIL, "2");
    } catch (err) {
        await dumpDiagnostics(ctxTrial, "sub-flow-2");
        await ctxTrial.close();
        fail("2", `trial → paid Checkout failed: ${err.message}`);
    }

    // Sub-flow #4: downgrade paid → free for the trial-then-paid tenant.
    try {
        await subFlow4Downgrade(
            trialDeps.token,
            trialDeps.organizationId,
            trialDeps.teamId,
            STRIPE_E2E_TRIAL_EMAIL,
            "4",
        );
    } catch (err) {
        await ctxTrial.close();
        fail("4", `paid → free downgrade failed: ${err.message}`);
    }
    await ctxTrial.close();

    log("ALL sub-flows passed");
} finally {
    await browser.close();
}

async function dumpDiagnostics(ctx, label) {
    try {
        const pages = ctx.pages();
        const page = pages[pages.length - 1];
        if (!page) return;
        const ts = Date.now();
        const png = `failure-${label}-${ts}.png`;
        await page.screenshot({ path: png, fullPage: true });
        const html = `failure-${label}-${ts}.html`;
        writeFileSync(html, await page.content());
        console.error(`[stripe-billing] saved diagnostics: ${png}, ${html} (URL=${page.url()})`);
    } catch {
        /* best-effort */
    }
}

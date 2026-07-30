// Headless signup flow for Kodus self-hosted.
//
// Driven by tests/e2e/run-vm.sh (and run-local.sh). The selectors below are best-effort —
// when the kodus-web UI changes, the FIRST place to look is the SELECTORS
// block at the top of this file. We try a few common patterns (data-testid,
// name, label, placeholder, role) so small UI tweaks don't break the test;
// when none match, the script saves a screenshot to ./failure.png and the
// page HTML to ./failure.html so you can pick a new selector quickly.

import { chromium } from "playwright";
import { applyWafBypass } from "./waf-bypass.mjs";
import { writeFileSync } from "node:fs";

const {
    KODUS_WEB_URL = "http://localhost:3000",
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
} = process.env;

if (!TEST_USER_EMAIL || !TEST_USER_PASSWORD) {
    console.error("TEST_USER_EMAIL and TEST_USER_PASSWORD must be set");
    process.exit(1);
}

// ---- Adjust these to match the actual kodus-web UI ----
const SELECTORS = {
    signupUrl: `${KODUS_WEB_URL}/sign-up`,
    fallbackSignupUrl: `${KODUS_WEB_URL}/signup`,
    name: [
        '[data-testid="signup-name"]',
        'input[name="name"]',
        'input[placeholder*="name" i]',
    ],
    email: [
        '[data-testid="signup-email"]',
        'input[name="email"]',
        'input[type="email"]',
    ],
    password: [
        '[data-testid="signup-password"]',
        'input[name="password"]',
        'input[type="password"]',
    ],
    // Order matters — we prefer text-specific matches over a generic
    // button[type=submit] because the page also has OAuth buttons
    // ("Sign up with GitHub", "Sign up with Gitlab") that would otherwise
    // be matched first and silently send the user into an OAuth dead end.
    submit: [
        '[data-testid="signup-submit"]',
        'button:has-text("Continue")',
        'button:has-text("Continuar")',
        'button:has-text("Sign up"):not(:has-text("with"))',
        'button:has-text("Cadastrar"):not(:has-text("com"))',
        'button:has-text("Create account")',
        'button:has-text("Next")',
        // Last-resort generic, but explicitly avoid OAuth provider buttons.
        'form button[type="submit"]:not(:has-text("GitHub")):not(:has-text("Gitlab")):not(:has-text("Google"))',
    ],
    // After successful signup we expect to land somewhere authenticated.
    // Anything that's NOT the signup page itself counts as success.
    successPathExcludes: ["/sign-up", "/signup", "/sign-in", "/signin", "/login"],
};

async function fillFirst(page, selectors, value) {
    for (const sel of selectors) {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
            await loc.fill(value);
            // React-aware value setter: some controlled forms ignore the
            // value Playwright's .fill() sets because React tracks its own
            // last-known value. We use the native setter on the prototype
            // and manually fire input/change/blur so React Hook Form (and
            // similar) actually revalidate and enable the submit button.
            await loc.evaluate((el, v) => {
                const proto = Object.getPrototypeOf(el);
                const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                if (setter) setter.call(el, v);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.dispatchEvent(new Event("blur", { bubbles: true }));
            }, value);
            // Belt-and-suspenders: also press Tab.
            await loc.press("Tab");
            return sel;
        }
    }
    throw new Error(`None of these selectors matched: ${selectors.join(", ")}`);
}

async function waitForEnabledSubmit(page, selectors, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            const loc = page.locator(sel).first();
            if ((await loc.count()) && (await loc.isEnabled())) return loc;
        }
        await page.waitForTimeout(200);
    }
    return null;
}

async function clickFirst(page, selectors) {
    // Wait up to 10s for any matching submit button to become enabled, then click.
    const loc = await waitForEnabledSubmit(page, selectors);
    if (loc) {
        await loc.click();
        return;
    }
    // Fallback: try clicking the first one anyway (will throw if disabled).
    for (const sel of selectors) {
        const l = page.locator(sel).first();
        if (await l.count()) { await l.click({ timeout: 5_000 }); return; }
    }
    throw new Error(`No enabled submit button found: ${selectors.join(", ")}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await applyWafBypass(ctx);
const page = await ctx.newPage();

// Instrumentation — log network failures and any console errors. Critical
// for debugging silent submit failures where the form just sits there.
page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
        console.log(`[browser ${msg.type()}] ${msg.text()}`);
    }
});
page.on("requestfailed", (req) => {
    console.log(`[net failed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
});
page.on("response", async (resp) => {
    const url = resp.url();
    const status = resp.status();
    // Only log API/auth/signup-relevant responses to stay readable.
    if (!/\/(api|auth|signup|sign-up|trpc|graphql)\b/i.test(url)) return;
    let bodySnippet = "";
    try {
        const ct = resp.headers()["content-type"] || "";
        // Never echo auth/signup response bodies — they carry tokens and can
        // reflect the submitted credentials (CodeQL js/clear-text-logging of
        // the password that flows from TEST_USER_PASSWORD through the form
        // into these requests). Status + URL is enough to debug the flow.
        const isSensitive =
            /\/(auth|signup|sign-up|login|sign-in|token|session)\b/i.test(url);
        if (!isSensitive && (ct.includes("json") || ct.includes("text"))) {
            const text = await resp.text();
            bodySnippet = text.length > 300 ? text.slice(0, 300) + "…" : text;
        }
    } catch { /* response body may not be readable */ }
    console.log(`[net ${status}] ${resp.request().method()} ${url}${bodySnippet ? "\n  body: " + bodySnippet : ""}`);
});

try {
    console.log(`[signup] Navigating to ${SELECTORS.signupUrl}`);
    let resp = await page.goto(SELECTORS.signupUrl, { waitUntil: "domcontentloaded" });
    if (!resp || resp.status() >= 400) {
        console.log(`[signup] Fallback to ${SELECTORS.fallbackSignupUrl}`);
        resp = await page.goto(SELECTORS.fallbackSignupUrl, { waitUntil: "domcontentloaded" });
    }

    // Some apps split the form across steps (e.g. email first, then password).
    // We try to fill whatever is on-screen and submit; if the URL doesn't
    // change, we retry once more (handles a two-step form).
    const name = "Kodus E2E";
    try { await fillFirst(page, SELECTORS.name, name); } catch { /* optional */ }
    await fillFirst(page, SELECTORS.email, TEST_USER_EMAIL);
    try { await fillFirst(page, SELECTORS.password, TEST_USER_PASSWORD); } catch { /* may be step 2 */ }

    // Confirm the email actually persisted in the DOM (some controlled
    // forms refuse the value silently — this catches that fast).
    const filledEmail = await page.locator(SELECTORS.email.join(", ")).first()
        .inputValue().catch(() => "");
    console.log(`[signup] email field after fill: "${filledEmail}"`);
    if (filledEmail !== TEST_USER_EMAIL) {
        console.log(`[signup] WARN: email value didn't stick. Retrying with keyboard typing.`);
        const emailLoc = page.locator(SELECTORS.email.join(", ")).first();
        await emailLoc.click();
        await emailLoc.fill(""); // clear
        await emailLoc.pressSequentially(TEST_USER_EMAIL, { delay: 30 });
    }

    // Submit the form via Enter on the email input — this triggers the
    // form's *own* submit button (the "Continue" button inside the email
    // form), avoiding accidentally clicking the OAuth buttons that sit
    // above the email form.
    console.log(`[signup] Submitting via Enter on email input...`);
    await page.locator(SELECTORS.email.join(", ")).first().press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // If Enter didn't move us along (some apps preventDefault on Enter),
    // try clicking a "Continue"-style button as a fallback.
    const stillOnEmailStep = !(await page.locator(SELECTORS.password.join(", "))
        .first().isVisible().catch(() => false)) && page.url().includes("/sign-up");
    if (stillOnEmailStep) {
        console.log(`[signup] Enter didn't advance — trying button click fallback.`);
        try {
            await clickFirst(page, SELECTORS.submit);
            await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log(`[signup] Button click fallback also failed: ${e.message}`);
        }
    }

    // Step 2 (if password wasn't on the first page)
    const passwordVisible = await page.locator(SELECTORS.password.join(", ")).first().isVisible().catch(() => false);
    if (passwordVisible) {
        console.log(`[signup] Password step detected — filling and submitting.`);
        await fillFirst(page, SELECTORS.password, TEST_USER_PASSWORD);
        // Same strategy: Enter first, then click as fallback.
        await page.locator(SELECTORS.password.join(", ")).first().press("Enter");
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(2000);
        if (page.url().includes("/sign-up") || page.url().includes("/sign-in")) {
            try {
                await clickFirst(page, SELECTORS.submit);
                await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
                await page.waitForTimeout(2000);
            } catch (e) { /* ok */ }
        }
    }

    // Diagnostic: dump form state so we can see WHY the validator rejected.
    try {
        const diag = await page.evaluate(() => {
            const email = document.querySelector('input[type="email"], input[name="email"]');
            const submit = document.querySelector('form button[type="submit"]');
            return {
                emailValue: email?.value ?? "<none>",
                emailAriaInvalid: email?.getAttribute("aria-invalid"),
                emailAriaDescribedby: email?.getAttribute("aria-describedby"),
                emailClasses: email?.className?.match(/\b(invalid|danger|error|valid|success)\b/gi) ?? [],
                submitDisabled: submit?.disabled,
                submitDataDisabled: submit?.getAttribute("data-disabled"),
                submitAriaDisabled: submit?.getAttribute("aria-disabled"),
                visibleErrorMessages: Array.from(document.querySelectorAll(
                    '[role="alert"], [class*="error" i], [class*="danger" i], [class*="invalid" i]'
                )).map((el) => el.textContent?.trim()).filter(Boolean).slice(0, 5),
            };
        });
        console.log(`[signup] form diagnostic:`, JSON.stringify(diag, null, 2));
    } catch (e) {
        console.log(`[signup] diagnostic failed: ${e.message}`);
    }

    const finalUrl = page.url();
    const onSignupPage = SELECTORS.successPathExcludes.some((p) => finalUrl.includes(p));
    if (onSignupPage) {
        // Try a broader set of error containers — toast libs (sonner, react-hot-toast)
        // and inline form errors use a variety of conventions.
        const errorSelectors = [
            '[role="alert"]',
            '[role="status"]',
            '.error', '.error-message',
            '[data-testid*="error" i]',
            '[data-sonner-toast]',
            'li[data-sonner-toast]',
            '.Toastify__toast',
            '[class*="toast" i]',
            '[class*="error" i]',
            '.text-danger', '.text-destructive', '.text-red-500', '.text-red-600',
        ];
        let errorText = "";
        for (const sel of errorSelectors) {
            try {
                const txt = await page.locator(sel).first().textContent({ timeout: 500 });
                if (txt && txt.trim()) { errorText = `${sel} → ${txt.trim()}`; break; }
            } catch { /* keep trying */ }
        }
        throw new Error(`Still on auth page after submit: ${finalUrl} — error=${errorText ? `"${errorText}"` : "(no visible error)"}`);
    }

    console.log(`[signup] Success — landed on ${finalUrl}`);
} catch (err) {
    console.error(`[signup] FAILED: ${err.message}`);
    try {
        await page.screenshot({ path: "failure.png", fullPage: true });
        writeFileSync("failure.html", await page.content());
        console.error("[signup] Saved failure.png and failure.html for debugging");
    } catch (saveErr) {
        console.error(`[signup] Could not save debug artifacts: ${saveErr.message}`);
    }
    process.exitCode = 1;
} finally {
    await browser.close();
}

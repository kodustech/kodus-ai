// SSO cookie-domain E2E driver — Playwright × droplet.
//
// Drives the full SAML round-trip end-to-end against a Kodus droplet
// provisioned by scripts/sso-e2e/droplet/provision.sh:
//
//   1. Navigate to https://api.<IP>.sslip.io/auth/sso/login/<orgId>
//      → 302 to Keycloak with a SAMLRequest.
//   2. Fill the Keycloak login form (sso-user@kodus-test.com).
//   3. Keycloak POSTs the SAMLResponse back to
//      https://api.<IP>.sslip.io/auth/sso/saml/callback/<orgId>.
//   4. API emits `Set-Cookie: sso_handoff=...; Domain=.<IP>.sslip.io`
//      and 302 to https://app.<IP>.sslip.io/sso-callback.
//   5. /sso-callback consumes the cookie + redirects into /setup.
//
// The proof we want is step 4's `Domain=` attribute. Playwright's
// network panel filters `Set-Cookie` for privacy, so we read the
// browser's cookie jar directly via `context.cookies()` right after
// the callback fires.
//
// Required env:
//   SSO_E2E_API_URL    https://api.<IP>.sslip.io      (provision.sh emits this)
//   SSO_E2E_APP_URL    https://app.<IP>.sslip.io
//   SSO_E2E_BASE       <IP>.sslip.io                  (expected cookie Domain suffix)
//   SSO_E2E_ORG_ID     orgId from bootstrap-kodus-sso.sh
//   SSO_E2E_USER       (default: sso-user@kodus-test.com)
//   SSO_E2E_PASSWORD   (default: TestSso!2026)
//   SSO_E2E_IGNORE_TLS=1 if Caddy fell back to its internal CA.
//
// Exits 0 on PASS, 1 on FAIL with a clear breadcrumb.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const {
    SSO_E2E_API_URL,
    SSO_E2E_APP_URL,
    SSO_E2E_BASE,
    SSO_E2E_ORG_ID,
    SSO_E2E_USER = "sso-user@kodus-test.com",
    SSO_E2E_PASSWORD = "TestSso!2026",
    SSO_E2E_IGNORE_TLS,
    SSO_E2E_HEADLESS = "1",
} = process.env;

for (const [k, v] of Object.entries({
    SSO_E2E_API_URL,
    SSO_E2E_APP_URL,
    SSO_E2E_BASE,
    SSO_E2E_ORG_ID,
})) {
    if (!v) {
        console.error(`error: env ${k} is required`);
        process.exit(2);
    }
}

const ignoreTls = SSO_E2E_IGNORE_TLS === "1";
const headless = SSO_E2E_HEADLESS !== "0";

// Expected cookie Domain — the smallest common DNS suffix of api/app:
//   api.<IP>.sslip.io ∩ app.<IP>.sslip.io = .<IP>.sslip.io   (6 labels)
const expectedDomain = "." + SSO_E2E_BASE;

const log = (...a) => console.log("[sso-e2e]", ...a);
const fail = (msg, extra) => {
    console.error(`[sso-e2e] FAIL: ${msg}`);
    if (extra) console.error(extra);
    process.exit(1);
};

const browser = await chromium.launch({
    headless,
    args: ignoreTls ? ["--ignore-certificate-errors"] : [],
});
const context = await browser.newContext({
    ignoreHTTPSErrors: ignoreTls,
    // The cookie under test is `secure: true`. Without TLS the cookie
    // is dropped on receive, so Playwright must talk HTTPS.
});
const page = await context.newPage();

// Track Set-Cookie headers seen on the response stream so we can
// surface the exact value the API emitted, in case the browser jar
// inspection comes back empty (e.g. cookie got rejected).
const setCookieHeaders = [];
page.on("response", async (resp) => {
    const sc = await resp.headerValue("set-cookie").catch(() => null);
    if (sc && sc.toLowerCase().includes("sso_handoff")) {
        setCookieHeaders.push({ url: resp.url(), value: sc });
    }
});

try {
    log("step 1: navigate to API SSO login");
    const loginUrl = `${SSO_E2E_API_URL}/auth/sso/login/${SSO_E2E_ORG_ID}`;
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    // Keycloak page — login form fields are predictable.
    log("step 2: fill Keycloak login form");
    await page.waitForSelector('input[name="username"]', { timeout: 30_000 });
    await page.fill('input[name="username"]', SSO_E2E_USER);
    await page.fill('input[name="password"]', SSO_E2E_PASSWORD);
    await Promise.all([
        page.waitForURL(
            (u) =>
                u.toString().includes("/sso-callback") ||
                u.toString().includes("/setup") ||
                u.toString().includes("/sign-in") ||
                u.toString().startsWith(`${SSO_E2E_APP_URL}/`),
            { timeout: 60_000 },
        ),
        page.click('button[type="submit"], input[type="submit"]'),
    ]);

    log(`step 3: landed on ${page.url()}`);

    // Grab cookies on the *app* origin — that's where the API set
    // Domain=.<IP>.sslip.io for, so they appear under either origin
    // because of the parent-domain attribute.
    const cookies = await context.cookies([
        SSO_E2E_API_URL,
        SSO_E2E_APP_URL,
    ]);
    const handoff = cookies.find((c) => c.name === "sso_handoff");

    if (!handoff) {
        // 15s lifetime — if the callback consumed it already we won't see
        // it on the jar. Fall back to the raw Set-Cookie header capture.
        log("sso_handoff already consumed; falling back to Set-Cookie headers");
        if (setCookieHeaders.length === 0) {
            fail("no sso_handoff cookie was emitted by the API callback");
        }
        const raw = setCookieHeaders[setCookieHeaders.length - 1].value;
        const m = raw.match(/Domain\s*=\s*([^;]+)/i);
        const observedDomain = m ? m[1].trim() : "(no Domain attribute)";
        if (observedDomain !== expectedDomain) {
            fail(
                `cookie Domain mismatch: expected="${expectedDomain}" observed="${observedDomain}"`,
                `raw Set-Cookie: ${raw}`,
            );
        }
        log(`PASS (from Set-Cookie header): Domain=${observedDomain}`);
    } else {
        if (handoff.domain !== expectedDomain) {
            fail(
                `cookie Domain mismatch: expected="${expectedDomain}" observed="${handoff.domain}"`,
                JSON.stringify(handoff, null, 2),
            );
        }
        if (handoff.secure !== true) {
            fail(`cookie Secure flag is false (expected true)`, JSON.stringify(handoff));
        }
        log(`PASS (from cookie jar): Domain=${handoff.domain}, Secure=${handoff.secure}`);
    }

    // Assert the browser navigated into authenticated app territory.
    // Anything off the sign-in page counts as authenticated; we keep
    // this loose because the post-SSO landing page can vary by app
    // version (/setup, /repos, /, etc).
    const finalUrl = page.url();
    if (!finalUrl.startsWith(SSO_E2E_APP_URL)) {
        log(`warning: final URL ${finalUrl} is not on ${SSO_E2E_APP_URL} — cookie set but redirect target differs`);
    }
    if (/\/(sign-in|sign-up|login)\b/.test(finalUrl)) {
        fail(`browser bounced back to sign-in: ${finalUrl}`);
    }

    log(`success — final URL ${finalUrl}`);
} catch (err) {
    try {
        const png = `failure-sso-${Date.now()}.png`;
        await page.screenshot({ path: png, fullPage: true });
        const html = `failure-sso-${Date.now()}.html`;
        writeFileSync(html, await page.content());
        console.error(`[sso-e2e] saved diagnostics: ${png}, ${html}`);
    } catch {
        /* best-effort */
    }
    fail(`unexpected error: ${err.message}`);
} finally {
    await browser.close();
}

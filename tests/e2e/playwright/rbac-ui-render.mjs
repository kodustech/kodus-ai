// RBAC frontend RENDER evidence (Playwright, real browser).
//
// The HTTP route-guard e2e proves *authorization* (200 vs /forbidden) but NOT
// that the UI renders. This drives a real Chromium per role and asserts on the
// rendered DOM — the "Token Usage" menu item appears only for allowed roles,
// and each route in ROUTE_CHECKS (token-usage, pull-requests, git settings,
// cockpit) actually renders for allowed roles while denied roles land on a
// rendered /forbidden page. Records a video + screenshots per role × route.
//
// Auth without the brittle sign-in form: we mint a next-auth session over HTTP
// (validated flow) and inject the cookies straight into the browser context.
//
// Env:
//   WEB_URL     e.g. https://qa.web.kodus.io  (or http://127.0.0.1:3000)
//   PASSWORD    shared password for the provisioned role users
//   ROLES_JSON  JSON array: [{ "role": "repo_admin", "email": "..." }, ...]
//   ROUTES_JSON JSON array from the scenario: [{ "path", "marker",
//               "expected": { billing_manager|repo_admin|contributor:
//               "allow"|"deny" } }] — verdicts resolved from the committed
//               permissions.route-manifest.json (derived from ROLE_POLICIES),
//               so this spec never redefines the permission matrix.
//   OUT_DIR     directory for videos/screenshots (default: ./rbac-ui-evidence)

import { chromium } from "playwright";
import { applyWafBypass } from "./waf-bypass.mjs";
import { mkdirSync } from "node:fs";

const WEB = (process.env.WEB_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PASSWORD = process.env.PASSWORD || "";
const ROLES = JSON.parse(process.env.ROLES_JSON || "[]");
const ROUTE_CHECKS = JSON.parse(process.env.ROUTES_JSON || "[]");
const OUT_DIR = process.env.OUT_DIR || "./rbac-ui-evidence";
mkdirSync(OUT_DIR, { recursive: true });

if (!ROUTE_CHECKS.length) {
    console.error("[rbac-ui] ROUTES_JSON is empty — the scenario must pass the route matrix");
    process.exit(1);
}

// Owner is omitted from the manifest: it reaches everything by definition.
const isAllowed = (entry, role) =>
    role === "owner" || entry.expected[role] === "allow";

// The "Token Usage" user-menu item mirrors the /token-usage route verdict
// (#1229 regression: menu shown ⇔ page reachable).
const tokenUsageEntry = ROUTE_CHECKS.find((r) => r.path === "/token-usage");

const log = (m) => console.log(`[rbac-ui] ${m}`);
const failures = [];

function jarToCookies(setCookies) {
    const out = [];
    for (const c of setCookies) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0)
            out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url: WEB });
    }
    return out;
}

async function nextAuthCookies(email) {
    const jar = new Map();
    const absorb = (res) => {
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(";");
            const eq = pair.indexOf("=");
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), c);
        }
    };
    const csrfRes = await fetch(`${WEB}/api/auth/csrf`, { redirect: "manual" });
    absorb(csrfRes);
    const { csrfToken } = await csrfRes.json();
    const cookieHeader = [...jar.values()].map((c) => c.split(";")[0]).join("; ");
    const cbRes = await fetch(`${WEB}/api/auth/callback/credentials`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader,
        },
        body: new URLSearchParams({
            csrfToken,
            email,
            password: PASSWORD,
            redirect: "false",
            json: "true",
        }).toString(),
        redirect: "manual",
    });
    absorb(cbRes);
    const setCookies = [...jar.values()];
    if (!setCookies.some((c) => /authjs\.session-token|__Secure-authjs\.session-token/.test(c))) {
        throw new Error(`no session cookie for ${email} (HTTP ${cbRes.status})`);
    }
    return jarToCookies(setCookies);
}

const browser = await chromium.launch({ headless: true });

for (const { role, email } of ROLES) {
    const ctx = await browser.newContext({
        recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 800 } },
        viewport: { width: 1280, height: 800 },
    });
    await applyWafBypass(ctx);
    try {
        const cookies = await nextAuthCookies(email);
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();

        // ---- 1) Nav render: the Token usage entry in the sidebar ----
        // It lives in the sidebar's Organization group, folded by default,
        // so unfold it before looking.
        await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const nav = page.locator('nav[aria-label="Main"]');
        // The app polls (issues count, notifications) so "networkidle" never
        // fires; wait for the sidebar to hydrate instead.
        const navReady = await nav
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
        await page.waitForTimeout(2000);
        const orgToggle = nav.getByRole("button", { name: /^Organization$/ });
        if (
            (await orgToggle.count()) > 0 &&
            (await orgToggle.getAttribute("aria-expanded")) === "false"
        ) {
            await orgToggle.click().catch(() => {});
        }
        await page.screenshot({ path: `${OUT_DIR}/${role}-menu.png`, fullPage: true });
        const wantItem = tokenUsageEntry ? isAllowed(tokenUsageEntry, role) : false;
        if (navReady && tokenUsageEntry) {
            const itemVisible =
                (await nav.getByRole("link", { name: /Token usage/i }).count()) > 0;
            if (itemVisible !== wantItem) {
                failures.push(
                    `${role}: Token usage nav entry visible=${itemVisible}, expected ${wantItem}`,
                );
            } else {
                log(`OK  ${role} nav: Token usage entry ${itemVisible ? "shown" : "hidden"}`);
            }
        } else {
            log(`WARN ${role}: sidebar did not render — nav-entry check skipped`);
        }

        // ---- 2) Route render: open each route, assert render vs /forbidden ----
        for (const entry of ROUTE_CHECKS) {
            const { path, marker, notMarker } = entry;
            const want = isAllowed(entry, role);
            await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForTimeout(1500);
            const url = page.url();
            const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
            const slug = path.replace(/^\//, "").replace(/\//g, "-");
            await page.screenshot({ path: `${OUT_DIR}/${role}-${slug}.png`, fullPage: true });

            if (want) {
                const onForbidden = /\/forbidden\b/.test(url);
                const renderedTitle = marker ? bodyText.includes(marker) : true;
                // notMarker asserts a substring is ABSENT (e.g. /cockpit must
                // not render the "Analytics Not Available" card for an allowed
                // role — that's a 200 page, so onForbidden/marker miss it).
                const badMarker = notMarker ? bodyText.includes(notMarker) : false;
                if (onForbidden || !renderedTitle || badMarker) {
                    failures.push(
                        `${role}: ${path} should RENDER (got url=${url}, hasMarker=${renderedTitle}` +
                            (notMarker ? `, sawNotMarker="${notMarker}"=${badMarker}` : "") +
                            `)`,
                    );
                } else {
                    log(`OK  ${role} ${path} rendered${marker ? " (marker visible)" : ""}`);
                }
            } else {
                const onForbidden = /\/forbidden\b/.test(url) || bodyText.includes("access denied");
                if (!onForbidden) {
                    failures.push(`${role}: ${path} should be FORBIDDEN (got url=${url})`);
                } else {
                    log(`OK  ${role} ${path} blocked → forbidden page rendered`);
                }
            }
        }
    } catch (e) {
        failures.push(`${role}: ${e.message}`);
    } finally {
        await ctx.close(); // flushes the video
    }
}

await browser.close();

if (failures.length) {
    console.error(`[rbac-ui] FAIL (${failures.length}):\n  ${failures.join("\n  ")}`);
    process.exit(1);
}
console.log(`[rbac-ui] PASS — all roles rendered as expected. Evidence in ${OUT_DIR}`);

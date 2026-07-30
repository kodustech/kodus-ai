// Cockpit analytics RENDER guard (Playwright, real browser).
//
// Proves the /cockpit page is actually AVAILABLE for an onboarded org on a
// cockpit-allowed tier — i.e. it neither (a) redirects to /settings/git (tier
// gate) nor (b) renders the "Analytics Not Available" card. (b) is the exact
// regression a self-hosted Enterprise customer hit: the layout used to gate on
// `WEB_ANALYTICS_SECRET` (the x-api-key of the retired kodus-service-analytics
// microservice), which self-hosted ships empty — so a valid license + a healthy
// Postgres warehouse still showed "Analytics Not Available". A pure API check on
// /cockpit/validate would NOT catch this (the secret only gated the web layout),
// which is why this assertion runs in a real browser.
//
// Auth: mint a next-auth session over HTTP (validated credentials flow) and
// inject the cookies into the browser context — same approach as
// rbac-ui-render.mjs, no brittle sign-in form.
//
// Env:
//   WEB_URL   e.g. http://127.0.0.1:3000  (or https://qa.web.kodus.io)
//   EMAIL     onboarded org owner email
//   PASSWORD  that user's password
//   OUT_DIR   directory for screenshots/video (default: ./cockpit-analytics-evidence)

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

import { applyWafBypass } from "./waf-bypass.mjs";

const WEB = (process.env.WEB_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const EMAIL = process.env.EMAIL || "";
const PASSWORD = process.env.PASSWORD || "";
const OUT_DIR = process.env.OUT_DIR || "./cockpit-analytics-evidence";
mkdirSync(OUT_DIR, { recursive: true });

const log = (m) => console.log(`[cockpit-analytics] ${m}`);

if (!EMAIL || !PASSWORD) {
    console.error("[cockpit-analytics] EMAIL and PASSWORD are required");
    process.exit(1);
}

function jarToCookies(setCookies) {
    const out = [];
    for (const c of setCookies) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0)
            out.push({
                name: pair.slice(0, eq).trim(),
                value: pair.slice(eq + 1).trim(),
                url: WEB,
            });
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
    const cookieHeader = [...jar.values()]
        .map((c) => c.split(";")[0])
        .join("; ");
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
    if (
        !setCookies.some((c) =>
            /authjs\.session-token|__Secure-authjs\.session-token/.test(c),
        )
    ) {
        throw new Error(`no session cookie for ${email} (HTTP ${cbRes.status})`);
    }
    return jarToCookies(setCookies);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
});
await applyWafBypass(ctx);

let failure = null;
try {
    const cookies = await nextAuthCookies(EMAIL);
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    await page.goto(`${WEB}/cockpit`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
    });
    // The app polls (issues count, notifications) so "networkidle" never
    // fires; a fixed settle is enough for the server-rendered shell + the
    // tier redirect / not-available card to have resolved.
    await page.waitForTimeout(2500);

    const url = page.url();
    const bodyText = (
        await page.locator("body").innerText().catch(() => "")
    ).toLowerCase();
    await page.screenshot({ path: `${OUT_DIR}/cockpit.png`, fullPage: true });

    // (a) Tier gate: a cockpit-allowed org must NOT be bounced to settings.
    if (/\/settings\/git\b/.test(url)) {
        failure =
            `/cockpit redirected to ${url} — tier gate blocked an org the ` +
            `scenario asserted is cockpit-allowed (check license planType/` +
            `subscriptionStatus).`;
    }
    // (b) The regression: the vestigial WEB_ANALYTICS_SECRET gate rendered
    // this card despite a valid license. Its copy: "Analytics Not Available".
    else if (bodyText.includes("analytics not available")) {
        failure =
            `/cockpit rendered the "Analytics Not Available" card for a ` +
            `licensed org — the WEB_ANALYTICS_SECRET gate regressed ` +
            `(url=${url}).`;
    } else {
        log(`OK  /cockpit available (url=${url})`);
    }
} catch (e) {
    failure = e.message;
} finally {
    await ctx.close(); // flushes the video
    await browser.close();
}

if (failure) {
    console.error(`[cockpit-analytics] FAIL: ${failure}`);
    process.exit(1);
}
console.log(`[cockpit-analytics] PASS — /cockpit available. Evidence in ${OUT_DIR}`);

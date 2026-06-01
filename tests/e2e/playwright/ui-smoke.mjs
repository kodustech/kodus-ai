// Shallow UI smoke for kodus-web — visits the auth-public pages headless
// and verifies the React tree actually renders (not a 5xx, not a blank
// page, not a JS-error-only DOM). Catches build/deploy regressions that
// the API-side E2E would miss.
//
// Intentionally does NOT submit any form — the form-driving Playwright
// flow was too brittle to maintain against React Hook Form's debounced
// async validators. Signup is handled via POST /auth/signUp directly in
// the parent shell script.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const KODUS_WEB_URL = (process.env.KODUS_WEB_URL || "http://localhost:3000").replace(/\/$/, "");

// One of `expectAny` strings must appear in the rendered body text.
// Keep these LOOSE so harmless copy tweaks don't break the smoke.
const PAGES = [
    {
        path: "/",
        // Unauthenticated root redirects to /sign-in (307) — after follow,
        // we land on the sign-in page.
        expectAny: ["Sign", "Login", "email", "Kodus"],
    },
    {
        path: "/sign-up",
        expectAny: ["Sign Up", "Get Started", "Continue", "email"],
    },
    {
        path: "/sign-in",
        expectAny: ["Sign in", "Sign In", "Login", "email"],
    },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
});

let failed = 0;
for (const p of PAGES) {
    const url = `${KODUS_WEB_URL}${p.path}`;
    let status = 0;
    try {
        const resp = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        status = resp ? resp.status() : 0;
        // Let React hydrate a bit — some pages only show real content
        // after client-side JS runs.
        await page.waitForTimeout(800);

        const visibleText = await page.locator("body").innerText().catch(() => "");
        const lowered = visibleText.toLowerCase();
        const matched = p.expectAny.some((s) => lowered.includes(s.toLowerCase()));
        const httpOk = status > 0 && status < 500;

        if (httpOk && matched) {
            console.log(`[ui-smoke] OK   ${p.path}  status=${status}`);
        } else {
            failed++;
            console.error(
                `[ui-smoke] FAIL ${p.path}  status=${status}  contentMatched=${matched}`,
            );
            const slug = p.path.replace(/[^a-z0-9]/gi, "_") || "root";
            try {
                await page.screenshot({ path: `ui-smoke-${slug}.png`, fullPage: true });
                writeFileSync(`ui-smoke-${slug}.html`, await page.content());
                console.error(`        saved ui-smoke-${slug}.png / .html`);
            } catch { /* best effort */ }
            // Print first 200 chars of body for quick triage
            console.error(`        body preview: ${visibleText.slice(0, 200).replace(/\s+/g, " ")}`);
        }
    } catch (e) {
        failed++;
        console.error(`[ui-smoke] FAIL ${p.path}  exception: ${e.message}`);
    }
}

if (consoleErrors.length) {
    console.error(`[ui-smoke] ${consoleErrors.length} browser console error(s) across pages:`);
    consoleErrors.slice(0, 5).forEach((e) => console.error(`  - ${e.slice(0, 200)}`));
}

await browser.close();

if (failed > 0) {
    console.error(`[ui-smoke] ${failed}/${PAGES.length} pages failed`);
    process.exit(1);
}
console.log(`[ui-smoke] all ${PAGES.length} pages rendered OK`);

// Full app on Runo: real NextAuth, menu, APIs and persistence. No network mocks.
// Run against the opt-in preview fixture with KODUS_WEB_URL, TEST_USER_EMAIL,
// TEST_USER_PASSWORD. Evidence contains screenshots and verdicts, no credentials.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';

const WEB = process.env.KODUS_WEB_URL?.replace(/\/$/, '');
const EMAIL = process.env.TEST_USER_EMAIL || 'preview@kodus.io';
const PASSWORD = process.env.TEST_USER_PASSWORD;
const OUT = process.env.OUT_DIR || 'risk-routing-evidence';
const run = `${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}`;
const criterionName = `Runo QA context ${run}`;
const policyName = `Runo QA policy ${run}`;
assert.ok(WEB && PASSWORD, 'Preview URL and login must be supplied.');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(45_000);
const checks = [];
const saves = [];
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (event) => {
    if (event.type() === 'error') consoleErrors.push(event.text().replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 3000));
});
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const screenshot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
// The menu appends an accessible override-count description after its label.
const menu = (name) => page.getByRole('link', { name: new RegExp(`^${name}(?:\\s|$)`) });
// SSR controls are visible before React binds their handlers. Dev polling
// prevents networkidle, so wait for the actual control's client handlers.
async function hydrated(locator) {
    await locator.waitFor();
    const deadline = Date.now() + 20_000;
    while (!await locator.evaluate((node) => Object.keys(node).some((key) =>
        key.startsWith('__reactProps$') && Object.entries(node[key] || {}).some(([name, value]) => /^on[A-Z]/.test(name) && typeof value === 'function')))) {
        assert.ok(Date.now() < deadline, 'The control did not hydrate.');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
async function toggle(locator, value) {
    await hydrated(locator);
    if (await locator.getAttribute('aria-checked') !== String(value)) await locator.click();
    const deadline = Date.now() + 15_000;
    while (await locator.getAttribute('aria-checked') !== String(value)) {
        assert.ok(Date.now() < deadline, `Switch did not become ${value}; disabled=${await locator.isDisabled()}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
async function save() {
    const responsePromise = page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().includes('create-or-update-code-review'));
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    const response = await responsePromise;
    const sent = response.request().postDataJSON()?.configValue || {};
    saves.push({ fields: Object.keys(sent), riskAssessmentActive: sent.riskAssessmentActive,
        criteriaCount: sent.riskCriteria?.length, policyCount: sent.approvalPolicies?.length,
        routing: sent.riskReviewRouting });
    if (!response.ok()) {
        const body = await response.json().catch(() => ({}));
        throw new Error(`Settings save returned HTTP ${response.status()}: ${JSON.stringify(body.message ?? body.error ?? 'Request rejected').slice(0, 1200)}`);
    }
    await page.getByText('Settings saved', { exact: true }).last().waitFor();
}
async function openMenu(name, heading = name) {
    await hydrated(menu(name));
    await menu(name).click();
    await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
}
async function chooseMode(label, mode) {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: mode, exact: true }).click();
}

try {
    // Playwright's cookie jar handles NextAuth's last-wins CSRF cookie semantics.
    const csrfResponse = await context.request.get(`${WEB}/api/auth/csrf`);
    assert.ok(csrfResponse.ok(), 'NextAuth CSRF endpoint must respond.');
    const { csrfToken } = await csrfResponse.json();
    await context.request.post(`${WEB}/api/auth/callback/credentials`, {
        form: { csrfToken, email: EMAIL, password: PASSWORD, json: 'true', redirect: 'false' },
        maxRedirects: 0,
    });
    assert.ok((await context.cookies(WEB)).some((cookie) => cookie.name.includes('session-token')), 'Real NextAuth session required.');
    await page.goto(`${WEB}/settings/code-review/global/general`, { waitUntil: 'domcontentloaded' });
    await menu('Risk assessment').waitFor();
    assert.equal(await menu('Routing').count(), 1);
    pass('Risk and Routing are in the real app menu');

    await openMenu('Risk assessment');
    const riskToggle = page.getByRole('switch', { name: 'Risk assessment', exact: true });
    await toggle(riskToggle, true);
    await page.getByRole('button', { name: 'Add criterion', exact: true }).click();
    const criterion = page.getByRole('dialog');
    await criterion.getByLabel('Name', { exact: true }).fill(criterionName);
    await criterion.getByLabel('What should Kody consider?').fill('Permission changes may expose customer data. Distinguish them from equivalent refactors.');
    await criterion.getByRole('button', { name: 'Apply', exact: true }).click();
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(criterionName, { exact: true }).waitFor();
    await expect(riskToggle).toHaveAttribute('aria-checked', 'true');
    pass('Risk and optional criteria persist through the real API');
    await screenshot('risk');
    const previewButton = page.getByRole('button', { name: 'Preview on a PR', exact: true });
    await hydrated(previewButton);
    await previewButton.click();
    await page.getByRole('dialog').getByRole('heading', { name: 'Preview on a PR', exact: true }).waitFor();
    await screenshot('risk-preview-sheet');
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    pass('Risk preview opens in the app side panel');

    await openMenu('Routing');
    await page.getByText('Default model', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'No risk found', exact: true }).waitFor();
    await chooseMode('Risk found', 'Balanced');
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('combobox', { name: 'Risk found', exact: true })).toContainText('Balanced', { timeout: 20_000 });
    pass('Risk routing and model defaults render and persist');
    await screenshot('routing');

    await openMenu('General', 'General settings');
    const summary = page.getByRole('heading', { name: 'Review mode', exact: true }).locator('..').locator('..');
    await summary.getByText('Risk found', { exact: true }).waitFor();
    assert.doesNotMatch(await summary.innerText(), /Heavy|Not configured/);
    pass('General shows the effective routing');
    const approval = page.getByRole('switch', { name: 'Automatic PR approval', exact: true });
    await toggle(approval, true);
    await page.getByRole('button', { name: 'Add policy', exact: true }).click();
    const policyDialog = page.getByRole('dialog');
    await policyDialog.getByLabel('Name', { exact: true }).fill(policyName);
    await policyDialog.getByText('All clean PRs', { exact: true }).waitFor();
    await policyDialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('switch', { name: `Enable ${policyName}`, exact: true })).toHaveAttribute('aria-checked', 'false');
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: policyName, exact: true }).waitFor();
    await expect(page.getByRole('switch', { name: `Enable ${policyName}`, exact: true })).toHaveAttribute('aria-checked', 'false');
    pass('Empty policy explicitly covers clean PRs and starts disabled');
    await toggle(approval, false);
    await save();
    await openMenu('Risk assessment');
    await expect(riskToggle).toHaveAttribute('aria-checked', 'true');
    pass('Turning approval off preserves independent risk');
    await toggle(riskToggle, false);
    await save();
    await openMenu('Routing');
    await page.getByRole('combobox', { name: 'All PRs', exact: true }).waitFor();
    await chooseMode('All PRs', 'Heavy');
    await save();
    await openMenu('General', 'General settings');
    await page.getByText('All PRs', { exact: true }).waitFor();
    await screenshot('risk-off-general');
    pass('Risk off uses one fixed review mode and a configured default');

    await openMenu('Routing');
    await chooseMode('All PRs', 'Balanced');
    await save();
    await openMenu('Risk assessment');
    await toggle(riskToggle, true);
    await save();
    await openMenu('Routing');
    await chooseMode('Risk found', 'Heavy');
    await save();
    await screenshot('routing-final');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('routing-mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Routing must fit mobile width.');
    pass('Routing fits mobile width');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openMenu('General', 'General settings');
    await toggle(approval, true);
    await page.getByRole('button', { name: `Delete ${policyName}`, exact: true }).click();
    await toggle(approval, false);
    await save();
    await openMenu('Risk assessment');
    await page.getByRole('button', { name: `Delete ${criterionName}`, exact: true }).click();
    await save();
    pass('Only this run’s policy and criterion are removed after verification');
    assert.deepEqual(pageErrors, [], 'No uncaught app errors.');
} catch (error) {
    await screenshot('failure').catch(() => {});
    writeFileSync(`${OUT}/failure.txt`, `${error.stack}\n`);
    const switches = await page.getByRole('switch').evaluateAll((nodes) => nodes.map((node) => ({
        id: node.id, name: node.getAttribute('aria-label'),
        checked: node.getAttribute('aria-checked'), disabled: node.hasAttribute('disabled'),
    }))).catch(() => []);
    writeFileSync(`${OUT}/controls.json`, JSON.stringify(switches, null, 2));
    writeFileSync(`${OUT}/console-errors.json`, JSON.stringify(consoleErrors, null, 2));
    process.exitCode = 1;
} finally {
    writeFileSync(`${OUT}/result.json`, JSON.stringify({ web: WEB, checks, saves, pageErrors, passed: !process.exitCode }, null, 2));
    await browser.close();
}

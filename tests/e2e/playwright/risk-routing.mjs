// Full app on Runo: real NextAuth, menu, settings APIs and persistence.
// The state capture helper labels preview-only fixtures in its manifest.
// Run against the opt-in preview fixture with KODUS_WEB_URL, TEST_USER_EMAIL,
// TEST_USER_PASSWORD. Evidence contains screenshots and verdicts, no credentials.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect as baseExpect } from 'playwright/test';
import { captureRiskRoutingStates } from './risk-routing-state-captures.mjs';

const expect = baseExpect.configure({ timeout: 45_000 });

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
let consoleErrorCount = 0;
const cleanupState = [];
let settingsRequest;
page.on('pageerror', (error) => pageErrors.push(error.name));
page.on('console', (event) => {
    if (event.type() === 'error') consoleErrorCount++;
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
    const button = page.getByRole('button', { name: 'Save settings', exact: true });
    await expect(button).toBeEnabled({ timeout: 15_000 });
    const [response] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('create-or-update-code-review')),
        button.click(),
    ]);
    const sent = response.request().postDataJSON()?.configValue || {};
    settingsRequest = { url: response.url(), body: response.request().postDataJSON() };
    saves.push({ fields: Object.keys(sent), riskAssessmentActive: sent.riskAssessmentActive,
        criteriaCount: sent.riskCriteria?.length, policyCount: sent.approvalPolicies?.length,
        routing: sent.riskReviewRouting });
    if (!response.ok()) {
        throw new Error(`Settings save returned HTTP ${response.status()}.`);
    }
    await page.getByText('Settings saved', { exact: true }).last().waitFor();
    await expect(button).not.toHaveAttribute('data-loading', 'true');
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
async function setMode(label, mode, forceChange = false) {
    const combo = page.getByRole('combobox', { name: label, exact: true });
    await hydrated(combo);
    await expect(combo).toContainText(/Balanced|Heavy/, { timeout: 20_000 });
    if ((await combo.innerText()).includes(mode)) {
        if (!forceChange) return;
        await chooseMode(label, mode === 'Balanced' ? 'Heavy' : 'Balanced');
        await save();
    }
    await chooseMode(label, mode);
    await save();
}
async function readRiskForm(locator, phase) {
    const state = await locator.evaluate((node) => {
        let fiber = node[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
        while (fiber) {
            const props = fiber.memoizedProps;
            const control = props?.control ?? props?.value?.control;
            if (control?._formValues) {
                const criteria = (value) => value?.value?.map(({ id, name }) => ({ id, name }));
                return { current: criteria(control._formValues.riskCriteria), defaults: criteria(control._defaultValues.riskCriteria), dirty: control._formState.dirtyFields.riskCriteria,
                    registered: [...control._names.mount].filter((name) => name.startsWith('riskCriteria')) };
            }
            fiber = fiber.return;
        }
        return { missing: true };
    });
    cleanupState.push({ phase, ...state });
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
    await setMode('Risk found', 'Balanced', true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('combobox', { name: 'Risk found', exact: true })).toContainText('Balanced', { timeout: 20_000 });
    pass('Risk routing and model defaults render and persist');
    await screenshot('routing');

    await openMenu('General', 'General settings');
    const summary = page.getByRole('heading', { name: 'Review mode', exact: true }).locator('..').locator('..');
    await summary.getByText('Risk found', { exact: true }).waitFor();
    await expect(summary.getByText('Risk found', { exact: true }).locator('..')).toContainText('Balanced');
    await expect(summary).not.toContainText('Not configured');
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
    await setMode('All PRs', 'Heavy', true);
    await openMenu('General', 'General settings');
    await page.getByText('All PRs', { exact: true }).waitFor();
    await screenshot('risk-off-general');
    pass('Risk off uses one fixed review mode and a configured default');

    await openMenu('Routing');
    await setMode('All PRs', 'Balanced');
    await openMenu('Risk assessment');
    await toggle(riskToggle, true);
    await save();
    await openMenu('Routing');
    await setMode('Risk found', 'Heavy');
    await screenshot('routing-final');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('routing-mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Routing must fit mobile width.');
    pass('Routing fits mobile width');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openMenu('General', 'General settings');
    await toggle(approval, true);
    const deletePolicy = page.getByRole('button', { name: `Delete ${policyName}`, exact: true });
    await hydrated(deletePolicy);
    await deletePolicy.click();
    await expect(page.getByRole('heading', { name: policyName, exact: true })).toHaveCount(0);
    await toggle(approval, false);
    await save();
    await openMenu('Risk assessment');
    const deleteCriterion = page.getByRole('button', { name: `Delete ${criterionName}`, exact: true });
    await hydrated(deleteCriterion);
    await readRiskForm(deleteCriterion, 'before-delete');
    await deleteCriterion.click();
    await readRiskForm(riskToggle, 'after-delete');
    await expect(page.getByRole('heading', { name: criterionName, exact: true })).toHaveCount(0);
    await readRiskForm(riskToggle, 'after-render');
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await hydrated(riskToggle);
    await expect(page.getByRole('heading', { name: criterionName, exact: true })).toHaveCount(0);
    pass('Only this run’s policy and criterion are removed after verification');
    await captureRiskRoutingStates({ page, context, web: WEB, out: OUT, settingsRequest, hydrated });
    pass('Settings states are captured inside the complete application');
    assert.deepEqual(pageErrors, [], 'No uncaught app errors.');
} catch (error) {
    await screenshot('failure').catch(() => {});
    writeFileSync(`${OUT}/failure.txt`, `${error.stack}\n`);
    const switches = await page.getByRole('switch').evaluateAll((nodes) => nodes.map((node) => ({
        id: node.id, name: node.getAttribute('aria-label'),
        checked: node.getAttribute('aria-checked'), disabled: node.hasAttribute('disabled'),
    }))).catch(() => []);
    writeFileSync(`${OUT}/controls.json`, JSON.stringify(switches, null, 2));
    writeFileSync(`${OUT}/console-errors.json`, JSON.stringify({ count: consoleErrorCount }));
    process.exitCode = 1;
} finally {
    writeFileSync(`${OUT}/cleanup-state.json`, JSON.stringify(cleanupState, null, 2));
    writeFileSync(`${OUT}/result.json`, JSON.stringify({ web: WEB, checks, saves, pageErrors, passed: !process.exitCode }, null, 2));
    await browser.close();
}

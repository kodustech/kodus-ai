// Real app, navigation and native controls; provider HTTP responses are fixtures.
// No fixture credentials are persisted and no external provider is called.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect as baseExpect } from 'playwright/test';

const expect = baseExpect.configure({ timeout: 30_000 });
const caps = { structuredOutput: 'json_schema', toolCalling: 'native' };
const clone = (value) => structuredClone(value);
const target = '/settings/code-review/global/routing';

function fixture(providers = ['openai', 'anthropic']) {
    const credentials = providers.map((provider, i) => ({
        id: `matrix-credential-${i}`, provider,
        ...(!['kodus', 'amazon_bedrock'].includes(provider) ? { apiKey: '••••' } : {}),
        settings: provider === 'openai_compatible' ? { baseURL: `https://gateway-${i}.example.test/v1` }
            : provider === 'amazon_bedrock' ? { awsBearerToken: '••••', awsRegion: 'us-east-1' }
              : provider === 'google_vertex' ? { vertexLocation: 'us-central1' } : {},
    }));
    const models = credentials.map((credential, i) => ({
        id: `matrix-model-${i}`, credentialId: credential.id,
        model: `matrix-model-${i}-example`,
    }));
    return { version: 2, credentials, models, routing: {
        mode: 'manual', defaultModelId: models[0]?.id, taskOverrides: {},
    } };
}

function describe(config, changes = {}) {
    const models = config.models.map((model) => {
        const credential = config.credentials.find((c) => c.id === model.credentialId);
        return { modelId: model.id, credentialId: credential?.id, model: model.model,
            providerId: credential?.provider, baseUrl: credential?.settings?.baseURL,
            resolvable: true, capabilities: caps };
    });
    const routing = config.routing ?? {};
    return { source: models.length ? 'byok' : 'none', models,
        byok: { configured: !!models.length, providerId: models[0]?.providerId, model: models[0]?.model },
        env: { configured: false },
        modelRouting: { defaultModelId: routing.defaultModelId, fallbackModelId: routing.fallbackModelId,
            riskAssessment: { modelId: routing.taskOverrides?.riskAssessment ?? routing.defaultModelId, inherited: !routing.taskOverrides?.riskAssessment } },
        reviewModels: {
            balanced: { modelId: routing.taskOverrides?.codeReview ?? routing.defaultModelId, inherited: !routing.taskOverrides?.codeReview },
            heavy: { modelId: routing.taskOverrides?.codeReviewHeavy ?? routing.defaultModelId, inherited: !routing.taskOverrides?.codeReviewHeavy },
        }, ...changes };
}

export async function testRoutingProviderMatrix({ page, context, settingsRequest, web, out, hydrated }) {
    const dir = `${out}/provider-matrix`;
    mkdirSync(dir, { recursive: true });
    const checks = [];
    let config = fixture();
    let changeStatus = (status) => status;
    let failStatus = false;
    let failSave = false;
    let disconnectOnSave = false;
    let writes = [];
    let probes = [];
    let probeResult = { ok: true, code: 'ok', latencyMs: 1, verifiedBy: 'catalog' };
    let statusReads = 0;
    let totalWrites = 0;
    const pattern = '**/api/proxy/api/organization-parameters/**';
    const handler = async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const fulfill = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
        if (url.pathname.endsWith('/llm-config/status')) {
            ++statusReads;
            return failStatus ? fulfill({ message: 'QA fixture: unavailable' }, 503) : fulfill(changeStatus(describe(config)));
        }
        if (url.pathname.endsWith('/find-by-key') && url.searchParams.get('key') === 'byok_config')
            return fulfill({ configValue: config });
        if (url.pathname.endsWith('/create-or-update')) {
            const body = req.postDataJSON();
            assert.equal(body.key, 'byok_config', 'Only model fixture writes are accepted in the provider matrix.');
            if (failSave) return fulfill({ message: 'QA fixture: save rejected' }, 503);
            writes.push(body);
            ++totalWrites;
            // Keep only masked material, just as a subsequent API read would.
            config = clone(body.configValue);
            for (const c of config.credentials) if (!['kodus', 'amazon_bedrock'].includes(c.provider)) c.apiKey = '••••';
            return fulfill({});
        }
        if (url.pathname.endsWith('/test-byok-model') || url.pathname.endsWith('/test-byok')) {
            probes.push(req.postDataJSON());
            return fulfill(probeResult);
        }
        return route.continue();
    };
    await page.route(pattern, handler);
    const saveButton = () => page.getByRole('button', { name: 'Save settings', exact: true });
    const picker = (name) => page.getByRole('combobox', { name, exact: true });
    async function shot(name) {
        await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
    }
    function pass(name) { checks.push(name); console.log(`PASS provider fixture: ${name}`); }
    async function open(value = fixture(), transform = (status) => status) {
        config = clone(value); changeStatus = transform;
        failStatus = false; failSave = false; disconnectOnSave = false;
        writes = []; probes = [];
        const before = statusReads;
        await page.goto(`${web}${target}`, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => statusReads).toBeGreaterThan(before);
        await page.getByRole('heading', { name: 'Routing', exact: true }).waitFor();
    }
    async function ready() {
        await hydrated(saveButton());
        await expect(picker('Default model')).toBeEnabled();
        await expect(picker('Default model')).toContainText('Matrix');
    }
    async function choose(label, name) {
        await picker(label).click();
        await page.getByRole('option', { name, exact: true }).click();
    }
    async function reset() {
        const button = page.getByRole('button', { name: 'Reset', exact: true });
        if (await button.isEnabled()) await button.click();
        await expect(saveButton()).toBeDisabled();
    }
    async function saveModels() {
        await expect(saveButton()).toBeEnabled();
        const before = writes.length;
        if (disconnectOnSave) changeStatus = () => describe(fixture([]));
        await saveButton().click();
        if (!disconnectOnSave && !failSave) {
            await expect.poll(() => writes.length).toBeGreaterThan(before);
            await expect(saveButton()).toBeDisabled();
        }
    }
    try {
        for (const [name, transform] of [
            ['none', (s) => s],
            ['env-only', (s) => ({ ...s, source: 'env', env: { configured: true, model: 'env-model', providerId: 'openai' } })],
            ['managed-only', (s) => ({ ...s, source: 'env', models: [{ modelId: 'managed', managed: true, providerId: 'openai', resolvable: true }] })],
        ]) {
            await open(fixture([]), transform);
            await page.getByRole('heading', { name: 'Connect an AI provider to use routing', exact: true }).waitFor();
            await expect(page.getByRole('link', { name: /^Routing(?:\s|$)/ })).toBeVisible();
            await expect(page.getByRole('link', { name: 'Connect AI provider', exact: true })).toHaveAttribute('href', '/byok');
            await expect(page.getByRole('combobox')).toHaveCount(0);
            await expect(saveButton()).toHaveCount(0);
            assert.equal(writes.length, 0);
            await shot(`locked-${name}`); pass(`${name}: discoverable and locked`);
        }
        for (const provider of ['kodus', 'openai', 'anthropic', 'google_gemini', 'google_vertex', 'amazon_bedrock', 'openrouter', 'openai_compatible']) {
            // Two slots on the same connection: model switching must not depend
            // on byok.providerId or a particular provider's display label.
            const value = fixture([provider]);
            value.models.push({ id: 'matrix-model-second', credentialId: value.credentials[0].id, model: 'matrix-second-example' });
            await open(value); await ready();
            await picker('Default model').click();
            await page.getByPlaceholder('Search models…').fill('second');
            await expect(page.getByRole('option', { name: /Matrix.*second/i })).toHaveCount(1);
            await page.getByRole('option', { name: /Matrix.*second/i }).click();
            await saveModels();
            assert.equal(writes[0].configValue.routing.defaultModelId, 'matrix-model-second');
            assert.ok(writes[0].configValue.credentials.every((c) => !c.apiKey), 'Never submit a stored credential mask as a new key.');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(picker('Default model')).toContainText(/second/i);
            await shot(`provider-${provider}`); pass(`${provider}: search, save and reload (HTTP fixture)`);
        }
        await open(fixture(['openai']));
        await expect(picker('Default model')).toContainText('Matrix');
        await expect(picker('Default model')).toBeDisabled();
        await expect(picker('Fallback model')).toBeDisabled();
        await expect(page.getByText(/One connected model/)).toBeVisible();
        await expect(page.getByRole('combobox', { name: /No risk found|All PRs/ }).first()).toBeEnabled();
        await shot('single-model'); pass('one model: no redundant model choices, review mode remains editable');

        await open(); await ready();
        await choose('Fallback model', /Matrix model 1 example/i);
        await choose('Default model', /Matrix model 1 example/i);
        await expect(picker('Fallback model')).toContainText('None');
        await reset();
        assert.equal(writes.length, 0); pass('default/fallback collision clears; Reset does not write');

        const gateways = fixture(['openai_compatible', 'openai_compatible']);
        gateways.models.forEach((m) => m.model = 'shared-model');
        await open(gateways); await hydrated(saveButton());
        await expect(picker('Default model')).toContainText('gateway-0.example.test');
        await picker('Default model').click();
        await expect(page.getByRole('option', { name: /gateway-0.example.test/ })).toBeVisible();
        await page.getByRole('option', { name: /gateway-1.example.test/ }).click();
        await saveModels();
        assert.equal(writes[0].configValue.routing.defaultModelId, 'matrix-model-1');
        await shot('two-gateways'); pass('same model on two gateways: distinct labels and exact slot saved');

        await open(fixture(), (status) => ({ ...status, models: status.models.map((m, i) => i ? { ...m, capabilities: { structuredOutput: 'none', toolCalling: 'none' } } : m) }));
        await ready(); await picker('Balanced model').click();
        await expect(page.getByRole('option', { name: /Matrix model 1 example/i })).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        await shot('capability-lock'); pass('incompatible model disabled before save');

        await open(fixture(), (status) => ({ ...status, models: status.models.map((m, i) => i ? { ...m, resolvable: false } : m) }));
        await ready(); await picker('Default model').click();
        await expect(page.getByRole('option', { name: /Matrix model 1 example/i })).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape'); pass('disconnected secondary provider cannot be selected');

        await open(); await ready();
        await choose('Default model', /Matrix model 1 example/i);
        failSave = true; await saveModels();
        await expect(page.getByText(/Could not save|Request.*503/i).last()).toBeVisible();
        assert.equal(writes.length, 0); await expect(saveButton()).toBeEnabled();
        await shot('save-error'); failSave = false; await reset(); pass('failed save retains draft and can be reset');

        const missing = fixture(); missing.routing.defaultModelId = 'deleted-default';
        await open(missing); await hydrated(saveButton());
        await expect(picker('Default model')).toContainText('Select a connected model');
        await choose('Default model', /Matrix model 1 example/i);
        await saveModels();
        assert.equal(writes[0].configValue.routing.defaultModelId, 'matrix-model-1');
        pass('missing default can be repaired using a connected slot');

        const orphan = fixture(); orphan.routing.taskOverrides.codeReview = 'deleted-override';
        await open(orphan); await ready();
        await expect(picker('Balanced model')).toContainText('Unavailable model');
        await choose('Balanced model', /Use default/);
        await saveModels();
        assert.ok(!writes[0].configValue.routing.taskOverrides.codeReview);
        pass('deleted task override can be reset to inheritance');

        await open(); await ready();
        await choose('Default model', /Matrix model 1 example/i);
        await page.getByRole('link', { name: /Manage AI providers/ }).click();
        assert.equal(new URL(page.url()).pathname, target);
        await expect(page.getByText('Unsaved routing changes', { exact: true }).last()).toBeVisible();
        await reset(); pass('unsaved model edits block navigation until reset');

        await open(); await ready();
        await choose('Default model', /Matrix model 1 example/i);
        changeStatus = (status) => ({ ...status, models: status.models.map((m, i) => i ? { ...m, resolvable: false } : m) });
        await saveButton().click();
        await expect(page.getByText('A selected provider is unavailable. Reconnect it or choose another model.', { exact: true })).toBeVisible();
        assert.equal(writes.length, 0); await reset();
        pass('selected provider disconnects with another still connected: save refused');

        await open(); await ready();
        await choose('Default model', /Matrix model 1 example/i);
        failStatus = true; await saveButton().click();
        await page.getByRole('heading', { name: 'Could not verify AI providers', exact: true }).waitFor();
        assert.equal(writes.length, 0);
        await expect(page.getByRole('combobox')).toHaveCount(0);
        await shot('status-error');
        failStatus = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(picker('Default model')).toBeEnabled(); await reset();
        pass('status failure locks writes; Retry restores the draft safely');

        await open(fixture(), () => null);
        await page.getByRole('heading', { name: 'Could not verify AI providers', exact: true }).waitFor();
        await expect(page.getByRole('combobox')).toHaveCount(0);
        assert.equal(writes.length, 0);
        await shot('empty-status-error');
        changeStatus = (status) => status;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await ready(); pass('empty status response shows a recoverable error instead of endless loading');

        await open(); await ready();
        await choose('Default model', /Matrix model 1 example/i);
        disconnectOnSave = true; await saveModels();
        await page.getByRole('heading', { name: 'Connect an AI provider to use routing', exact: true }).waitFor();
        assert.equal(writes.length, 0);
        await expect(page.getByRole('button', { name: 'Discard changes and connect', exact: true })).toBeVisible();
        await shot('disconnect-mid-edit');
        await page.getByRole('button', { name: 'Discard changes and connect', exact: true }).click();
        await expect(page).toHaveURL(/\/byok$/); pass('last provider removed during edit: no write; discard and reconnect recovery');

        await open(); await ready();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(async () => (await page.locator('aside').boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(64);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        await picker('Default model').click();
        const options = page.getByRole('listbox');
        await expect(options).toBeInViewport({ ratio: 1 });
        const bounds = await options.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'The complete model picker fits mobile.');
        await shot('mobile-model-picker'); await page.keyboard.press('Escape');
        await expect(options).toBeHidden();
        await shot('mobile-routing'); pass('mobile: native rail, page and model picker fit without horizontal clipping');
        await page.getByRole('region', { name: 'Review mode', exact: true }).evaluate((node) => node.scrollIntoView({ block: 'start' }));
        await shot('mobile-review-mode');
        await page.getByText('Manual commands', { exact: true }).scrollIntoViewIfNeeded();
        await shot('mobile-review-mode-bottom');
        await page.setViewportSize({ width: 1440, height: 1000 });

        // Legacy navigation is real. The new page's provider HTTP is still a fixture.
        await page.goto(`${web}/byok?tab=routing#fallback`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`${target}#fallback$`));
        await ready(); pass('old routing URL redirects to its canonical replacement and preserves anchor');
        await shot('legacy-redirect');

        await open(gateways); await hydrated(saveButton());
        const scopesResponse = await context.request.get(`${web}/api/proxy/api/parameters/code-review-scopes?teamId=${encodeURIComponent(settingsRequest.body.organizationAndTeamData.teamId)}`);
        assert.ok(scopesResponse.ok(), 'The QA repository scopes must be available.');
        const scopesBody = await scopesResponse.json();
        const repository = (scopesBody.data ?? scopesBody).find((scope) => scope.id !== 'global');
        assert.ok(repository, 'The connected QA tenant must expose a repository scope.');
        await page.goto(`${web}/settings/code-review/${encodeURIComponent(repository.id)}/routing`, { waitUntil: 'domcontentloaded' });
        const scopePicker = picker('Code review model override');
        await expect(scopePicker).toBeEnabled();
        await scopePicker.click();
        await page.getByRole('option', { name: /Shared Model.*gateway-1.example.test/i }).click();
        const probeButton = page.getByRole('button', { name: 'Test model', exact: true });
        await expect(probeButton).toBeEnabled(); await probeButton.click();
        await page.getByText('Model available', { exact: true }).waitFor();
        assert.deepEqual(probes.at(-1), { provider: 'openai_compatible', model: 'shared-model', credentialId: 'matrix-credential-1' });
        await expect(page.getByText('Connection verified', { exact: true })).toHaveCount(0);
        await shot('scoped-gateway-catalog'); pass('repository probe targets the selected gateway credential; catalog success is not called connection verification');
        probeResult = { ok: false, code: 'auth', latencyMs: 1, message: 'Authentication failed (QA fixture)' };
        await probeButton.click();
        await page.getByRole('alert').filter({ hasText: 'Authentication failed (QA fixture)' }).waitFor();
        await expect(page.getByText('Model available', { exact: true })).toHaveCount(0);
        await shot('scoped-gateway-auth-error');
        assert.equal(writes.length, 0, 'Probing a scope override must not persist the fixture pin.');
        await reset(); pass('probe authentication failure replaces success; reset leaves the actual repository unchanged');
    } finally {
        await page.setViewportSize({ width: 1440, height: 1000 });
        // Reset only local draft if a failed assertion stopped the run mid-edit.
        await reset().catch(() => {});
        await page.unroute(pattern, handler);
        writeFileSync(`${dir}/report.json`, JSON.stringify({ source: 'Full Next app and native controls; provider/status/config/write/probe HTTP fixtures only', externalProviderCalls: 0, checks, passed: checks.length === 28, statusReads, fixtureWrites: totalWrites, probeCount: probes.length }, null, 2));
    }
    return checks;
}

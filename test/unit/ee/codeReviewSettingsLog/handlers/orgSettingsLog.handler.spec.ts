import { OrgSettingsLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/orgSettingsLog.handler';

import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

describe('OrgSettingsLogHandler', () => {
    let handler: OrgSettingsLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new OrgSettingsLogHandler(mockUnified as any);
    });

    const callHandler = (
        settingKey: string,
        previousValue: any,
        currentValue: any,
    ) =>
        handler.logOrgSettingsChange({
            ...createBaseParams(),
            settingKey,
            previousValue,
            currentValue,
        } as any);

    // ─── auto_join_config ───

    describe('auto_join_config', () => {
        it('detects enabled toggle false→true', async () => {
            await callHandler(
                'auto_join_config',
                { enabled: false, domains: [] },
                { enabled: true, domains: [] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Auto-Join Settings Updated',
            );
            expect(data[0].description).toContain('enabled Auto-Join');
        });

        it('detects enabled toggle true→false', async () => {
            await callHandler(
                'auto_join_config',
                { enabled: true, domains: [] },
                { enabled: false, domains: [] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data[0].description).toContain('disabled Auto-Join');
        });

        it('detects domain list change with same enabled', async () => {
            await callHandler(
                'auto_join_config',
                { enabled: true, domains: ['a.com'] },
                { enabled: true, domains: ['a.com', 'b.com'] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('updated Auto-Join');
            expect(data[0].description).toContain('b.com');
        });

        it('detects both enabled + domains change', async () => {
            await callHandler(
                'auto_join_config',
                { enabled: false, domains: [] },
                { enabled: true, domains: ['new.com'] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('enabled Auto-Join');
            expect(data[0].description).toContain('new.com');
        });

        it('does not log when nothing changed', async () => {
            await callHandler(
                'auto_join_config',
                { enabled: true, domains: ['a.com'] },
                { enabled: true, domains: ['a.com'] },
            );

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });

        it('null previous defaults to false/[]', async () => {
            await callHandler('auto_join_config', null, {
                enabled: true,
                domains: ['x.com'],
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].previousValue.enabled).toBe(false);
            expect(data[0].previousValue.domains).toEqual([]);
        });
    });

    // ─── timezone_config ───

    describe('timezone_config', () => {
        it('detects timezone change with formatted names', async () => {
            await callHandler(
                'timezone_config',
                'America/New_York',
                'Europe/London',
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Timezone Updated');
            expect(data[0].description).toContain('America/New York');
            expect(data[0].description).toContain('Europe/London');
        });

        it('null previous → "not set"', async () => {
            await callHandler('timezone_config', null, 'America/Chicago');

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data[0].description).toContain('not set');
        });

        it('unchanged → not called', async () => {
            await callHandler(
                'timezone_config',
                'America/New_York',
                'America/New_York',
            );

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── cockpit_metrics_visibility ───

    describe('cockpit_metrics_visibility', () => {
        it('detects single metric toggle in summary', async () => {
            await callHandler(
                'cockpit_metrics_visibility',
                { summary: { deployFrequency: true } },
                { summary: { deployFrequency: false } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Cockpit Metric Disabled');
            expect(data[0].description).toContain('Deploy Frequency');
            expect(data[0].description).toContain('Summary Metrics');
        });

        it('detects multiple metrics across categories', async () => {
            await callHandler(
                'cockpit_metrics_visibility',
                {
                    summary: { deployFrequency: true },
                    details: { leadTimeBreakdown: true },
                },
                {
                    summary: { deployFrequency: false },
                    details: { leadTimeBreakdown: false },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(2);
        });

        it('missing category defaults to true', async () => {
            await callHandler(
                'cockpit_metrics_visibility',
                { summary: {} },
                { summary: { deployFrequency: false } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Cockpit Metric Disabled');
        });

        it('all identical → not called', async () => {
            await callHandler(
                'cockpit_metrics_visibility',
                { summary: { deployFrequency: true } },
                { summary: { deployFrequency: true } },
            );

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── byok_config ───

    describe('byok_config', () => {
        it('logs slot added (main) with apiKey sanitized', async () => {
            await callHandler(
                'byok_config',
                {},
                {
                    main: {
                        provider: 'openai',
                        model: 'gpt-4',
                        apiKey: 'sk-secret',
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'BYOK Main Configuration Added',
            );
            expect(data[0].currentValue.apiKey).toBe('***');
        });

        it('logs slot removed (fallback)', async () => {
            await callHandler(
                'byok_config',
                {
                    fallback: {
                        provider: 'anthropic',
                        model: 'claude-3',
                        apiKey: 'sk-old',
                    },
                },
                {},
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'BYOK Fallback Configuration Removed',
            );
        });

        it('logs field-level changes within existing slot', async () => {
            await callHandler(
                'byok_config',
                { main: { provider: 'openai', model: 'gpt-4' } },
                { main: { provider: 'anthropic', model: 'claude-3' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(2);
            expect(data[0].actionDescription).toBe(
                'BYOK Main Provider Updated',
            );
            expect(data[1].actionDescription).toBe('BYOK Main Model Updated');
        });

        it('logs API key update as *** both sides', async () => {
            await callHandler(
                'byok_config',
                { main: { apiKey: 'old-key' } },
                { main: { apiKey: 'new-key' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            const apiKeyEntry = data.find((d) =>
                d.actionDescription.includes('API Key'),
            );
            expect(apiKeyEntry).toBeDefined();
            expect(apiKeyEntry.actionDescription).toBe(
                'BYOK Main API Key Updated',
            );
            expect(apiKeyEntry.previousValue.apiKey).toBe('***');
            expect(apiKeyEntry.currentValue.apiKey).toBe('***');
        });

        it('logs API key added', async () => {
            await callHandler(
                'byok_config',
                { main: {} },
                { main: { apiKey: 'new-key' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            const apiKeyEntry = data.find((d) =>
                d.actionDescription.includes('API Key'),
            );
            expect(apiKeyEntry).toBeDefined();
            expect(apiKeyEntry.actionDescription).toBe(
                'BYOK Main API Key Added',
            );
            expect(apiKeyEntry.previousValue.apiKey).toBe('not set');
            expect(apiKeyEntry.currentValue.apiKey).toBe('***');
        });

        it('logs API key removed', async () => {
            await callHandler(
                'byok_config',
                { main: { apiKey: 'old-key' } },
                { main: {} },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            const apiKeyEntry = data.find((d) =>
                d.actionDescription.includes('API Key'),
            );
            expect(apiKeyEntry).toBeDefined();
            expect(apiKeyEntry.actionDescription).toBe(
                'BYOK Main API Key Removed',
            );
            expect(apiKeyEntry.previousValue.apiKey).toBe('***');
            expect(apiKeyEntry.currentValue.apiKey).toBe('not set');
        });

        it('no changes → not called', async () => {
            await callHandler(
                'byok_config',
                { main: { provider: 'openai' } },
                { main: { provider: 'openai' } },
            );

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── Unknown key ───

    describe('unknown key', () => {
        it('returns empty, saveLogEntry not called', async () => {
            await callHandler('unknown_setting', 'a', 'b');

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });
});

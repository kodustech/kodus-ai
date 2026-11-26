import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/review-settings.service.js', () => ({
    reviewSettingsService: {
        riskRules: vi.fn(),
    },
}));

vi.mock('../../../utils/logger.js', () => ({
    cliInfo: vi.fn(),
    cliError: vi.fn(),
}));

import { reviewSettingsService } from '../../../services/review-settings.service.js';
import { cliInfo } from '../../../utils/logger.js';
import { riskRulesAction } from '../review-settings-actions.js';

const RULES = [
    {
        id: 'kodus-security',
        name: 'Security and permissions',
        enabled: true,
        instructions: 'Auth.',
        source: 'kodus' as const,
    },
];

const printed = () => vi.mocked(cliInfo).mock.calls.map(([line]) => line);

describe('risk-rules', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('says first when risk assessment is off, so the rules are not read as applied', async () => {
        vi.mocked(reviewSettingsService.riskRules).mockResolvedValue({
            active: false,
            rules: RULES,
        });
        await riskRulesAction('.', {});
        expect(printed()).toEqual([
            'Risk assessment is off here: these rules are not applied.',
            'on   kodus-security  Security and permissions (Kodus)',
        ]);
    });

    it('lists the rules alone when risk assessment is on', async () => {
        vi.mocked(reviewSettingsService.riskRules).mockResolvedValue({
            active: true,
            rules: RULES,
        });
        await riskRulesAction('.', {});
        expect(printed()).toEqual([
            'on   kodus-security  Security and permissions (Kodus)',
        ]);
    });

    it('prints whether assessment is on with the rules as JSON', async () => {
        vi.mocked(reviewSettingsService.riskRules).mockResolvedValue({
            active: false,
            rules: RULES,
        });
        await riskRulesAction('.', { json: true });
        expect(JSON.parse(printed()[0] as string)).toEqual({
            active: false,
            rules: RULES,
        });
    });
});

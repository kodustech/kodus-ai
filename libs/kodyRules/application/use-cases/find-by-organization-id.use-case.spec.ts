jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock('./utils/enrich-rules-with-context-references.util', () => ({
    enrichRulesWithContextReferences: jest.fn(async (rules) => rules),
}));

import { FindByOrganizationIdKodyRulesUseCase } from './find-by-organization-id.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Regression coverage for the listing leak: the Kody Rules screen kept
 * showing rules even after a "Reset integration and remove repositories
 * config" because this endpoint returned the raw embedded rules array,
 * including soft-deleted entries. The screen now must hide DELETED (and
 * APPLIED, to stay aligned with find-rules-in-organization-by-filter).
 */
describe('FindByOrganizationIdKodyRulesUseCase', () => {
    const ORG_ID = 'org-1';
    let useCase: FindByOrganizationIdKodyRulesUseCase;
    let kodyRulesService: { findByOrganizationId: jest.Mock };
    let contextReferenceService: any;
    let request: any;

    beforeEach(() => {
        kodyRulesService = { findByOrganizationId: jest.fn() };
        contextReferenceService = {};
        request = { user: { organization: { uuid: ORG_ID } } };

        useCase = new (FindByOrganizationIdKodyRulesUseCase as any)(
            request,
            kodyRulesService,
            contextReferenceService,
        );
    });

    it('omits DELETED rules from the response', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            organizationId: ORG_ID,
            rules: [
                { uuid: 'r-active', status: KodyRulesStatus.ACTIVE },
                { uuid: 'r-deleted', status: KodyRulesStatus.DELETED },
            ],
        });

        const result = (await useCase.execute()) as { rules: any[] };

        expect(result.rules.map((r) => r.uuid)).toEqual(['r-active']);
    });

    it('omits APPLIED rules from the response', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            organizationId: ORG_ID,
            rules: [
                { uuid: 'r-active', status: KodyRulesStatus.ACTIVE },
                { uuid: 'r-applied', status: KodyRulesStatus.APPLIED },
            ],
        });

        const result = (await useCase.execute()) as { rules: any[] };

        expect(result.rules.map((r) => r.uuid)).toEqual(['r-active']);
    });

    it('keeps PAUSED / PENDING / REJECTED rules visible (only DELETED+APPLIED are hidden)', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            organizationId: ORG_ID,
            rules: [
                { uuid: 'r-active', status: KodyRulesStatus.ACTIVE },
                { uuid: 'r-paused', status: KodyRulesStatus.PAUSED },
                { uuid: 'r-pending', status: KodyRulesStatus.PENDING },
                { uuid: 'r-rejected', status: KodyRulesStatus.REJECTED },
                { uuid: 'r-deleted', status: KodyRulesStatus.DELETED },
            ],
        });

        const result = (await useCase.execute()) as { rules: any[] };

        expect(result.rules.map((r) => r.uuid)).toEqual([
            'r-active',
            'r-paused',
            'r-pending',
            'r-rejected',
        ]);
    });

    it('handles missing rules array gracefully', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            organizationId: ORG_ID,
            rules: undefined,
        });

        const result = (await useCase.execute()) as { rules: any[] };

        expect(result.rules).toEqual([]);
    });
});

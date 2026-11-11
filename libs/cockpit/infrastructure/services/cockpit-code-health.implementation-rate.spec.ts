import { CockpitCodeHealthService } from './cockpit-code-health.service';

describe('CockpitCodeHealthService.getImplementationRate', () => {
    it('rates only what the implementation check decided, like every other implementation-rate chart', async () => {
        const ds = {
            query: jest
                .fn()
                .mockResolvedValue([
                    {
                        suggestions_sent: 8,
                        suggestions_implemented: 2,
                        implementation_rate: 0.25,
                    },
                ]),
        };
        const service = new CockpitCodeHealthService(ds as any);

        const result = await service.getImplementationRate({
            organizationId: 'org-1',
            startDate: '2026-10-01',
            endDate: '2026-10-31',
        });

        const [sql] = ds.query.mock.calls[0];
        expect(sql).toMatch(
            /WHERE NOT \(COALESCE\(sv\."suggestionImplementationCheckOutcome", ''\) = 'unmeasured'/,
        );
        expect(result).toEqual({
            suggestionsSent: 8,
            suggestionsImplemented: 2,
            implementationRate: 0.25,
        });
    });
});

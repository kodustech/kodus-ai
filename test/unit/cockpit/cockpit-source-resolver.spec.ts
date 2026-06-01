import { COCKPIT_SOURCE } from '@libs/cockpit/domain/cockpit-source.enum';
import { CockpitSourceResolver } from '@libs/cockpit/infrastructure/services/cockpit-source.resolver';

describe('CockpitSourceResolver', () => {
    let resolver: CockpitSourceResolver;

    beforeEach(() => {
        resolver = new CockpitSourceResolver();
    });

    it('always returns INTERNAL — the legacy BigQuery path was retired', async () => {
        const source = await resolver.resolve('org-1');
        expect(source).toBe(COCKPIT_SOURCE.INTERNAL);
    });
});

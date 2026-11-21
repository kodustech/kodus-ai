import { loadSnapshot } from '@libs/feature-gate/infrastructure/feature-snapshot.loader';

import { isKodyRuntimeReleasedToTrack, KODY_RUNTIME_STAGE } from '../kody-runtime-release';

describe('who Kody Runtime is released to', () => {
    it('an org on the alpha track sees it', () => {
        expect(isKodyRuntimeReleasedToTrack('alpha')).toBe(true);
    });

    it('an org on the beta or stable track does not', () => {
        expect(isKodyRuntimeReleasedToTrack('beta')).toBe(false);
        expect(isKodyRuntimeReleasedToTrack('stable')).toBe(false);
    });

    it('a track that is missing or not a known track is a no', () => {
        for (const track of [undefined, null, '', 'internal', 'ALPHA', 1]) {
            expect(isKodyRuntimeReleasedToTrack(track)).toBe(false);
        }
    });

    it('the stage it gates on is the one the catalog documents', () => {
        expect(KODY_RUNTIME_STAGE).toBe('alpha');
        expect(loadSnapshot().features['kody-runtime']?.stage).toBe(KODY_RUNTIME_STAGE);
    });
});

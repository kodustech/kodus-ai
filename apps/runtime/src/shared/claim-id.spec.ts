import { SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run/environment-setup';

import { isSetupChildSuffix } from './claim-id';

// The claims a setup may boot on its admission ticket's cell after its own.
describe("a setup's child claims", () => {
    it("are the learn loop's boots, Kody's repairs, and the one boot again after expired tokens of the setup's boot or of a repair", () => {
        const ok = ['learn-1', 'learn-3-replay', 'repair-1', `repair-${SETUP_AUTHOR_REPAIRS_MAX}`, 'refetch', 'repair-1:refetch'];
        expect(ok.filter(isSetupChildSuffix)).toEqual(ok);
    });

    it('are nothing else: a second boot again, a repair past the most, an unknown suffix', () => {
        const no = ['refetch:refetch', 'repair-1:refetch:refetch', `repair-${SETUP_AUTHOR_REPAIRS_MAX + 1}:refetch`, 'learn-1:refetch', 'repair-0', 'boot', ''];
        expect(no.filter(isSetupChildSuffix)).toEqual([]);
    });
});

import { BUILD_BOOT_GRACE_MS, BUILD_CEILING_MS, staleBuild } from './template-watchdog';

const row = (over: Partial<Parameters<typeof staleBuild>[0]> = {}) => ({ setupHostId: 'tpl-1', cellBase: 'v30', idleMs: 0, ...over });
const live = (...ids: string[]) => ({ poolCellBase: 'v30', liveSetupHosts: new Set(ids) });

describe('staleBuild', () => {
    it('ends a building row on a cell base the pool no longer uses, however young it is', () => {
        expect(staleBuild(row({ cellBase: 'v29' }), live('tpl-1'))).toBe('cell_base_changed');
    });
    it('leaves a young row alone even when the provider lists no host for it yet', () => {
        expect(staleBuild(row({ idleMs: BUILD_BOOT_GRACE_MS - 1 }), live())).toBeNull();
    });
    it('ends a row past the boot grace whose setup host the provider does not list', () => {
        expect(staleBuild(row({ idleMs: BUILD_BOOT_GRACE_MS + 1 }), live('tpl-other'))).toBe('setup_host_gone');
        expect(staleBuild(row({ idleMs: BUILD_BOOT_GRACE_MS + 1, setupHostId: null }), live('tpl-1'))).toBe('setup_host_gone');
    });
    it('leaves a row past the grace alone while its setup host is listed', () => {
        expect(staleBuild(row({ idleMs: BUILD_CEILING_MS - 1 }), live('tpl-1'))).toBeNull();
    });
    it('does not judge by the host when the provider could not be asked', () => {
        expect(staleBuild(row({ idleMs: BUILD_BOOT_GRACE_MS + 1 }), { poolCellBase: 'v30', liveSetupHosts: null })).toBeNull();
    });
    it('ends a row past the ceiling even with a live host', () => {
        expect(staleBuild(row({ idleMs: BUILD_CEILING_MS + 1 }), live('tpl-1'))).toBe('build_timeout');
    });
});

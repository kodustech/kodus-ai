import { loadSdkRuntime } from './sdk-runtime';

describe('loadSdkRuntime', () => {
    it('loads the pinned ESM-only SDK and the zod it validates with, once', () => {
        const rt = loadSdkRuntime();
        expect(rt.version).toBe('0.3.296');
        expect(typeof rt.query).toBe('function');
        expect(typeof rt.tool).toBe('function');
        expect(typeof rt.createSdkMcpServer).toBe('function');
        expect(typeof rt.z.object).toBe('function');
        expect(loadSdkRuntime()).toBe(rt);
    });
});

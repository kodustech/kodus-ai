import { loadRuntimeApiConfig } from '../infrastructure/runtime-api.config';

describe('A2A discovery origin configuration', () => {
    it('reads the trusted deployment origin rather than a request host', () => {
        expect(
            loadRuntimeApiConfig({
                RUNTIME_A2A_BASE_URL: 'https://kodus.example.test',
            }).a2aBaseUrl,
        ).toBe('https://kodus.example.test');
    });
    it('does not invent an advertised origin when it is not configured', () => {
        expect(loadRuntimeApiConfig({}).a2aBaseUrl).toBeUndefined();
    });
});

import { decrypt } from '../../libs/common/utils/crypto';

const {
    storedByokConfig,
    storedByokConfigOf,
    resolveRoute,
} = require('./model-route');

describe('eval model route — Claude on Amazon Bedrock', () => {
    const OLD_ENV = process.env;
    beforeEach(() => {
        process.env = { ...OLD_ENV };
    });
    afterAll(() => {
        process.env = OLD_ENV;
    });

    it('stores a Bedrock API key the way production does: encrypted bearer token plus region', () => {
        const config = storedByokConfig({
            provider: 'amazon_bedrock',
            model: 'us.anthropic.claude-sonnet-5-5',
            apiKey: 'ABSK-test-key',
            awsRegion: 'us-east-1',
        });
        const [credential] = config.credentials;
        expect(credential.provider).toBe('amazon_bedrock');
        expect(credential.apiKey).toBe('');
        expect(credential.settings.awsRegion).toBe('us-east-1');
        expect(decrypt(credential.settings.awsBearerToken)).toBe(
            'ABSK-test-key',
        );
    });

    it('does the same in a multi-model config', () => {
        const config = storedByokConfigOf([
            {
                id: 'm1',
                provider: 'amazon_bedrock',
                model: 'us.anthropic.claude-sonnet-5-5',
                apiKey: 'ABSK-test-key',
                awsRegion: 'us-east-1',
            },
        ]);
        const [credential] = config.credentials;
        expect(credential.apiKey).toBe('');
        expect(decrypt(credential.settings.awsBearerToken)).toBe(
            'ABSK-test-key',
        );
    });

    it('keeps an API-key provider unchanged', () => {
        const config = storedByokConfig({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            apiKey: 'sk-test',
        });
        const [credential] = config.credentials;
        expect(decrypt(credential.apiKey)).toBe('sk-test');
        expect(credential.settings).toEqual({});
    });

    it('routes the tier-0 Bedrock id with the key from API_AWS_BEDROCK', () => {
        process.env.API_AWS_BEDROCK = 'ABSK-from-env';
        const route = resolveRoute({
            provider: 'tier0',
            model: 'claude-sonnet-5-5@bedrock',
        });
        expect(route.route).toBe('byok');
        const [credential] = route.storedConfig.credentials;
        expect(credential.provider).toBe('amazon_bedrock');
        expect(decrypt(credential.settings.awsBearerToken)).toBe(
            'ABSK-from-env',
        );
        expect(route.storedConfig.models[0].model).toBe(
            'us.anthropic.claude-sonnet-5-5',
        );
    });
});

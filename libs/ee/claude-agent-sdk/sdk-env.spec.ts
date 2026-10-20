import { buildSdkEnv } from './sdk-env';
import type { SdkRoute } from './route';

const SESSION = { baseUrl: 'http://127.0.0.1:4100/s/abc', token: 'abc', home: '/tmp/csdk-1' };
const COMMON = {
    PATH: expect.any(String),
    HOME: '/tmp/csdk-1',
    CLAUDE_CONFIG_DIR: '/tmp/csdk-1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_MAX_RETRIES: '2',
};

describe('buildSdkEnv', () => {
    const polluted = {
        ANTHROPIC_API_KEY: 'sk-ant-worker-key',
        API_OPEN_AI_API_KEY: 'sk-worker',
        AWS_ACCESS_KEY_ID: 'AKIAWORKER',
        AWS_SECRET_ACCESS_KEY: 'worker-secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/etc/sa.json',
        API_PG_DB_PASSWORD: 'db',
        API_CRYPTO_KEY: 'crypto',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    };
    const saved: Record<string, string | undefined> = {};
    beforeAll(() => {
        for (const [k, v] of Object.entries(polluted)) {
            saved[k] = process.env[k];
            process.env[k] = v;
        }
    });
    afterAll(() => {
        for (const k of Object.keys(polluted)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    const secrets = Object.values(polluted);
    const noWorkerValue = (env: Record<string, string>) => Object.values(env).filter((v) => secrets.includes(v));

    it('Anthropic format: exactly the base URL and the session token, nothing from the worker', () => {
        const route: SdkRoute = { format: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-real', auth: 'x-api-key', firstParty: true };
        const env = buildSdkEnv(route, SESSION, { maxOutputTokens: 64000, apiTimeoutMs: 600000 });
        expect(env).toEqual({
            ...COMMON,
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/s/abc',
            ANTHROPIC_API_KEY: 'abc',
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
            API_TIMEOUT_MS: '600000',
        });
        expect(noWorkerValue(env)).toEqual([]);
        expect(Object.values(env)).not.toContain('sk-ant-real');
    });

    it('turns experimental betas off for a route that is not Anthropic itself', () => {
        const route: SdkRoute = { format: 'anthropic', baseUrl: 'https://openrouter.ai/api', apiKey: 'or', auth: 'bearer', firstParty: false };
        expect(buildSdkEnv(route, SESSION)).toEqual({ ...COMMON, ANTHROPIC_BASE_URL: SESSION.baseUrl, ANTHROPIC_API_KEY: 'abc', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' });
    });

    it('Vertex: CLI in Vertex mode on the gateway with auth skipped, the slot project and region, no service account', () => {
        const route: SdkRoute = { format: 'vertex', project: 'proj-1', region: 'us-east5', credentials: { private_key: 'SA-PRIVATE-KEY-7f' }, firstParty: true };
        const env = buildSdkEnv(route, SESSION);
        expect(env).toEqual({
            ...COMMON,
            CLAUDE_CODE_USE_VERTEX: '1',
            CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
            ANTHROPIC_VERTEX_BASE_URL: 'http://127.0.0.1:4100/s/abc/v1',
            ANTHROPIC_VERTEX_PROJECT_ID: 'proj-1',
            CLOUD_ML_REGION: 'us-east5',
        });
        expect(JSON.stringify(env)).not.toContain('SA-PRIVATE-KEY-7f');
    });

    it('Bedrock: CLI in Bedrock mode on the gateway with auth skipped and the slot region, no AWS key', () => {
        const route: SdkRoute = { format: 'bedrock', region: 'eu-west-1', auth: { kind: 'sigv4', accessKeyId: 'AKIASLOT', secretAccessKey: 'slot-secret' }, firstParty: true };
        const env = buildSdkEnv(route, SESSION);
        expect(env).toEqual({ ...COMMON, CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', ANTHROPIC_BEDROCK_BASE_URL: SESSION.baseUrl, AWS_REGION: 'eu-west-1' });
        expect(noWorkerValue(env)).toEqual([]);
        expect(JSON.stringify(env)).not.toMatch(/AKIASLOT|slot-secret/);
    });
});

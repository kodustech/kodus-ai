import { encrypt } from '@libs/common/utils/crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { BYOKProvider } from '@libs/llm/model-providers';
import PROD_SHAPES from '@libs/llm/testing/__fixtures__/byok-prod-shapes.json';

import { resolveClaudeSdkRoute } from './eligibility';

const slot = (s: Partial<NormalizedModel> & { provider: string; model: string }) => ({ apiKey: encrypt('the-key'), ...s }) as unknown as NormalizedModel;
const SA = JSON.stringify({ type: 'service_account', project_id: 'proj-1', client_email: 'sa@proj-1.iam', private_key: 'pk' });

describe('resolveClaudeSdkRoute', () => {
    const ENV_KEYS = ['API_LLM_PROVIDER_MODEL', 'API_ANTHROPIC_API_KEY', 'API_KODUS_PROVIDER_ANTHROPIC_API_KEY', 'API_VERTEX_AI_API_KEY', 'API_OPEN_AI_API_KEY', 'API_GOOGLE_AI_API_KEY'];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('routes a team’s own Anthropic key to Anthropic, first party, with the key decrypted', () => {
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.ANTHROPIC, model: 'claude-sonnet-5-5' }))).toEqual({
            model: 'claude-sonnet-5-5',
            route: { format: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'the-key', auth: 'x-api-key', firstParty: true },
        });
    });

    it('keeps a custom Anthropic base URL, without `/v1`, as not first party', () => {
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.ANTHROPIC, model: 'claude-opus-5-5', baseURL: 'https://proxy.example.test/v1/' }))?.route).toMatchObject({
            baseUrl: 'https://proxy.example.test',
            firstParty: false,
        });
    });

    it('routes Kodus credits on Anthropic with the platform key and the bare model id; nothing without the key', () => {
        const kodus = slot({ provider: BYOKProvider.KODUS, model: 'anthropic/claude-sonnet-5-5', apiKey: '' } as any);
        expect(resolveClaudeSdkRoute(kodus)).toBeNull();
        process.env.API_KODUS_PROVIDER_ANTHROPIC_API_KEY = 'platform-key';
        expect(resolveClaudeSdkRoute(kodus)).toEqual({
            model: 'claude-sonnet-5-5',
            route: { format: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'platform-key', auth: 'x-api-key', firstParty: true },
        });
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.KODUS, model: 'fireworks/accounts/fireworks/models/deepseek-v4p1-flash', apiKey: '' } as any))).toBeNull();
    });

    it('routes Claude on Vertex with the service account project and the slot region (global by default)', () => {
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.GOOGLE_VERTEX, model: 'claude-sonnet-5-5', apiKey: encrypt(Buffer.from(SA).toString('base64')), vertexLocation: 'us-east5' }))).toEqual({
            model: 'claude-sonnet-5-5',
            route: { format: 'vertex', project: 'proj-1', region: 'us-east5', credentials: JSON.parse(SA), firstParty: true },
        });
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.GOOGLE_VERTEX, model: 'claude-sonnet-5-5', apiKey: encrypt(SA) }))?.route).toMatchObject({ region: 'global' });
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.GOOGLE_VERTEX, model: 'gemini-3-pro', apiKey: encrypt(SA) }))).toBeNull();
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.GOOGLE_VERTEX, model: 'claude-sonnet-5-5', apiKey: encrypt('AIzaNotAServiceAccount') }))).toBeNull();
    });

    it('routes Claude on Bedrock with a bearer key first, else IAM keys, else nothing', () => {
        const model = 'us.anthropic.claude-sonnet-5-5-v1:0';
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.AMAZON_BEDROCK, model, awsRegion: 'eu-west-1', awsBearerToken: encrypt('br'), awsAccessKeyId: encrypt('AKIA') } as any))).toEqual({
            model,
            route: { format: 'bedrock', region: 'eu-west-1', auth: { kind: 'bearer', token: 'br' }, firstParty: true },
        });
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.AMAZON_BEDROCK, model, awsAccessKeyId: encrypt('AKIA'), awsSecretAccessKey: encrypt('s'), awsSessionToken: encrypt('t') } as any))?.route).toEqual({
            format: 'bedrock',
            region: 'us-east-1',
            auth: { kind: 'sigv4', accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' },
            firstParty: true,
        });
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.AMAZON_BEDROCK, model } as any))).toBeNull();
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.AMAZON_BEDROCK, model: 'amazon.nova-pro-v1:0', awsBearerToken: encrypt('br') } as any))).toBeNull();
    });

    it('routes OpenRouter anthropic/* to its Anthropic endpoint with a bearer, pinned to Anthropic, not first party', () => {
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.OPEN_ROUTER, model: 'anthropic/claude-sonnet-5.5', openrouterProviderOrder: ['amazon-bedrock'] } as any))).toEqual({
            model: 'anthropic/claude-sonnet-5.5',
            route: { format: 'anthropic', baseUrl: 'https://openrouter.ai/api', apiKey: 'the-key', auth: 'bearer', firstParty: false, openrouterProvider: { order: ['anthropic'], allow_fallbacks: false } },
        });
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.OPEN_ROUTER, model: 'deepseek/deepseek-v4' }))).toBeNull();
    });

    it('routes a LiteLLM-style anthropic_compatible proxy serving a claude-* id, and never a brand', () => {
        expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.ANTHROPIC_COMPATIBLE, model: 'claude-opus-5', baseURL: 'https://litellm.example.test/v1' }))).toEqual({
            model: 'claude-opus-5',
            route: { format: 'anthropic', baseUrl: 'https://litellm.example.test', apiKey: 'the-key', auth: 'x-api-key', firstParty: false },
        });
        for (const model of ['kimi-k2.7-code', 'glm-5.3', 'deepseek-v4']) {
            expect(resolveClaudeSdkRoute(slot({ provider: BYOKProvider.ANTHROPIC_COMPATIBLE, model, baseURL: 'https://api.moonshot.ai/anthropic' }))).toBeNull();
        }
    });

    it('never routes providers that do not speak Anthropic Messages to the CLI, Claude id or not', () => {
        for (const provider of [BYOKProvider.OPENAI, BYOKProvider.OPENAI_COMPATIBLE, BYOKProvider.GOOGLE_GEMINI, BYOKProvider.NOVITA, BYOKProvider.MOONSHOT, BYOKProvider.ZAI, BYOKProvider.AZURE]) {
            expect([provider, resolveClaudeSdkRoute(slot({ provider, model: 'claude-sonnet-5-5', baseURL: 'https://x.example.test/v1' }))]).toEqual([provider, null]);
        }
    });

    it('routes the self-hosted env Claude when the org has no slot, and nothing on the cloud default', () => {
        expect(resolveClaudeSdkRoute(undefined)).toBeNull();
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-5-5';
        // Self-hosted installs put the Claude key in API_OPEN_AI_API_KEY (managed-slot.ts).
        process.env.API_OPEN_AI_API_KEY = 'env-key';
        expect(resolveClaudeSdkRoute(undefined)).toEqual({
            model: 'claude-sonnet-5-5',
            route: { format: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'env-key', auth: 'x-api-key', firstParty: true },
        });
        process.env.API_LLM_PROVIDER_MODEL = 'gpt-5.4';
        expect(resolveClaudeSdkRoute(undefined)).toBeNull();
    });

    it('over every production slot shape: only Claude models are routed, and only on the Anthropic-speaking providers', () => {
        const SPEAKS_ANTHROPIC = new Set<string>([BYOKProvider.ANTHROPIC, BYOKProvider.ANTHROPIC_COMPATIBLE, BYOKProvider.OPEN_ROUTER, BYOKProvider.GOOGLE_VERTEX, BYOKProvider.AMAZON_BEDROCK, BYOKProvider.KODUS]);
        const routed: string[] = [];
        for (const shape of PROD_SHAPES as Array<Record<string, any>>) {
            const s = slot({ ...shape, awsBearerToken: encrypt('br'), apiKey: shape.provider === 'google_vertex' ? encrypt(SA) : encrypt('k') } as any);
            const r = resolveClaudeSdkRoute(s);
            if (!r) continue;
            routed.push(`${shape.provider}:${shape.model}`);
            expect(SPEAKS_ANTHROPIC.has(shape.provider)).toBe(true);
            expect(/claude/i.test(shape.model)).toBe(true);
        }
        // 19 native + 5 Bedrock + 1 OpenRouter + 1 compatible Claude shapes are stored today.
        expect(routed.length).toBe(26);
    });
});

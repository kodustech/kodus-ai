//
// Mutation-killing tests for the deterministic model builders. The AI SDK
// factories are mocked so each returns a tagged inner factory, letting us
// assert exactly which SDK a model id routes to and with which settings.
// decrypt is mocked to a visible transform ("DEC:<v>") so we can prove the
// bedrock builder decrypts each ciphertext field it forwards.

jest.mock('@ai-sdk/google-vertex', () => ({
    createVertex: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-gemini',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google-vertex/anthropic', () => ({
    createVertexAnthropic: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-anthropic',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/amazon-bedrock', () => ({
    createAmazonBedrock: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'bedrock',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((v: string) => `DEC:${v}`),
}));

import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { decrypt } from '@libs/common/utils/crypto';
import {
    anthropicCompatibleRootURL,
    vertexModelFromSaJson,
    vertexModelFromAdc,
    bedrockModelFromCredentials,
} from './model-builders';

const createVertexMock = createVertex as unknown as jest.Mock;
const createVertexAnthropicMock = createVertexAnthropic as unknown as jest.Mock;
const createAmazonBedrockMock = createAmazonBedrock as unknown as jest.Mock;
const decryptMock = decrypt as unknown as jest.Mock;

// The settings object passed to the outer factory (createVertex(...)) is what
// we assert against; the inner factory receives the model id.
const settingsFor = (mock: jest.Mock, callIndex = 0) =>
    mock.mock.calls[callIndex][0];

beforeEach(() => {
    jest.clearAllMocks();
});

describe('anthropicCompatibleRootURL', () => {
    it('returns an already-root URL unchanged', () => {
        expect(anthropicCompatibleRootURL('https://api.x.com')).toBe(
            'https://api.x.com',
        );
    });

    it('strips a single trailing slash', () => {
        expect(anthropicCompatibleRootURL('https://api.x.com/')).toBe(
            'https://api.x.com',
        );
    });

    it('strips multiple trailing slashes (leading while-loop)', () => {
        expect(anthropicCompatibleRootURL('https://api.x.com///')).toBe(
            'https://api.x.com',
        );
    });

    it('removes a trailing /v1 suffix', () => {
        expect(anthropicCompatibleRootURL('https://api.x.com/v1')).toBe(
            'https://api.x.com',
        );
    });

    it('removes /v1 case-insensitively', () => {
        expect(anthropicCompatibleRootURL('https://api.x.com/V1')).toBe(
            'https://api.x.com',
        );
    });

    it('strips trailing slashes THEN removes /v1 (order matters)', () => {
        // trailing slashes gone first, exposing the /v1 for removal
        expect(anthropicCompatibleRootURL('https://api.x.com/v1//')).toBe(
            'https://api.x.com',
        );
    });

    it('removes a slash left behind after stripping /v1 (trailing while-loop)', () => {
        // '//v1' -> remove '/v1' -> 'https://api.x.com/' -> final while trims it
        expect(anthropicCompatibleRootURL('https://api.x.com//v1')).toBe(
            'https://api.x.com',
        );
    });

    it('trims surrounding whitespace', () => {
        expect(anthropicCompatibleRootURL('   https://api.x.com   ')).toBe(
            'https://api.x.com',
        );
    });

    it('does NOT remove "v1" that is not a trailing /v1 segment', () => {
        // anchored regex requires a leading slash and end-of-string
        expect(anthropicCompatibleRootURL('https://api.v1.com')).toBe(
            'https://api.v1.com',
        );
        expect(anthropicCompatibleRootURL('https://api.com/xv1')).toBe(
            'https://api.com/xv1',
        );
    });

    it('only strips a single /v1, not a repeated one', () => {
        // '/v1/v1' -> remove trailing '/v1' once -> '.../v1'
        expect(anthropicCompatibleRootURL('https://api.x.com/v1/v1')).toBe(
            'https://api.x.com/v1',
        );
    });
});

describe('vertexModelFromSaJson', () => {
    const rawSa = JSON.stringify({ project_id: 'proj-alpha', type: 'sa' });
    const b64Sa = Buffer.from(rawSa, 'utf-8').toString('base64');

    it('parses raw JSON and routes a claude-* id through createVertexAnthropic', () => {
        const model = vertexModelFromSaJson(rawSa, 'claude-sonnet-4-6');

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(settingsFor(createVertexAnthropicMock)).toEqual({
            project: 'proj-alpha',
            location: 'global',
            googleAuthOptions: {
                credentials: { project_id: 'proj-alpha', type: 'sa' },
            },
        });
        expect(model).toEqual({
            sdk: 'vertex-anthropic',
            modelId: 'claude-sonnet-4-6',
            settings: expect.objectContaining({ project: 'proj-alpha' }),
        });
    });

    it('routes a non-claude (gemini) id through createVertex', () => {
        vertexModelFromSaJson(rawSa, 'gemini-2.5-pro');

        expect(createVertexMock).toHaveBeenCalledTimes(1);
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
        expect(settingsFor(createVertexMock).project).toBe('proj-alpha');
    });

    it('decodes base64-encoded SA JSON (branch: does not start with "{")', () => {
        vertexModelFromSaJson(b64Sa, 'gemini-2.5-pro');

        expect(createVertexMock).toHaveBeenCalledTimes(1);
        expect(settingsFor(createVertexMock).project).toBe('proj-alpha');
    });

    it('defaults location to "global" when no override given', () => {
        vertexModelFromSaJson(rawSa, 'gemini-2.5-pro');
        expect(settingsFor(createVertexMock).location).toBe('global');
    });

    it('uses a non-empty locationOverride verbatim', () => {
        vertexModelFromSaJson(rawSa, 'gemini-2.5-pro', 'us-central1');
        expect(settingsFor(createVertexMock).location).toBe('us-central1');
    });

    it('falls back to "global" when locationOverride is whitespace only', () => {
        vertexModelFromSaJson(rawSa, 'gemini-2.5-pro', '   ');
        expect(settingsFor(createVertexMock).location).toBe('global');
    });

    it('returns null and builds nothing for empty input', () => {
        expect(vertexModelFromSaJson('', 'gemini-2.5-pro')).toBeNull();
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
    });

    it('returns null for whitespace-only input', () => {
        expect(vertexModelFromSaJson('   ', 'gemini-2.5-pro')).toBeNull();
        expect(createVertexMock).not.toHaveBeenCalled();
    });

    it('returns null when the JSON has no project_id', () => {
        const noProject = JSON.stringify({ type: 'sa' });
        expect(vertexModelFromSaJson(noProject, 'gemini-2.5-pro')).toBeNull();
        expect(createVertexMock).not.toHaveBeenCalled();
    });

    it('returns null when input is neither valid JSON nor valid base64 JSON', () => {
        expect(vertexModelFromSaJson('not-json-at-all', 'gemini')).toBeNull();
        expect(createVertexMock).not.toHaveBeenCalled();
    });
});

describe('vertexModelFromAdc', () => {
    it('returns null and builds nothing when project is empty', () => {
        expect(vertexModelFromAdc('gemini-2.5-pro', '')).toBeNull();
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
    });

    it('routes a claude-* id through createVertexAnthropic with keyless settings', () => {
        vertexModelFromAdc('claude-opus-4-1', 'proj-adc');

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        // No googleAuthOptions in the ADC path — auth is ambient.
        expect(settingsFor(createVertexAnthropicMock)).toEqual({
            project: 'proj-adc',
            location: 'global',
        });
    });

    it('routes a non-claude id through createVertex', () => {
        vertexModelFromAdc('gemini-2.5-pro', 'proj-adc');

        expect(createVertexMock).toHaveBeenCalledTimes(1);
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
        expect(settingsFor(createVertexMock)).toEqual({
            project: 'proj-adc',
            location: 'global',
        });
    });

    it('uses a non-empty locationOverride verbatim', () => {
        vertexModelFromAdc('gemini-2.5-pro', 'proj-adc', 'europe-west1');
        expect(settingsFor(createVertexMock).location).toBe('europe-west1');
    });

    it('falls back to "global" when locationOverride is whitespace only', () => {
        vertexModelFromAdc('gemini-2.5-pro', 'proj-adc', '  ');
        expect(settingsFor(createVertexMock).location).toBe('global');
    });
});

describe('bedrockModelFromCredentials', () => {
    it('defaults region to "us-east-1" when config is undefined', () => {
        const model = bedrockModelFromCredentials(undefined, 'model-x');

        expect(createAmazonBedrockMock).toHaveBeenCalledTimes(1);
        const settings = settingsFor(createAmazonBedrockMock);
        expect(settings.region).toBe('us-east-1');
        // SigV4 path with no fields: empty strings, undefined session token.
        expect(settings.accessKeyId).toBe('');
        expect(settings.secretAccessKey).toBe('');
        expect(settings.sessionToken).toBeUndefined();
        expect(model).toEqual({
            sdk: 'bedrock',
            modelId: 'model-x',
            settings: expect.objectContaining({ region: 'us-east-1' }),
        });
    });

    it('defaults region to "us-east-1" when awsRegion is whitespace only', () => {
        bedrockModelFromCredentials({ awsRegion: '   ' }, 'model-x');
        expect(settingsFor(createAmazonBedrockMock).region).toBe('us-east-1');
    });

    it('uses a provided awsRegion', () => {
        bedrockModelFromCredentials({ awsRegion: 'eu-west-1' }, 'model-x');
        expect(settingsFor(createAmazonBedrockMock).region).toBe('eu-west-1');
    });

    it('takes the bearer-token path and forwards the DECRYPTED apiKey only', () => {
        bedrockModelFromCredentials(
            {
                awsRegion: 'eu-west-1',
                awsBearerToken: 'BEARER_CIPHER',
                // present but must be ignored while a bearer token exists
                awsAccessKeyId: 'AK_CIPHER',
                awsSecretAccessKey: 'SK_CIPHER',
            },
            'model-x',
        );

        expect(decryptMock).toHaveBeenCalledWith('BEARER_CIPHER');
        const settings = settingsFor(createAmazonBedrockMock);
        expect(settings).toEqual({
            region: 'eu-west-1',
            apiKey: 'DEC:BEARER_CIPHER',
        });
        // SigV4 fields must NOT leak into the bearer path.
        expect(settings.accessKeyId).toBeUndefined();
        expect(settings.secretAccessKey).toBeUndefined();
    });

    it('falls through to SigV4 when the bearer token is whitespace only', () => {
        bedrockModelFromCredentials(
            {
                awsBearerToken: '   ',
                awsAccessKeyId: 'AK_CIPHER',
                awsSecretAccessKey: 'SK_CIPHER',
            },
            'model-x',
        );

        const settings = settingsFor(createAmazonBedrockMock);
        expect(settings.apiKey).toBeUndefined();
        expect(settings.accessKeyId).toBe('DEC:AK_CIPHER');
        expect(settings.secretAccessKey).toBe('DEC:SK_CIPHER');
    });

    it('SigV4: decrypts access/secret and includes decrypted session token when present', () => {
        bedrockModelFromCredentials(
            {
                awsRegion: 'us-west-2',
                awsAccessKeyId: 'AK_CIPHER',
                awsSecretAccessKey: 'SK_CIPHER',
                awsSessionToken: 'ST_CIPHER',
            },
            'model-y',
        );

        expect(decryptMock).toHaveBeenCalledWith('AK_CIPHER');
        expect(decryptMock).toHaveBeenCalledWith('SK_CIPHER');
        expect(decryptMock).toHaveBeenCalledWith('ST_CIPHER');
        expect(settingsFor(createAmazonBedrockMock)).toEqual({
            region: 'us-west-2',
            accessKeyId: 'DEC:AK_CIPHER',
            secretAccessKey: 'DEC:SK_CIPHER',
            sessionToken: 'DEC:ST_CIPHER',
        });
    });

    it('SigV4: session token stays undefined (not decrypted) when absent', () => {
        bedrockModelFromCredentials(
            {
                awsAccessKeyId: 'AK_CIPHER',
                awsSecretAccessKey: 'SK_CIPHER',
            },
            'model-y',
        );

        expect(decryptMock).not.toHaveBeenCalledWith(undefined);
        expect(settingsFor(createAmazonBedrockMock).sessionToken).toBeUndefined();
    });

    it('SigV4: missing access key yields empty string (not decrypted)', () => {
        bedrockModelFromCredentials(
            { awsSecretAccessKey: 'SK_CIPHER' },
            'model-y',
        );

        const settings = settingsFor(createAmazonBedrockMock);
        expect(settings.accessKeyId).toBe('');
        expect(settings.secretAccessKey).toBe('DEC:SK_CIPHER');
    });

    it('passes the model id to the inner factory', () => {
        const model = bedrockModelFromCredentials(
            { awsBearerToken: 'B' },
            'anthropic.claude-3',
        );
        expect(model.modelId).toBe('anthropic.claude-3');
    });
});

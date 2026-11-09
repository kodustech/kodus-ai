import { byokAuthKind, isByokSlotConfigured } from './slot-auth';

it.each([
    ['kodus', {}, 'platform'],
    ['openai', { apiKey: 'cipher' }, 'api-key'],
    ['openai', { apiKey: '   ' }, undefined],
    ['amazon_bedrock', { awsBearerToken: 'cipher' }, 'bedrock-bearer'],
    [
        'amazon_bedrock',
        { awsAccessKeyId: 'id', awsSecretAccessKey: 'cipher' },
        'bedrock-iam',
    ],
    [
        'amazon_bedrock',
        {
            awsBearerToken: 'cipher',
            awsAccessKeyId: 'id',
            awsSecretAccessKey: 'secret',
        },
        'bedrock-bearer',
    ],
    ['amazon_bedrock', { awsAccessKeyId: 'id' }, undefined],
] as const)(
    'shares auth presence and priority for %s %j',
    (provider, material, expected) => {
        expect(byokAuthKind(provider, material)).toBe(expected);
        expect(isByokSlotConfigured({ provider, ...material } as any)).toBe(
            expected !== undefined,
        );
    },
);

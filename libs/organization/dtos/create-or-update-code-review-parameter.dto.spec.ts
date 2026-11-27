import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';

import { CreateOrUpdateCodeReviewParameterDto } from './create-or-update-code-review-parameter.dto';

it.each([
    [['riskAssessmentActive', 'riskReviewRouting.noRisk'], true],
    [['__proto__.polluted'], false],
    [['byokModelId'], false],
    ['riskAssessmentActive', false],
])(
    'validates scoped inheritance paths (%j)',
    async (inheritFields, accepted) => {
        const pipe = new ValidationPipe({ transform: true, whitelist: true });
        const result = pipe.transform(
            {
                organizationAndTeamData: { teamId: 'team' },
                configValue: {},
                repositoryId: 'repo',
                inheritFields,
            },
            { type: 'body', metatype: CreateOrUpdateCodeReviewParameterDto },
        );
        if (accepted)
            expect((await result).inheritFields).toEqual(inheritFields);
        else await expect(result).rejects.toThrow();
    },
);

/**
 * Phase 4, plan 04-02 — byokModelId (id-based BYOK override) round-trips through
 * DTO validation as an optional string ALONGSIDE the legacy byokModel NAME
 * override. Both coexist; neither is required (REQ-MODEL-01 / REQ-COMPAT-01).
 *
 * The field lives on the nested `configValue` (CodeReviewConfigWithoutLLMProviderDto),
 * so we validate the whole DTO with `validateNested`-friendly transform to reach it.
 */
describe('CreateOrUpdateCodeReviewParameterDto — byokModelId', () => {
    const buildDto = (configValue: Record<string, unknown>) =>
        plainToInstance(CreateOrUpdateCodeReviewParameterDto, {
            organizationAndTeamData: { teamId: 'team-1' },
            configValue,
        });

    it('accepts byokModelId as an optional string', async () => {
        const dto = buildDto({ byokModelId: 'm-B' });
        const errors = await validate(dto, {
            whitelist: false,
            forbidUnknownValues: false,
        });
        // No error targeting the nested byokModelId field.
        const flat = JSON.stringify(errors);
        expect(flat).not.toContain('byokModelId');
    });

    it('accepts byokModelId and the legacy byokModel together (both coexist)', async () => {
        const dto = buildDto({ byokModelId: 'm-B', byokModel: 'gpt-5-mini' });
        const errors = await validate(dto, {
            whitelist: false,
            forbidUnknownValues: false,
        });
        const flat = JSON.stringify(errors);
        expect(flat).not.toContain('byokModelId');
        expect(flat).not.toContain('byokModel');
    });

    it('accepts a config with neither override set (both optional)', async () => {
        const dto = buildDto({ automatedReviewActive: true });
        const errors = await validate(dto, {
            whitelist: false,
            forbidUnknownValues: false,
        });
        const flat = JSON.stringify(errors);
        expect(flat).not.toContain('byokModelId');
        expect(flat).not.toContain('byokModel');
    });

    it('rejects a non-string byokModelId', async () => {
        const dto = buildDto({ byokModelId: 123 as unknown as string });
        const errors = await validate(dto, {
            whitelist: false,
            forbidUnknownValues: false,
        });
        expect(JSON.stringify(errors)).toContain('byokModelId');
    });
});

describe('independent risk configuration validation', () => {
    const criterion = {
        id: 'access',
        name: 'Access',
        enabled: true,
        instructions: 'Check tenant isolation.',
        includedFiles: ['src/**/*.{ts,tsx}'],
        excludedFiles: ['**/*.test.ts'],
    };
    const errorsFor = async (configValue: Record<string, unknown>) =>
        validate(
            plainToInstance(CreateOrUpdateCodeReviewParameterDto, {
                organizationAndTeamData: { teamId: 'team-1' },
                configValue,
            }),
            { whitelist: true, forbidNonWhitelisted: true },
        );

    it('preserves risk criteria and policies through the API implicit-conversion pipe', async () => {
        const configValue = {
            riskAssessmentActive: true,
            riskCriteria: [criterion],
            approvalPolicies: [{ id: 'docs', name: 'Docs', enabled: false }],
        };
        const pipe = new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: true },
        });
        const result = await pipe
            .transform(
                {
                    organizationAndTeamData: { teamId: 'team-1' },
                    configValue,
                },
                {
                    type: 'body',
                    metatype: CreateOrUpdateCodeReviewParameterDto,
                },
            )
            .catch((error) => {
                throw new Error(JSON.stringify(error.getResponse()));
            });
        expect(result.configValue).toMatchObject(configValue);
        expect(JSON.parse(JSON.stringify(result.configValue))).toEqual(
            configValue,
        );
    });

    it('allows risk enabled with approval disabled and criteria omitted', async () => {
        expect(
            await errorsFor({
                riskAssessmentActive: true,
                pullRequestApprovalActive: false,
            }),
        ).toEqual([]);
    });
    it('round-trips array globs and both review modes without changing brace syntax', async () => {
        expect(
            await errorsFor({
                riskCriteria: [criterion],
                riskReviewRouting: { noRisk: 'balanced', riskFound: 'heavy' },
            }),
        ).toEqual([]);
    });
    it('stores risk criteria as parsed: trimmed ids, no unknown keys', async () => {
        const dto = plainToInstance(CreateOrUpdateCodeReviewParameterDto, {
            organizationAndTeamData: { teamId: 'team-1' },
            configValue: {
                riskCriteria: [
                    { id: ' kodus-data ', enabled: false, source: 'kodus' },
                ],
            },
        });
        expect(
            await validate(dto, {
                whitelist: true,
                forbidNonWhitelisted: true,
            }),
        ).toEqual([]);
        expect((dto.configValue as any).riskCriteria).toEqual([
            { id: 'kodus-data', enabled: false },
        ]);
    });
    it('accepts a routing delta without resetting the inherited other result', async () => {
        expect(
            await errorsFor({ riskReviewRouting: { noRisk: 'heavy' } }),
        ).toEqual([]);
        expect(
            await errorsFor({ riskReviewRouting: { riskFound: 'balanced' } }),
        ).toEqual([]);
    });
    it.each([
        { riskCriteria: [{ ...criterion, instructions: 42 }] },
        { riskCriteria: [criterion, criterion] },
        { riskCriteria: [{ id: 'kodus-securty', enabled: false }] },
        { riskCriteria: [{ ...criterion, includedFiles: '**/*.ts' }] },
        { riskCriteria: [{ ...criterion, includedFiles: ['src/['] }] },
        { riskCriteria: [{ ...criterion, excludedFiles: ['!src/**'] }] },
        { riskReviewRouting: { noRisk: 'light', riskFound: 'heavy' } },
        { riskAssessmentActive: 'true' },
        { riskAssessmentActive: null },
        { riskCriteria: null },
        { riskReviewRouting: null },
        { approvalPolicies: null },
    ])(
        'rejects malformed or ambiguous risk configuration %j',
        async (config) => {
            expect((await errorsFor(config)).length).toBeGreaterThan(0);
        },
    );
});

/**
 * #2576: the organization-wide `conversation.implicitReplies` opt-out has to
 * survive the API's own pipe - `transform`, `whitelist` and
 * `forbidNonWhitelisted` - or the settings endpoint answers 400 before the
 * value is ever stored.
 */
describe('CreateOrUpdateCodeReviewParameterDto — conversation.implicitReplies', () => {
    const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
    });
    const through = (configValue: Record<string, unknown>) =>
        pipe.transform(
            {
                organizationAndTeamData: { teamId: 'team-1' },
                configValue,
            },
            {
                type: 'body',
                metatype: CreateOrUpdateCodeReviewParameterDto,
            },
        );

    it('accepts the opt-out through the API pipe', async () => {
        const result = await through({
            conversation: { implicitReplies: false },
        });

        expect(result.configValue.conversation).toEqual({
            implicitReplies: false,
        });
    });

    it('rejects a key the nested conversation config does not declare', async () => {
        const response = await through({
            conversation: { implicitReplies: false, answerEveryone: true },
        }).catch((error) => error.getResponse());

        // Before the nested DTO existed the pipe rejected the whole
        // `conversation` object without ever naming the key inside it, so
        // asserting the key is what pins the declaration.
        expect(JSON.stringify(response)).toContain('answerEveryone');
    });

    const rejection = async (configValue: Record<string, unknown>) => {
        try {
            await through(configValue);
        } catch (error) {
            return (error as { getResponse: () => unknown }).getResponse();
        }
        throw new Error('expected the pipe to reject');
    };

    // Implicit conversion turned these strings into `true`: the request
    // returned 201 and erased a stored opt-out. `0` was stored as `false`.
    it.each([['false'], ['no'], ['off'], ['true'], [0], [1], [null]])(
        'rejects a non-boolean implicitReplies (%j)',
        async (value) => {
            await expect(
                rejection({ conversation: { implicitReplies: value } }),
            ).resolves.toEqual({
                statusCode: 400,
                message: [
                    'configValue.conversation.implicitReplies must be a boolean value',
                ],
                error: 'Bad Request',
            });
        },
    );

    it.each([
        [
            null,
            [
                'configValue.conversation must be an object',
                'configValue.nested property conversation must be either object or array',
            ],
        ],
        [
            [{ implicitReplies: false }],
            ['configValue.conversation must be an object'],
        ],
        [
            'off',
            [
                'configValue.conversation must be an object',
                'configValue.nested property conversation must be either object or array',
            ],
        ],
    ])(
        'rejects a conversation block that is not an object (%j)',
        async (conversation, message) => {
            await expect(rejection({ conversation })).resolves.toEqual({
                statusCode: 400,
                message,
                error: 'Bad Request',
            });
        },
    );

    it('keeps an opt-in as the boolean true', async () => {
        const result = await through({
            conversation: { implicitReplies: true },
        });

        expect(result.configValue.conversation).toEqual({
            implicitReplies: true,
        });
    });
});

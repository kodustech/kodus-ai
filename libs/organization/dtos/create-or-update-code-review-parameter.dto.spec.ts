import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';

import { CreateOrUpdateCodeReviewParameterDto } from './create-or-update-code-review-parameter.dto';

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

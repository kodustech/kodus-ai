import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

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

    it('rejects an unsupported review policy version at the API boundary', async () => {
        const dto = buildDto({ reviewPolicy: { version: '2' } });
        const errors = await validate(dto, {
            whitelist: false,
            forbidUnknownValues: false,
        });

        expect(JSON.stringify(errors)).toContain('version');
    });

    it('rejects an unsupported review planner strategy at the API boundary', async () => {
        const dto = buildDto({
            reviewPolicy: { planner: { strategy: 'unknown' } },
        });
        const errors = await validate(dto, {
            whitelist: false,
            forbidUnknownValues: false,
        });

        expect(JSON.stringify(errors)).toContain('strategy');
    });
});

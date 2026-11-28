import '@libs/llm/providers'; // self-register provider modules (routing capability gate)
import { LLM_TASK } from '@libs/llm/llm-tasks';

import {
    PermissionValidationService,
    ValidationErrorType,
} from './permissionValidation.service';

jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true, API_DEVELOPMENT_MODE: false },
}));

/**
 * A caller other than the review (the Kody Runtime) runs the same gate for its
 * own task: the license, the plan's BYOK requirement, the Kodus credits and the
 * "a broken credential never falls to the managed key" rule all apply to the
 * slot of that task. A caller with no PR author skips only the per-user seat.
 */
describe('PermissionValidationService — the gate for another task', () => {
    const orgTeam = {
        organizationId: '0a1b2c3d-0000-4000-8000-00000000c0de',
        teamId: 'team-1',
    } as any;
    const RUNTIME = {
        task: LLM_TASK.runtime,
        requireUserSeat: false,
    } as const;
    const CTX = 'RuntimeLlmPermission';

    const ownKey = {
        version: 2,
        credentials: [{ id: 'c1', provider: 'anthropic', apiKey: 'enc' }],
        models: [{ id: 'm1', credentialId: 'c1', model: 'claude-sonnet-5' }],
        routing: { mode: 'manual', defaultModelId: 'm1', taskOverrides: {} },
    };
    const kodus = {
        version: 2,
        credentials: [{ id: 'kd', provider: 'kodus' }],
        models: [
            {
                id: 'm1',
                credentialId: 'kd',
                model: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            },
        ],
        routing: { mode: 'manual', defaultModelId: 'm1', taskOverrides: {} },
    };
    // The runtime task names a model whose credential carries no auth material.
    const brokenRuntime = {
        version: 2,
        credentials: [
            { id: 'c1', provider: 'anthropic', apiKey: 'enc' },
            {
                id: 'c2',
                provider: 'amazon_bedrock',
                settings: { awsRegion: 'us-east-1' },
            },
        ],
        models: [
            { id: 'm1', credentialId: 'c1', model: 'claude-sonnet-5' },
            {
                id: 'm2',
                credentialId: 'c2',
                model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            },
        ],
        routing: {
            mode: 'manual',
            defaultModelId: 'm1',
            taskOverrides: { [LLM_TASK.runtime]: 'm2' },
        },
    };

    const makeService = (
        validation: Record<string, unknown>,
        config: unknown,
    ) => {
        const licenseService = {
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true, ...validation }),
            getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
        };
        const orgParams = {
            findByKey: jest
                .fn()
                .mockResolvedValue(config ? { configValue: config } : null),
        };
        return new PermissionValidationService(
            licenseService as any,
            orgParams as any,
        );
    };

    it('refuses a FREE or BYOK plan with no key of its own: never the managed key', async () => {
        for (const planType of ['free', 'teams_byok']) {
            const svc = makeService(
                { subscriptionStatus: 'active', planType },
                null,
            );
            const res = await svc.validateExecutionPermissions(
                orgTeam,
                undefined,
                CTX,
                RUNTIME,
            );
            expect(res).toMatchObject({
                allowed: false,
                errorType: ValidationErrorType.BYOK_REQUIRED,
            });
        }
    });

    it('refuses an invalid license', async () => {
        const svc = makeService({ valid: false }, ownKey);
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            CTX,
            RUNTIME,
        );
        expect(res).toMatchObject({
            allowed: false,
            errorType: ValidationErrorType.INVALID_LICENSE,
        });
    });

    it('refuses a Kodus-routed slot once the credits are gone', async () => {
        const svc = makeService(
            {
                subscriptionStatus: 'active',
                planType: 'teams_managed',
                creditBalanceUsd: 0,
            },
            kodus,
        );
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            CTX,
            RUNTIME,
        );
        expect(res.errorType).toBe(ValidationErrorType.CREDITS_EXHAUSTED);
    });

    it("refuses a runtime model whose credential is broken, outside a trial, instead of using Kodus's key", async () => {
        const svc = makeService(
            { subscriptionStatus: 'active', planType: 'teams_managed' },
            brokenRuntime,
        );
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            CTX,
            RUNTIME,
        );
        expect(res).toMatchObject({
            allowed: false,
            errorType: ValidationErrorType.BYOK_REQUIRED,
            metadata: { byokModelUnresolvable: true },
        });
    });

    it('allows a managed plan with no PR author, and hands back the slot of the task asked', async () => {
        const svc = makeService(
            { subscriptionStatus: 'active', planType: 'teams_managed' },
            ownKey,
        );
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            CTX,
            RUNTIME,
        );
        expect(res.allowed).toBe(true);
        expect(res.byokConfig?.model).toBe('claude-sonnet-5');
    });

    it('the code review keeps its per-user seat: no author on a managed plan is not allowed', async () => {
        const svc = makeService(
            { subscriptionStatus: 'active', planType: 'teams_managed' },
            ownKey,
        );
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            'ValidatePrerequisitesStage',
        );
        expect(res.allowed).toBe(false);
        expect(res.errorType).toBe(ValidationErrorType.NOT_ERROR);
    });
});

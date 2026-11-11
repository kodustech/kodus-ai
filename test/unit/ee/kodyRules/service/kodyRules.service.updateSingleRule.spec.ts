/**
 * updateRuleReferences / updateRuleDetector / updateRuleCompileAttempt write
 * one rule without loading the organization's whole Kody Rules document.
 *
 * These tests pin the contract callers rely on: which fields are written,
 * that `null` clears and `undefined` is skipped, the NotFoundException
 * messages, and the returned rule.
 */

import { NotFoundException } from '@nestjs/common';

import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';

describe('KodyRulesService single-rule updates', () => {
    const ORG = 'org-1';
    const RULE = 'rule-1';

    /**
     * `updated`: what the repository's single-rule $set returns (null = no
     * document of the organization holds the rule). `exists`: whether the
     * organization has a Kody Rules document at all.
     */
    const buildService = ({
        updated = { uuid: RULE } as unknown,
        exists = true,
    } = {}) => {
        const repositoryMock = {
            findByOrganizationId: jest.fn(),
            updateRule: jest.fn(),
            updateRuleFieldsByOrganization: jest
                .fn()
                .mockResolvedValue(updated),
            existsForOrganization: jest.fn().mockResolvedValue(exists),
        };
        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        const writtenFields = () =>
            repositoryMock.updateRuleFieldsByOrganization.mock.calls[0][2];
        return { service, repositoryMock, writtenFields };
    };

    const updates: Array<
        [string, (service: KodyRulesService) => Promise<unknown>]
    > = [
        [
            'updateRuleReferences',
            (s) =>
                s.updateRuleReferences(ORG, RULE, { contextReferenceId: 'x' }),
        ],
        ['updateRuleDetector', (s) => s.updateRuleDetector(ORG, RULE, null)],
        [
            'updateRuleCompileAttempt',
            (s) => s.updateRuleCompileAttempt(ORG, RULE, null),
        ],
    ];

    it.each(updates)(
        '%s writes through the single-rule $set, never the whole document',
        async (_name, run) => {
            const { service, repositoryMock } = buildService();

            await run(service);

            expect(repositoryMock.findByOrganizationId).not.toHaveBeenCalled();
            expect(repositoryMock.updateRule).not.toHaveBeenCalled();
            expect(
                repositoryMock.updateRuleFieldsByOrganization,
            ).toHaveBeenCalledWith(ORG, RULE, expect.any(Object));
        },
    );

    it.each(updates)(
        '%s throws "Kody rules not found for organization" when the organization has no document',
        async (_name, run) => {
            const { service } = buildService({ updated: null, exists: false });
            await expect(run(service)).rejects.toThrow(
                new NotFoundException('Kody rules not found for organization'),
            );
        },
    );

    it.each(updates)(
        '%s throws "Rule not found" when the organization exists but the rule does not',
        async (_name, run) => {
            const { service } = buildService({ updated: null, exists: true });
            await expect(run(service)).rejects.toThrow(
                new NotFoundException('Rule not found'),
            );
        },
    );

    describe('updateRuleReferences', () => {
        it('writes contextReferenceId and updatedAt only, and returns the stored rule', async () => {
            const stored = {
                uuid: RULE,
                title: 't',
                contextReferenceId: 'ctx-2',
            };
            const { service, writtenFields } = buildService({
                updated: stored,
            });

            const result = await service.updateRuleReferences(ORG, RULE, {
                contextReferenceId: 'ctx-2',
            });

            expect(result).toEqual(stored);
            expect(Object.keys(writtenFields()).sort()).toEqual([
                'contextReferenceId',
                'updatedAt',
            ]);
            expect(writtenFields().contextReferenceId).toBe('ctx-2');
            expect(writtenFields().updatedAt).toBeInstanceOf(Date);
        });

        it('passes null through so the pointer is cleared', async () => {
            const { service, writtenFields } = buildService();
            await service.updateRuleReferences(ORG, RULE, {
                contextReferenceId: null,
            });
            expect(writtenFields()).toHaveProperty('contextReferenceId', null);
        });

        it('leaves an undefined contextReferenceId for the repository to skip', async () => {
            const { service, writtenFields } = buildService();
            await service.updateRuleReferences(ORG, RULE, {});
            expect(writtenFields().contextReferenceId).toBeUndefined();
        });
    });

    describe('updateRuleDetector', () => {
        it('writes detector and updatedAt only, and returns the stored rule', async () => {
            const detector = { pattern: 'console\\.log', extensions: ['.ts'] };
            const { service, writtenFields } = buildService({
                updated: { uuid: RULE, detector },
            });

            const result = await service.updateRuleDetector(
                ORG,
                RULE,
                detector as any,
            );

            expect(result).toEqual({ uuid: RULE, detector });
            expect(Object.keys(writtenFields()).sort()).toEqual([
                'detector',
                'updatedAt',
            ]);
            expect(writtenFields().detector).toEqual(detector);
        });

        it('passes a null detector through so a stale detector is cleared', async () => {
            const { service, writtenFields } = buildService();
            await service.updateRuleDetector(ORG, RULE, null);
            expect(writtenFields()).toHaveProperty('detector', null);
        });
    });

    describe('updateRuleCompileAttempt', () => {
        it('writes compileAttempt and updatedAt only', async () => {
            const attempt = {
                outcome: 'compiled',
                at: new Date('2026-11-10T00:00:00.000Z'),
            };
            const { service, writtenFields } = buildService();

            await service.updateRuleCompileAttempt(ORG, RULE, attempt as any);

            expect(Object.keys(writtenFields()).sort()).toEqual([
                'compileAttempt',
                'updatedAt',
            ]);
            expect(writtenFields().compileAttempt).toEqual(attempt);
        });

        it('passes null through so the next sweep recompiles', async () => {
            const { service, writtenFields } = buildService();
            await service.updateRuleCompileAttempt(ORG, RULE, null);
            expect(writtenFields()).toHaveProperty('compileAttempt', null);
        });
    });
});

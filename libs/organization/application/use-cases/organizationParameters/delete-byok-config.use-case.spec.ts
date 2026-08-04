import { BadRequestException } from '@nestjs/common';
import type { BYOKConfig } from '@libs/llm/byok-config';

import {
    DeleteByokConfigUseCase,
    findRepoFolderModelReferences,
} from './delete-byok-config.use-case';
import { OrganizationParametersService } from '@libs/organization/infrastructure/adapters/services/organizationParameters.service';

const ORG = 'org-1';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Two credentials, two models, routing pointing default→m1, override→m2. */
function v2Config(overrides: Partial<BYOKConfig> = {}): BYOKConfig {
    return {
        version: 2,
        credentials: [
            { id: 'cred-openai', provider: 'openai', apiKey: 'CIPHERTEXT_A' },
            { id: 'cred-anthropic', provider: 'anthropic', apiKey: 'CIPHERTEXT_B' },
        ],
        models: [
            { id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' },
            { id: 'm2', credentialId: 'cred-anthropic', model: 'claude-opus-4-8' },
        ],
        routing: { mode: 'manual', defaultModelId: 'm1' },
        ...overrides,
    };
}

function buildUseCase(opts: {
    byokConfig: unknown;
    codeReviewConfig?: unknown;
}) {
    const deleteByokModel = jest.fn().mockResolvedValue(true);
    const deleteByokConfig = jest.fn().mockResolvedValue(true);
    const organizationParametersService = {
        findByKey: jest
            .fn()
            .mockResolvedValue(
                opts.byokConfig ? { configValue: opts.byokConfig } : null,
            ),
        deleteByokModel,
        deleteByokConfig,
    } as any;
    const parametersService = {
        findByKey: jest
            .fn()
            .mockResolvedValue(
                opts.codeReviewConfig
                    ? { configValue: opts.codeReviewConfig }
                    : null,
            ),
    } as any;
    const useCase = new DeleteByokConfigUseCase(
        organizationParametersService,
        parametersService,
    );
    return { useCase, deleteByokModel, deleteByokConfig, organizationParametersService };
}

describe('DeleteByokConfigUseCase — legacy slot delete dropped (04b-06)', () => {
    it('rejects a legacy main/fallback string target (v2-only: delete by modelId)', async () => {
        const { useCase, deleteByokConfig, deleteByokModel } = buildUseCase({
            byokConfig: v2Config(),
        });

        await expect(useCase.execute(ORG, 'main')).rejects.toThrow(
            BadRequestException,
        );
        await expect(useCase.execute(ORG, 'fallback')).rejects.toThrow(
            /modelId is required/,
        );
        // The legacy slot-delete delegation is gone; neither path runs.
        expect(deleteByokConfig).not.toHaveBeenCalled();
        expect(deleteByokModel).not.toHaveBeenCalled();
    });
});

describe('DeleteByokConfigUseCase — v2 referential-integrity guard (REQ-DELETE-01)', () => {
    it('(a) rejects a model referenced by routing, naming the routing keys', async () => {
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: v2Config({
                routing: {
                    mode: 'manual',
                    defaultModelId: 'm1',
                    fallbackModelId: 'm1',
                    taskOverrides: { codeReview: 'm1' },
                },
            }),
        });

        await expect(
            useCase.execute(ORG, { modelId: 'm1' }),
        ).rejects.toThrow(BadRequestException);

        try {
            await useCase.execute(ORG, { modelId: 'm1' });
        } catch (err) {
            const msg = (err as BadRequestException).message;
            expect(msg).toContain('routing.defaultModelId');
            expect(msg).toContain('routing.fallbackModelId');
            expect(msg).toContain('routing.taskOverrides.codeReview');
            expect(msg).toContain('cannot be deleted');
        }
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('(b) rejects a model referenced by a repo/folder byokModelId override, naming the scope', async () => {
        const codeReviewConfig = {
            configs: {},
            repositories: [
                {
                    id: 'r1',
                    name: 'acme/api',
                    configs: { byokModelId: 'm2' },
                    directories: [
                        {
                            id: 'd1',
                            name: 'src/payments',
                            configs: { byokModelId: 'm2' },
                        },
                    ],
                },
            ],
        };
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: v2Config(),
            codeReviewConfig,
        });

        try {
            await useCase.execute(ORG, { modelId: 'm2' });
            throw new Error('expected rejection');
        } catch (err) {
            const msg = (err as BadRequestException).message;
            expect(msg).toContain('acme/api');
            expect(msg).toContain('src/payments');
            expect(msg).toContain('byokModelId');
        }
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('also rejects a legacy byokModel NAME override that matches the deleted model name', async () => {
        const codeReviewConfig = {
            configs: {},
            repositories: [
                {
                    id: 'r1',
                    name: 'acme/web',
                    configs: { byokModel: 'claude-opus-4-8' },
                    directories: [],
                },
            ],
        };
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: v2Config(),
            codeReviewConfig,
        });

        await expect(
            useCase.execute(ORG, { modelId: 'm2' }),
        ).rejects.toThrow(/acme\/web/);
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('(c) delegates to deleteByokModel for an unreferenced model (guard clear)', async () => {
        // m2 is not referenced by routing (default→m1) and there are no overrides.
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: v2Config(),
            codeReviewConfig: { configs: {}, repositories: [] },
        });

        await expect(
            useCase.execute(ORG, { modelId: 'm2' }),
        ).resolves.toBe(true);
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'm2');
    });

    it('rejects a model-level delete against a legacy (non-v2) config', async () => {
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: { main: { provider: 'openai', apiKey: 'x' } },
        });
        await expect(
            useCase.execute(ORG, { modelId: 'm2' }),
        ).rejects.toThrow(/BYOK configuration/);
        expect(deleteByokModel).not.toHaveBeenCalled();
    });
});

describe('findRepoFolderModelReferences', () => {
    it('returns [] when nothing references the model', () => {
        expect(
            findRepoFolderModelReferences(
                { configs: {}, repositories: [] },
                'm1',
                'gpt-5',
            ),
        ).toEqual([]);
    });

    it('treats an empty-string override as inherit (not a reference)', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: { byokModel: '   ', byokModelId: '' },
                    repositories: [],
                },
                'm1',
                'gpt-5',
            ),
        ).toEqual([]);
    });
});

// ── Service-level behaviors (removal / orphan credential / disconnect) ───────

function buildService(configValue: unknown) {
    const del = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn().mockResolvedValue({ uuid: 'p1' });
    const repository = {
        findByKey: jest
            .fn()
            .mockResolvedValue(
                configValue ? { uuid: 'p1', configValue } : null,
            ),
        delete: del,
        update,
    } as any;
    const service = new OrganizationParametersService(repository);
    return { service, del, update };
}

describe('OrganizationParametersService.deleteByokModel — v2 removal', () => {
    it('removes an unused model and its now-orphan non-managed credential, preserving ciphertext', async () => {
        const { service, update, del } = buildService(v2Config());

        await expect(service.deleteByokModel(ORG, 'm2')).resolves.toBe(true);
        expect(del).not.toHaveBeenCalled();

        const written = update.mock.calls[0][1].configValue as BYOKConfig;
        expect(written.models.map((m) => m.id)).toEqual(['m1']);
        // cred-anthropic is orphaned (only m2 referenced it) → removed.
        expect(written.credentials.map((c) => c.id)).toEqual(['cred-openai']);
        // Retained credential's ciphertext is written back verbatim.
        expect(written.credentials[0].apiKey).toBe('CIPHERTEXT_A');
    });

    it('keeps a credential that a remaining model still references', async () => {
        const shared = v2Config({
            models: [
                { id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' },
                { id: 'm2', credentialId: 'cred-openai', model: 'gpt-5-mini' },
            ],
            routing: { mode: 'manual', defaultModelId: 'm1' },
        });
        const { service, update } = buildService(shared);

        await service.deleteByokModel(ORG, 'm2');
        const written = update.mock.calls[0][1].configValue as BYOKConfig;
        expect(written.credentials.map((c) => c.id)).toContain('cred-openai');
    });

    it('always keeps a managed credential even when no model references it', async () => {
        const withManaged = v2Config({
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: 'CIPHERTEXT_A' },
                { id: 'cred-anthropic', provider: 'anthropic', apiKey: 'CIPHERTEXT_B' },
                { id: 'cred-managed', provider: 'openai', managed: true },
            ],
        });
        const { service, update } = buildService(withManaged);

        await service.deleteByokModel(ORG, 'm2');
        const written = update.mock.calls[0][1].configValue as BYOKConfig;
        expect(written.credentials.map((c) => c.id)).toEqual([
            'cred-openai',
            'cred-managed',
        ]);
    });

    it('performs the last-model disconnect (removes the whole config) rather than leaving an empty pool', async () => {
        const single = v2Config({
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: 'CIPHERTEXT_A' },
            ],
            models: [{ id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' }],
            routing: { mode: 'manual' },
        });
        const { service, del, update } = buildService(single);

        await expect(service.deleteByokModel(ORG, 'm1')).resolves.toBe(true);
        expect(del).toHaveBeenCalledWith('p1');
        expect(update).not.toHaveBeenCalled();
    });

    it('throws when the model id does not exist', async () => {
        const { service } = buildService(v2Config());
        await expect(
            service.deleteByokModel(ORG, 'does-not-exist'),
        ).rejects.toThrow(BadRequestException);
    });

    it('throws on a non-v2 (legacy) config', async () => {
        const { service } = buildService({ main: { provider: 'openai' } });
        await expect(service.deleteByokModel(ORG, 'm1')).rejects.toThrow(
            /BYOK configuration/,
        );
    });
});

describe('OrganizationParametersService.deleteByokConfig — legacy regression (byte-identical)', () => {
    it('deletes the whole config when removing main with no fallback', async () => {
        const { service, del } = buildService({
            main: { provider: 'openai', apiKey: 'x' },
        });
        await expect(service.deleteByokConfig(ORG, 'main')).resolves.toBe(true);
        expect(del).toHaveBeenCalledWith('p1');
    });

    it('removes only the fallback slot when both exist', async () => {
        const { service, update } = buildService({
            main: { provider: 'openai', apiKey: 'x' },
            fallback: { provider: 'anthropic', apiKey: 'y' },
        });
        await expect(service.deleteByokConfig(ORG, 'fallback')).resolves.toBe(
            true,
        );
        const written = update.mock.calls[0][1].configValue;
        expect(written).toEqual({ main: { provider: 'openai', apiKey: 'x' } });
    });

    it('throws when the requested slot is absent', async () => {
        const { service } = buildService({
            main: { provider: 'openai', apiKey: 'x' },
        });
        await expect(service.deleteByokConfig(ORG, 'fallback')).rejects.toThrow(
            BadRequestException,
        );
    });
});

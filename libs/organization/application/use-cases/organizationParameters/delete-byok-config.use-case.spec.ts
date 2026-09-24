import { BadRequestException } from '@nestjs/common';
import type { BYOKConfig } from '@libs/llm/byok-config';

import {
    DeleteByokConfigUseCase,
    findRepoFolderModelReferences,
} from './delete-byok-config.use-case';
import { OrganizationParametersService } from '@libs/organization/infrastructure/adapters/services/organizationParameters.service';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

const ORG = 'org-1';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Two credentials, two models, routing pointing default→m1, override→m2. */
function makeByokConfig(overrides: Partial<BYOKConfig> = {}): BYOKConfig {
    return {
        version: 2,
        credentials: [
            { id: 'cred-openai', provider: 'openai', apiKey: 'CIPHERTEXT_A' },
            {
                id: 'cred-anthropic',
                provider: 'anthropic',
                apiKey: 'CIPHERTEXT_B',
            },
        ],
        models: [
            { id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' },
            {
                id: 'm2',
                credentialId: 'cred-anthropic',
                model: 'claude-opus-4-8',
            },
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
    return {
        useCase,
        deleteByokModel,
        deleteByokConfig,
        organizationParametersService,
    };
}

describe('DeleteByokConfigUseCase — legacy slot delete dropped (04b-06)', () => {
    it('rejects a legacy main/fallback string target (delete by modelId)', async () => {
        const { useCase, deleteByokConfig, deleteByokModel } = buildUseCase({
            byokConfig: makeByokConfig(),
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

describe('DeleteByokConfigUseCase — referential-integrity guard (REQ-DELETE-01)', () => {
    it('(a) rejects a model referenced by routing, naming the routing keys', async () => {
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: makeByokConfig({
                routing: {
                    mode: 'manual',
                    defaultModelId: 'm1',
                    fallbackModelId: 'm1',
                    taskOverrides: { codeReview: 'm1' },
                },
            }),
        });

        await expect(useCase.execute(ORG, { modelId: 'm1' })).rejects.toThrow(
            BadRequestException,
        );

        try {
            await useCase.execute(ORG, { modelId: 'm1' });
        } catch (err) {
            const msg = (err as BadRequestException).message;
            expect(msg).toContain('your organization default model');
            expect(msg).toContain('your fallback model');
            expect(msg).toContain('the Code Review model');
            expect(msg).toContain('cannot be deleted');
        }
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('(a2) ALLOWS deleting the last model even when routing + a repo override point at it (full disconnect)', async () => {
        // A single model that IS the org default / fallback AND is targeted by a
        // repo override. In a multi-model config every one of these refs would
        // reject the delete — but this is the ONLY model, so deleting it is a full
        // BYOK disconnect: deleteByokModel tears down the whole config (routing
        // included) and the repo override degrades to the managed default. The
        // guard must not dead-end this (there is nothing to reassign to).
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: {
                version: 2,
                credentials: [
                    {
                        id: 'cred-openai',
                        provider: 'openai',
                        apiKey: 'CIPHERTEXT_A',
                    },
                ],
                models: [
                    { id: 'only', credentialId: 'cred-openai', model: 'gpt-5' },
                ],
                routing: {
                    mode: 'manual',
                    defaultModelId: 'only',
                    fallbackModelId: 'only',
                    taskOverrides: { codeReview: 'only' },
                },
            },
            codeReviewConfig: {
                configs: {},
                repositories: [
                    {
                        id: 'r1',
                        name: 'acme/api',
                        configs: { byokModelId: 'only' },
                    },
                ],
            },
        });

        await expect(useCase.execute(ORG, { modelId: 'only' })).resolves.toBe(
            true,
        );
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'only');
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
            byokConfig: makeByokConfig(),
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
            byokConfig: makeByokConfig(),
            codeReviewConfig,
        });

        await expect(useCase.execute(ORG, { modelId: 'm2' })).rejects.toThrow(
            /acme\/web/,
        );
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('(c) delegates to deleteByokModel for an unreferenced model (guard clear)', async () => {
        // m2 is not referenced by routing (default→m1) and there are no overrides.
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: makeByokConfig(),
            codeReviewConfig: { configs: {}, repositories: [] },
        });

        await expect(useCase.execute(ORG, { modelId: 'm2' })).resolves.toBe(
            true,
        );
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'm2');
    });

    it('rejects a model-level delete against a legacy config', async () => {
        const { useCase, deleteByokModel } = buildUseCase({
            byokConfig: { main: { provider: 'openai', apiKey: 'x' } },
        });
        await expect(useCase.execute(ORG, { modelId: 'm2' })).rejects.toThrow(
            /BYOK configuration/,
        );
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

describe('OrganizationParametersService.deleteByokModel — model removal', () => {
    it('removes an unused model and its now-orphan non-managed credential, preserving ciphertext', async () => {
        const { service, update, del } = buildService(makeByokConfig());

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
        const shared = makeByokConfig({
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
        const withManaged = makeByokConfig({
            credentials: [
                {
                    id: 'cred-openai',
                    provider: 'openai',
                    apiKey: 'CIPHERTEXT_A',
                },
                {
                    id: 'cred-anthropic',
                    provider: 'anthropic',
                    apiKey: 'CIPHERTEXT_B',
                },
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
        const single = makeByokConfig({
            credentials: [
                {
                    id: 'cred-openai',
                    provider: 'openai',
                    apiKey: 'CIPHERTEXT_A',
                },
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
        const { service } = buildService(makeByokConfig());
        await expect(
            service.deleteByokModel(ORG, 'does-not-exist'),
        ).rejects.toThrow(BadRequestException);
    });

    it('throws on a legacy config', async () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Mutation-killing coverage for the deterministic logic (scopeReference via the
// exported traversal, findRepoFolderModelReferences, and execute). Every branch
// is exercised both ways, literals/labels/separators are pinned, and boundaries
// (last-model filter, usages length, default fallbacks) are asserted exactly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a use-case with fully controllable stub services so execute() branches
 * (rejection in the code-review lookup, missing configValue, etc.) can be driven
 * precisely — buildUseCase() above only supports the happy resolve path.
 */
function buildExecuteHarness(opts: {
    byokConfig?: unknown;
    byokEntity?: unknown; // full entity override (takes precedence over byokConfig)
    crConfig?: unknown;
    crRejects?: boolean;
    deleteResult?: boolean;
}) {
    const deleteByokModel = jest
        .fn()
        .mockResolvedValue(opts.deleteResult ?? true);
    const orgFindByKey = jest
        .fn()
        .mockResolvedValue(
            'byokEntity' in opts
                ? opts.byokEntity
                : opts.byokConfig
                  ? { configValue: opts.byokConfig }
                  : null,
        );
    const organizationParametersService = {
        findByKey: orgFindByKey,
        deleteByokModel,
    } as any;

    const paramFindByKey = jest.fn();
    if (opts.crRejects) {
        paramFindByKey.mockRejectedValue(new Error('DB down'));
    } else {
        paramFindByKey.mockResolvedValue(
            'crConfig' in opts ? { configValue: opts.crConfig } : null,
        );
    }
    const parametersService = { findByKey: paramFindByKey } as any;

    const useCase = new DeleteByokConfigUseCase(
        organizationParametersService,
        parametersService,
    );
    return {
        useCase,
        deleteByokModel,
        orgFindByKey,
        paramFindByKey,
    };
}

describe('scopeReference (via findRepoFolderModelReferences global scope)', () => {
    // scopeReference is a private free function; the global-scope branch of
    // findRepoFolderModelReferences is a single-scope probe of it. The returned
    // label embeds the matched FIELD NAME, so we can assert exactly which arm hit.
    const probe = (configs: unknown, modelId = 'm1', modelName?: string) =>
        findRepoFolderModelReferences(
            { configs, repositories: [] },
            modelId,
            modelName,
        );

    it('matches on byokModelId when it exactly equals the modelId', () => {
        expect(probe({ byokModelId: 'm1' })).toEqual([
            'global override (byokModelId)',
        ]);
    });

    it('does NOT match byokModelId when it differs (no partial/prefix match)', () => {
        expect(probe({ byokModelId: 'm1-extra' })).toEqual([]);
        expect(probe({ byokModelId: 'm' })).toEqual([]);
    });

    it('trims whitespace before comparing byokModelId', () => {
        expect(probe({ byokModelId: '  m1  ' })).toEqual([
            'global override (byokModelId)',
        ]);
    });

    it('treats an empty / whitespace-only byokModelId as inherit (null)', () => {
        expect(probe({ byokModelId: '' })).toEqual([]);
        expect(probe({ byokModelId: '   ' })).toEqual([]);
    });

    it('ignores a non-string byokModelId (typeof guard → empty)', () => {
        // A numeric/object value must be treated as "no reference", never coerced.
        expect(probe({ byokModelId: 123 as any })).toEqual([]);
        expect(probe({ byokModelId: { toString: () => 'm1' } as any })).toEqual(
            [],
        );
    });

    it('matches on byokModel NAME only when modelName is supplied and equal', () => {
        expect(probe({ byokModel: 'gpt-5' }, 'm1', 'gpt-5')).toEqual([
            'global override (byokModel)',
        ]);
    });

    it('does NOT match byokModel when modelName is undefined (guard)', () => {
        expect(probe({ byokModel: 'gpt-5' }, 'm1', undefined)).toEqual([]);
    });

    it('does NOT match byokModel when the name differs', () => {
        expect(probe({ byokModel: 'gpt-5' }, 'm1', 'gpt-4')).toEqual([]);
    });

    it('trims byokModel before comparing to modelName', () => {
        expect(probe({ byokModel: '  gpt-5  ' }, 'm1', 'gpt-5')).toEqual([
            'global override (byokModel)',
        ]);
    });

    it('treats an empty byokModel as inherit even with a modelName', () => {
        expect(probe({ byokModel: '   ' }, 'm1', 'gpt-5')).toEqual([]);
    });

    it('prefers byokModelId over byokModel when BOTH match (id checked first)', () => {
        expect(
            probe({ byokModelId: 'm1', byokModel: 'gpt-5' }, 'm1', 'gpt-5'),
        ).toEqual(['global override (byokModelId)']);
    });

    it('falls through to byokModel when byokModelId is present but non-matching', () => {
        expect(
            probe({ byokModelId: 'other', byokModel: 'gpt-5' }, 'm1', 'gpt-5'),
        ).toEqual(['global override (byokModel)']);
    });

    it('returns [] for an undefined / non-object configs scope', () => {
        expect(probe(undefined)).toEqual([]);
        expect(probe(null as any)).toEqual([]);
        expect(probe({})).toEqual([]);
    });
});

describe('findRepoFolderModelReferences — traversal, labels and order', () => {
    it('returns [] when config is missing (undefined)', () => {
        expect(findRepoFolderModelReferences(undefined, 'm1', 'gpt-5')).toEqual(
            [],
        );
        expect(findRepoFolderModelReferences(null as any, 'm1')).toEqual([]);
    });

    it('returns [] when modelId is empty (guard), even with references present', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: { byokModelId: 'm1' },
                    repositories: [
                        {
                            id: 'r1',
                            name: 'acme/api',
                            configs: { byokModelId: 'm1' },
                        },
                    ],
                },
                '',
                'gpt-5',
            ),
        ).toEqual([]);
    });

    it('collects global, repository and directory refs in exact traversal order', () => {
        const refs = findRepoFolderModelReferences(
            {
                configs: { byokModelId: 'm1' },
                repositories: [
                    {
                        id: 'r1',
                        name: 'acme/api',
                        configs: { byokModelId: 'm1' },
                        directories: [
                            {
                                id: 'd1',
                                name: 'src/payments',
                                configs: { byokModelId: 'm1' },
                            },
                        ],
                    },
                ],
            },
            'm1',
        );
        expect(refs).toEqual([
            'global override (byokModelId)',
            'repository "acme/api" (byokModelId)',
            'directory "src/payments" in repository "acme/api" (byokModelId)',
        ]);
    });

    it('uses repo name for the label when present', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: {},
                    repositories: [
                        {
                            id: 'r1',
                            name: 'acme/api',
                            configs: { byokModelId: 'm1' },
                        },
                    ],
                },
                'm1',
            ),
        ).toEqual(['repository "acme/api" (byokModelId)']);
    });

    it('falls back to repo id when name is absent', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: {},
                    repositories: [
                        { id: 'r1', configs: { byokModelId: 'm1' } },
                    ],
                },
                'm1',
            ),
        ).toEqual(['repository "r1" (byokModelId)']);
    });

    it('falls back to "(unknown repository)" when neither name nor id is present', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: {},
                    repositories: [{ configs: { byokModelId: 'm1' } }],
                },
                'm1',
            ),
        ).toEqual(['repository "(unknown repository)" (byokModelId)']);
    });

    it('uses directory name, then id, then "(unknown directory)" for the dir label', () => {
        const build = (dir: Record<string, unknown>) =>
            findRepoFolderModelReferences(
                {
                    configs: {},
                    repositories: [
                        {
                            name: 'acme/api',
                            configs: {},
                            directories: [
                                { ...dir, configs: { byokModelId: 'm1' } },
                            ],
                        },
                    ],
                },
                'm1',
            );
        expect(build({ id: 'd1', name: 'src' })).toEqual([
            'directory "src" in repository "acme/api" (byokModelId)',
        ]);
        expect(build({ id: 'd1' })).toEqual([
            'directory "d1" in repository "acme/api" (byokModelId)',
        ]);
        expect(build({})).toEqual([
            'directory "(unknown directory)" in repository "acme/api" (byokModelId)',
        ]);
    });

    it('handles a missing repositories array (?? [] default) — global only', () => {
        expect(
            findRepoFolderModelReferences(
                { configs: { byokModelId: 'm1' } },
                'm1',
            ),
        ).toEqual(['global override (byokModelId)']);
    });

    it('handles a repository with no directories array (?? [] default)', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: {},
                    repositories: [
                        { name: 'acme/api', configs: { byokModelId: 'm1' } },
                    ],
                },
                'm1',
            ),
        ).toEqual(['repository "acme/api" (byokModelId)']);
    });

    it('emits a dir ref even when the repo itself does not reference the model', () => {
        expect(
            findRepoFolderModelReferences(
                {
                    configs: {},
                    repositories: [
                        {
                            name: 'acme/api',
                            configs: { byokModelId: 'other' },
                            directories: [
                                { name: 'src', configs: { byokModelId: 'm1' } },
                            ],
                        },
                    ],
                },
                'm1',
            ),
        ).toEqual(['directory "src" in repository "acme/api" (byokModelId)']);
    });
});

describe('DeleteByokConfigUseCase.execute — deterministic guards & branches', () => {
    beforeEach(() => jest.clearAllMocks());

    it('throws "modelId is required" for a null target (object guard rejects null)', async () => {
        const { useCase, orgFindByKey, deleteByokModel } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
        });
        await expect(useCase.execute(ORG, null as any)).rejects.toThrow(
            /modelId is required/,
        );
        // Short-circuits before any lookup or delete.
        expect(orgFindByKey).not.toHaveBeenCalled();
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('throws "modelId is required" for an object target lacking modelId', async () => {
        const { useCase } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
        });
        await expect(useCase.execute(ORG, {} as any)).rejects.toThrow(
            /modelId is required/,
        );
    });

    it('throws "BYOK configuration not found" when the entity is null', async () => {
        const { useCase } = buildExecuteHarness({ byokEntity: null });
        await expect(useCase.execute(ORG, { modelId: 'm1' })).rejects.toThrow(
            /BYOK configuration not found/,
        );
    });

    it('throws "BYOK configuration not found" when the entity has no configValue', async () => {
        const { useCase } = buildExecuteHarness({
            byokEntity: { configValue: null },
        });
        await expect(useCase.execute(ORG, { modelId: 'm1' })).rejects.toThrow(
            /BYOK configuration not found/,
        );
    });

    it('looks up the BYOK config with the BYOK_CONFIG key and org scope', async () => {
        const { useCase, orgFindByKey } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
            crConfig: { configs: {}, repositories: [] },
        });
        await useCase.execute(ORG, { modelId: 'm2' });
        expect(orgFindByKey).toHaveBeenCalledWith(
            OrganizationParametersKey.BYOK_CONFIG,
            { organizationId: ORG },
        );
    });

    it('looks up the code-review config with the CODE_REVIEW_CONFIG key (multi-model path)', async () => {
        const { useCase, paramFindByKey } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
            crConfig: { configs: {}, repositories: [] },
        });
        await useCase.execute(ORG, { modelId: 'm2' });
        expect(paramFindByKey).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            { organizationId: ORG },
        );
    });

    it('rejects a non-v2 (legacy) config before touching the guard', async () => {
        const { useCase, deleteByokModel, paramFindByKey } =
            buildExecuteHarness({
                byokConfig: { main: { provider: 'openai', apiKey: 'x' } },
            });
        await expect(useCase.execute(ORG, { modelId: 'm1' })).rejects.toThrow(
            /Model-level delete requires a BYOK configuration/,
        );
        expect(deleteByokModel).not.toHaveBeenCalled();
        expect(paramFindByKey).not.toHaveBeenCalled();
    });

    it('SKIPS the guard for the last real model even with a no-id sibling model', async () => {
        // filter(m => m?.id && m.id !== target): the no-id sibling is excluded by
        // the `m?.id` guard, so the deleted model is the last IDENTIFIED model →
        // isLastModel true → guard skipped even though routing references it.
        const { useCase, deleteByokModel, paramFindByKey } =
            buildExecuteHarness({
                byokConfig: {
                    version: 2,
                    credentials: [
                        { id: 'c1', provider: 'openai', apiKey: 'X' },
                    ],
                    models: [
                        { id: 'only', credentialId: 'c1', model: 'gpt-5' },
                        { credentialId: 'c1', model: 'ghost' }, // no id
                    ],
                    routing: { mode: 'manual', defaultModelId: 'only' },
                },
            });
        await expect(useCase.execute(ORG, { modelId: 'only' })).resolves.toBe(
            true,
        );
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'only');
        // Guard skipped → code-review config never fetched.
        expect(paramFindByKey).not.toHaveBeenCalled();
    });

    it('RUNS the guard when a second identified model remains (isLastModel false)', async () => {
        const { useCase, deleteByokModel, paramFindByKey } =
            buildExecuteHarness({
                byokConfig: makeByokConfig(), // m1 (default) + m2
                crConfig: { configs: {}, repositories: [] },
            });
        // Deleting m2 is allowed (unreferenced), but the guard must still run.
        await expect(useCase.execute(ORG, { modelId: 'm2' })).resolves.toBe(
            true,
        );
        expect(paramFindByKey).toHaveBeenCalledTimes(1);
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'm2');
    });

    it('falls back to no override refs when the code-review lookup REJECTS (catch → null)', async () => {
        // m2 is unreferenced by routing; the CR lookup throws. The catch(() => null)
        // fallback must yield an empty override set so the delete still proceeds.
        const { useCase, deleteByokModel } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
            crRejects: true,
        });
        await expect(useCase.execute(ORG, { modelId: 'm2' })).resolves.toBe(
            true,
        );
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'm2');
    });

    it('treats a code-review param with no configValue as null (?? null default)', async () => {
        // p present but configValue undefined → `p?.configValue ?? null` yields
        // null → findRepoFolderModelReferences(null) → [] → delete proceeds.
        const deleteByokModel = jest.fn().mockResolvedValue(true);
        const orgSvc = {
            findByKey: jest
                .fn()
                .mockResolvedValue({ configValue: makeByokConfig() }),
            deleteByokModel,
        } as any;
        const paramSvc = {
            findByKey: jest.fn().mockResolvedValue({ configValue: undefined }),
        } as any;
        const uc = new DeleteByokConfigUseCase(orgSvc, paramSvc);
        await expect(uc.execute(ORG, { modelId: 'm2' })).resolves.toBe(true);
        expect(deleteByokModel).toHaveBeenCalledWith(ORG, 'm2');
    });

    it('rejects on a SINGLE routing ref (usages.length === 1 crosses the > 0 boundary)', async () => {
        const { useCase, deleteByokModel } = buildExecuteHarness({
            byokConfig: makeByokConfig({
                // m2 is ONLY the fallback → exactly one usage.
                routing: {
                    mode: 'manual',
                    defaultModelId: 'm1',
                    fallbackModelId: 'm2',
                },
            }),
            crConfig: { configs: {}, repositories: [] },
        });
        await expect(useCase.execute(ORG, { modelId: 'm2' })).rejects.toThrow(
            /in use and cannot be deleted/,
        );
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('threads the deleted model NAME into the override lookup (global byokModel match rejects)', async () => {
        // m2.model === 'claude-opus-4-8'; a GLOBAL byokModel name override must be
        // found via model?.model and reject the delete, naming the byokModel field.
        const { useCase, deleteByokModel } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
            crConfig: {
                configs: { byokModel: 'claude-opus-4-8' },
                repositories: [],
            },
        });
        try {
            await useCase.execute(ORG, { modelId: 'm2' });
            throw new Error('expected rejection');
        } catch (err) {
            const msg = (err as BadRequestException).message;
            expect(msg).toContain('global override (byokModel)');
            expect(msg).toContain('cannot be deleted');
        }
        expect(deleteByokModel).not.toHaveBeenCalled();
    });

    it('returns the exact boolean the service yields (propagates false)', async () => {
        const { useCase } = buildExecuteHarness({
            byokConfig: makeByokConfig(),
            crConfig: { configs: {}, repositories: [] },
            deleteResult: false,
        });
        await expect(useCase.execute(ORG, { modelId: 'm2' })).resolves.toBe(
            false,
        );
    });

    it('joins multiple usages with "; " and names both routing and override refs', async () => {
        const { useCase } = buildExecuteHarness({
            byokConfig: makeByokConfig({
                routing: {
                    mode: 'manual',
                    defaultModelId: 'm1',
                    fallbackModelId: 'm2',
                },
            }),
            crConfig: {
                configs: {},
                repositories: [
                    { name: 'acme/api', configs: { byokModelId: 'm2' } },
                ],
            },
        });
        try {
            await useCase.execute(ORG, { modelId: 'm2' });
            throw new Error('expected rejection');
        } catch (err) {
            const msg = (err as BadRequestException).message;
            expect(msg).toContain('your fallback model');
            expect(msg).toContain('repository "acme/api" (byokModelId)');
            // routing ref first, then override ref, separated by "; ".
            expect(msg).toContain(
                'your fallback model; repository "acme/api" (byokModelId)',
            );
        }
    });
});

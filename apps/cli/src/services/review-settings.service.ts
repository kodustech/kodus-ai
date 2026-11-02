import { api } from './api/index.js';
import { gitService } from './git.service.js';
import {
    userContextService,
    type UserContext,
} from './user-context.service.js';
import type { CentralizedPrMetadata } from '../types/config.js';
import type {
    CodeReviewScope,
    FormattedCodeReviewParameter,
    FormattedConfigLeaf,
    FormattedConfigLevel,
    FormattedConfigNode,
    LLMConfigStatus,
    TestByokModelResult,
} from '../types/review-settings.js';
import { CommandError } from '../utils/command-errors.js';
import {
    REVIEW_SETTINGS,
    buildConfigDelta,
    parseReviewSettingValue,
    resolveReviewSetting,
    type ReviewSettingDefinition,
} from '../utils/review-settings-catalog.js';

export type SettingsScopeLevel = 'global' | 'repository' | 'directory';

export interface SettingsScope {
    level: SettingsScopeLevel;
    repositoryId?: string;
    repositoryName?: string;
    directoryId?: string;
    directoryPath?: string;
}

export interface SettingsTarget {
    /** 'global', '.', a repository id, name or owner/repo. */
    repository: string;
    directory?: string;
    team?: string;
}

export interface ResolvedSetting {
    key: string;
    section: ReviewSettingDefinition['section'];
    type: ReviewSettingDefinition['type'];
    value: unknown;
    level: FormattedConfigLevel;
    overriddenValue?: unknown;
    overriddenLevel?: FormattedConfigLevel;
}

export interface SettingsShowResult {
    team: string;
    scope: SettingsScope;
    model: ResolvedModel;
    kodusConfigFile?: string;
    settings: ResolvedSetting[];
}

export interface ResolvedModel {
    value: string;
    level: FormattedConfigLevel;
}

export type SettingsMutationResult = {
    team: string;
    scope: SettingsScope;
    key: string;
    value: unknown;
    /** Set when a kodus-config.yml in the repository overrides this scope's value. */
    overriddenByFile?: FormattedConfigLevel;
    centralized?: CentralizedPrMetadata & { mode: 'centralized-pr' };
};

export interface ModelListResult {
    byokConfigured: boolean;
    provider?: string;
    mainModel?: string;
    models: Array<{ modelId: string; name: string; resolvable: boolean }>;
}

const LEVEL_DEPTH: Record<FormattedConfigLevel, number> = {
    default: 0,
    global: 1,
    repository: 2,
    repository_file: 3,
    directory: 4,
    directory_file: 5,
};

function normalizePath(path: string): string {
    return path
        .trim()
        .replace(/^\.?\/+/, '')
        .replace(/\/+$/, '');
}

function isLeaf(node: unknown): node is FormattedConfigLeaf {
    return (
        typeof node === 'object' &&
        node !== null &&
        'level' in node &&
        'value' in node
    );
}

function readInside(value: unknown, segments: string[]): unknown {
    let cursor = value;
    for (const segment of segments) {
        if (typeof cursor !== 'object' || cursor === null) {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
}

export function readLeaf(
    configs: FormattedConfigNode | undefined,
    key: string,
): FormattedConfigLeaf | undefined {
    const segments = key.split('.');
    let cursor: unknown = configs;
    for (let index = 0; index < segments.length; index += 1) {
        if (typeof cursor !== 'object' || cursor === null) {
            return undefined;
        }
        // A key the default config lacks (suggestionControl.severityLimits)
        // comes back as ONE leaf holding the whole object, not one leaf per
        // field (formatLevel in get-code-review-parameter.use-case.ts only
        // recurses where the default has a node). Its fields share its level.
        if (isLeaf(cursor)) {
            const rest = segments.slice(index);
            const value = readInside(cursor.value, rest);
            if (value === undefined) {
                return undefined;
            }
            const overridden = readInside(cursor.overriddenValue, rest);
            return {
                value,
                level: cursor.level,
                ...(overridden !== undefined
                    ? {
                          overriddenValue: overridden,
                          overriddenLevel: cursor.overriddenLevel,
                      }
                    : {}),
            };
        }
        cursor = (cursor as Record<string, unknown>)[segments[index]];
    }
    return isLeaf(cursor) ? cursor : undefined;
}

function isCentralizedPr(
    value: unknown,
): value is CentralizedPrMetadata & { mode: 'centralized-pr' } {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { mode?: unknown }).mode === 'centralized-pr'
    );
}

function requireByok(status: LLMConfigStatus): string {
    if (!status.byok?.configured || !status.byok.providerId) {
        throw new CommandError(
            'INVALID_INPUT',
            'No BYOK provider is configured for this organization, so reviews use the Kodus-managed model and there is no model to choose. Connect a provider in Settings > BYOK.',
        );
    }
    return status.byok.providerId;
}

class ReviewSettingsService {
    private async context(target: { team?: string }): Promise<UserContext> {
        return userContextService.resolve('Code review settings', {
            team: target.team,
        });
    }

    async resolveRepositoryReference(target: string): Promise<string> {
        if (target !== '.') {
            return target.trim().replace(/^\/+|\/+$/g, '');
        }

        const orgRepo = (await gitService.isGitRepository())
            ? await gitService.extractOrgRepo()
            : null;
        if (!orgRepo) {
            throw new CommandError(
                'NOT_IN_GIT_REPO',
                "Could not read the repository from this directory's git remote. Pass owner/repo, a repository id, or 'global'.",
            );
        }
        return `${orgRepo.org}/${orgRepo.repo}`;
    }

    /**
     * Matches the way the settings sidebar lists them, by id or name. Every
     * scope is a repository the team reviews; `isSelected: false` only means
     * it has no settings of its own yet ("Inherits Global" in the sidebar).
     */
    findRepositoryScope(
        reference: string,
        scopes: CodeReviewScope[],
    ): CodeReviewScope {
        const wanted = reference.toLowerCase();
        const lastSegment = wanted.split('/').pop() ?? wanted;
        const selected = scopes;

        const byId = selected.find(
            (scope) => scope.id.toLowerCase() === wanted,
        );
        if (byId) {
            return byId;
        }

        const byFullName = selected.filter(
            (scope) => scope.name.toLowerCase() === wanted,
        );
        const matches = byFullName.length
            ? byFullName
            : selected.filter(
                  (scope) =>
                      scope.name.toLowerCase().split('/').pop() === lastSegment,
              );

        if (matches.length === 1) {
            return matches[0];
        }
        if (matches.length > 1) {
            throw new CommandError(
                'INVALID_INPUT',
                `'${reference}' matches more than one repository (${matches.map((scope) => `${scope.name} [${scope.id}]`).join(', ')}). Pass the repository id.`,
            );
        }
        throw new CommandError(
            'INVALID_INPUT',
            `Repository '${reference}' is not configured in Kodus for this team. Configured: ${selected.map((scope) => scope.name).join(', ') || 'none'}.`,
        );
    }

    async resolveScope(
        ctx: UserContext,
        target: SettingsTarget,
        options: { createDirectory?: boolean } = {},
    ): Promise<SettingsScope> {
        if (target.repository === 'global') {
            if (target.directory) {
                throw new CommandError(
                    'INVALID_INPUT',
                    '--directory needs a repository, not global.',
                );
            }
            return { level: 'global' };
        }

        const reference = await this.resolveRepositoryReference(
            target.repository,
        );
        const scopes = await api.config.getCodeReviewScopes(
            ctx.accessToken,
            ctx.teamId,
        );
        const repository = this.findRepositoryScope(reference, scopes ?? []);

        if (!target.directory) {
            return {
                level: 'repository',
                repositoryId: repository.id,
                repositoryName: repository.name,
            };
        }

        const wantedPath = normalizePath(target.directory);
        const directory = repository.directories.find((candidate) =>
            candidate.paths.some((path) => normalizePath(path) === wantedPath),
        );

        if (directory) {
            return {
                level: 'directory',
                repositoryId: repository.id,
                repositoryName: repository.name,
                directoryId: directory.id,
                directoryPath: wantedPath,
            };
        }

        if (options.createDirectory) {
            return {
                level: 'directory',
                repositoryId: repository.id,
                repositoryName: repository.name,
                directoryPath: wantedPath,
            };
        }

        const known = repository.directories.flatMap((candidate) =>
            candidate.paths.map(normalizePath),
        );
        throw new CommandError(
            'INVALID_INPUT',
            `Directory '${target.directory}' has no settings of its own in ${repository.name}. Directories with settings: ${known.join(', ') || 'none'}. Add it with 'kodus config remote set ${repository.name} <key> <value> --directory ${target.directory} --create-directory'.`,
        );
    }

    private scopeConfigs(
        parameter: FormattedCodeReviewParameter,
        scope: SettingsScope,
    ): { configs?: FormattedConfigNode; fileStatus?: string } {
        const value = parameter?.configValue ?? {};
        if (scope.level === 'global') {
            return { configs: value.configs };
        }

        const repository = value.repositories?.find(
            (candidate) => candidate.id === scope.repositoryId,
        );
        if (scope.level === 'repository') {
            return {
                configs: repository?.configs,
                fileStatus: repository?.kodusConfigFile?.status,
            };
        }

        const directory = repository?.directories?.find(
            (candidate) => candidate.id === scope.directoryId,
        );
        return {
            configs: directory?.configs,
            fileStatus: directory?.kodusConfigFile?.status,
        };
    }

    private async loadScopeConfigs(
        ctx: UserContext,
        scope: SettingsScope,
        options: { includeFileOverlay?: boolean } = {},
    ) {
        const parameter = await api.config.getFormattedCodeReviewParameter(
            ctx.accessToken,
            ctx.teamId,
            options,
        );
        return this.scopeConfigs(parameter, scope);
    }

    async show(
        target: SettingsTarget,
        options: { includeFileOverlay?: boolean } = {},
    ): Promise<SettingsShowResult> {
        const ctx = await this.context(target);
        const scope = await this.resolveScope(ctx, target);
        const { configs, fileStatus } = await this.loadScopeConfigs(
            ctx,
            scope,
            options,
        );

        const settings = REVIEW_SETTINGS.map((setting): ResolvedSetting => {
            const leaf = readLeaf(configs, setting.key);
            return {
                key: setting.key,
                section: setting.section,
                type: setting.type,
                value: leaf?.value,
                level: leaf?.level ?? 'default',
                ...(leaf?.overriddenLevel !== undefined
                    ? {
                          overriddenValue: leaf.overriddenValue,
                          overriddenLevel: leaf.overriddenLevel,
                      }
                    : {}),
            };
        });

        // Same leaf the settings page reads for the model badge.
        const modelLeaf =
            readLeaf(configs, 'byokModelId') ?? readLeaf(configs, 'byokModel');

        return {
            team: ctx.teamName,
            scope,
            model: {
                value:
                    typeof modelLeaf?.value === 'string' ? modelLeaf.value : '',
                level: modelLeaf?.level ?? 'default',
            },
            ...(fileStatus ? { kodusConfigFile: fileStatus } : {}),
            settings,
        };
    }

    private async save(
        ctx: UserContext,
        scope: SettingsScope,
        configValue: Record<string, unknown>,
    ) {
        return api.config.saveCodeReviewConfig(ctx.accessToken, {
            teamId: ctx.teamId,
            configValue,
            repositoryId: scope.repositoryId,
            directoryId: scope.directoryId,
            directoryPaths:
                scope.level === 'directory' && !scope.directoryId
                    ? [scope.directoryPath as string]
                    : undefined,
        });
    }

    private fileOverride(
        leaf: FormattedConfigLeaf | undefined,
        scope: SettingsScope,
    ): FormattedConfigLevel | undefined {
        if (
            leaf &&
            (leaf.level === 'repository_file' ||
                leaf.level === 'directory_file') &&
            LEVEL_DEPTH[leaf.level] > LEVEL_DEPTH[scope.level]
        ) {
            return leaf.level;
        }
        return undefined;
    }

    async set(
        target: SettingsTarget & { createDirectory?: boolean },
        key: string,
        rawValue: string,
    ): Promise<SettingsMutationResult> {
        const setting = resolveReviewSetting(key);
        const value = parseReviewSettingValue(setting, rawValue);
        const ctx = await this.context(target);
        const scope = await this.resolveScope(ctx, target, {
            createDirectory: target.createDirectory,
        });

        const { configs } =
            scope.level === 'directory' && !scope.directoryId
                ? { configs: undefined }
                : await this.loadScopeConfigs(ctx, scope);
        const overriddenByFile = this.fileOverride(
            readLeaf(configs, setting.key),
            scope,
        );

        const result = await this.save(
            ctx,
            scope,
            buildConfigDelta(setting.key, value),
        );

        return {
            team: ctx.teamName,
            scope,
            key: setting.key,
            value,
            ...(overriddenByFile ? { overriddenByFile } : {}),
            ...(isCentralizedPr(result) ? { centralized: result } : {}),
        };
    }

    /**
     * Drops this scope's override so the value inherits again. Same as the
     * settings page's revert: save the parent's value, and the API stores
     * only what differs from the parent.
     */
    async unset(
        target: SettingsTarget,
        key: string,
    ): Promise<SettingsMutationResult & { changed: boolean }> {
        const setting = resolveReviewSetting(key);
        const ctx = await this.context(target);
        const scope = await this.resolveScope(ctx, target);
        const { configs } = await this.loadScopeConfigs(ctx, scope);
        const leaf = readLeaf(configs, setting.key);

        if (!leaf || leaf.level !== scope.level) {
            return {
                team: ctx.teamName,
                scope,
                key: setting.key,
                value: leaf?.value,
                changed: false,
            };
        }

        if (leaf.overriddenValue === undefined) {
            throw new CommandError(
                'INVALID_INPUT',
                `'${setting.key}' has no inherited value to go back to. Set it explicitly instead.`,
            );
        }

        const result = await this.save(
            ctx,
            scope,
            buildConfigDelta(setting.key, leaf.overriddenValue),
        );

        return {
            team: ctx.teamName,
            scope,
            key: setting.key,
            value: leaf.overriddenValue,
            changed: true,
            ...(isCentralizedPr(result) ? { centralized: result } : {}),
        };
    }

    async listModels(): Promise<ModelListResult> {
        const accessToken = await userContextService.requireUserToken(
            'Review model selection',
        );
        const status = await api.config.getLLMConfigStatus(accessToken);

        if (!status.byok?.configured) {
            return { byokConfigured: false, models: [] };
        }

        return {
            byokConfigured: true,
            provider: status.byok.providerId,
            mainModel: status.byok.model,
            models: (status.models ?? []).map((model) => ({
                modelId: model.modelId,
                name: model.model ?? model.modelId,
                resolvable: model.resolvable,
            })),
        };
    }

    /**
     * Pins the review model for one scope, as the model selector on the
     * General page does: it writes `byokModelId`, and an empty id inherits.
     */
    async setModel(
        target: SettingsTarget & { force?: boolean },
        modelId: string,
    ): Promise<SettingsMutationResult> {
        const ctx = await this.context(target);
        const status = await api.config.getLLMConfigStatus(ctx.accessToken);
        requireByok(status);

        const trimmed = modelId.trim();
        const models = status.models ?? [];
        const known =
            trimmed === '' ||
            models.length === 0 ||
            models.some(
                (model) => model.modelId === trimmed || model.model === trimmed,
            );
        if (!known && !target.force) {
            throw new CommandError(
                'INVALID_INPUT',
                `Model '${trimmed}' is not among the models configured for this organization (${models.map((model) => model.modelId).join(', ')}). Pass --force to save it anyway.`,
            );
        }

        const scope = await this.resolveScope(ctx, target);
        const result = await this.save(ctx, scope, { byokModelId: trimmed });

        return {
            team: ctx.teamName,
            scope,
            key: 'byokModelId',
            value: trimmed,
            ...(isCentralizedPr(result) ? { centralized: result } : {}),
        };
    }

    async testModel(modelId: string): Promise<TestByokModelResult> {
        const accessToken =
            await userContextService.requireUserToken('Review model test');
        const status = await api.config.getLLMConfigStatus(accessToken);
        const provider = requireByok(status);
        const trimmed = modelId.trim();
        if (!trimmed) {
            throw new CommandError('INVALID_INPUT', 'Pass a model id to test.');
        }

        // The selector tests the provider's model name for a configured id.
        const providerModel =
            status.models?.find((model) => model.modelId === trimmed)?.model ??
            trimmed;

        return api.config.testByokModel(accessToken, {
            provider,
            model: providerModel.trim(),
        });
    }
}

export { ReviewSettingsService };
export const reviewSettingsService = new ReviewSettingsService();

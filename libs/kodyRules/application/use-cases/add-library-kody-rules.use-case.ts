import { createHash } from 'crypto';

import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRule,
    IKodyRuleFileScope,
    KodyRulesOrigin,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { CentralizedPrMetadata } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { AddLibraryKodyRulesDto } from '@libs/kodyRules/dtos/add-library-kody-rules.dto';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';

/**
 * Languages recognised on import, mapped to the file extensions a glob for
 * that language should cover. Keyed exactly like the `ProgrammingLanguage`
 * keys the library payload carries
 * (`apps/web/src/core/enums/programming-language.ts`: `jsts` covers JS/TS,
 * plus `dart`/`kotlin`) — those are the values the web client forwards as
 * `language` when importing a rule from the library. When a rule declares a
 * `language` but ships no `path`, nothing narrows it, so the review path would
 * otherwise judge the rule against EVERY file in every PR (#1832). The map
 * feeds the rule's persisted `fileScope`; see `resolveLibraryRuleFileScope`.
 */
const LANGUAGE_EXTENSIONS = new Map<string, string[]>([
    ['jsts', ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue']],
    // Legacy spellings: library entries and API consumers predating the
    // client's `jsts` key may still send `typescript`/`javascript`. Treat them
    // as aliases so a rule declared with either spelling still gets a scope —
    // otherwise it silently falls back to an empty path and applies to every
    // file in every PR (#1832).
    ['typescript', ['.ts', '.tsx']],
    ['javascript', ['.js', '.jsx']],
    ['python', ['.py']],
    ['csharp', ['.cs']],
    ['dart', ['.dart']],
    ['ruby', ['.rb', '.rake', '.erb', '.gemspec']],
    ['php', ['.php']],
    // Manifest-centric rules ("use go.work instead of replace", "centralize
    // Cargo deps in workspace.dependencies", "Gradle version catalogs",
    // "Central Package Management") target files the source extension alone
    // never reaches. The scope is a cost filter that abstains when it cannot
    // decide, so carrying the manifest suffix costs nothing and dropping it
    // would silently stop those rules from ever firing.
    ['go', ['.go', '.work', '.mod']],
    ['kotlin', ['.kt', '.kts']],
    ['rust', ['.rs', '.toml']],
    ['java', ['.java', '.gradle', '.kts']],
    ['csharp', ['.cs', '.csproj', '.props']],
]);

/**
 * Resolve the language scope an imported rule should be persisted with.
 *
 * Persisted as a `fileScope` (issue #1826) rather than as a generated `path`
 * glob. Three reasons, all visible in the review path:
 *
 * - `path` is the author's statement and outranks the scope, while a rule that
 *   only carries a scope is still filtered by it (`rulesForFile` in the sharded
 *   judge drops a file whose path fails `extensionScopeAppliesToFile` before it
 *   ever considers the rule).
 * - a glob is rendered in the rules list, where brace globs get truncated, so
 *   the user sees a path they never wrote.
 * - a glob excludes extensionless files (`Gemfile`, `Rakefile`, `Dockerfile`)
 *   that the scope deliberately lets through: we cannot tell their language, so
 *   excluding them would be a silent enforcement loss.
 *
 * The author's explicit `path` is kept as sent, which is how a directory import
 * keeps BOTH constraints: the directory narrows through `path`, the language
 * narrows through this scope, instead of one silently winning over the other.
 *
 * Returns `null` for an unknown language: no scope at all preserves the
 * current behaviour (the rule applies wherever the author's path allows).
 */

export function resolveLibraryRuleFileScope(
    ruleText: string,
    language: string | undefined,
): IKodyRuleFileScope | null {
    // A Map lookup keeps unknown/prototype-shaped values (e.g. `__proto__`,
    // `constructor`) inert: they simply miss and fall back to no scope.
    const extensions =
        typeof language === 'string'
            ? LANGUAGE_EXTENSIONS.get(language.trim().toLowerCase())
            : undefined;
    if (!extensions || extensions.length === 0) {
        return null;
    }
    return {
        extensions,
        // Same hash contract as the inference: sha256 of the exact rule text
        // the scope was derived from.
        sourceHash: createHash('sha256').update(ruleText).digest('hex'),
        // Declared by the library rule, not inferred from the text: an `author`
        // scope is never overwritten by a later inference.
        source: 'author',
        inferredAt: new Date(),
    };
}

@Injectable()
export class AddLibraryKodyRulesUseCase {
    private readonly logger = createLogger(AddLibraryKodyRulesUseCase.name);
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly authorizationService: AuthorizationService,
        private readonly telemetry: TelemetryService,
    ) {}

    async execute(
        libraryKodyRules: AddLibraryKodyRulesDto,
    ): Promise<Partial<IKodyRule>[] | CentralizedPrMetadata> {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            await this.authorizationService.ensure({
                user: this.request.user,
                action: Action.Create,
                resource: ResourceType.KodyRules,
                repoIds:
                    libraryKodyRules.repositoriesIds.length > 0
                        ? libraryKodyRules.repositoriesIds
                        : undefined,
            });

            const results: Partial<IKodyRule>[] = [];
            let centralizedPrResult: CentralizedPrMetadata | null = null;

            for await (const repoId of libraryKodyRules.repositoriesIds) {
                const kodyRule: CreateKodyRuleDto = {
                    title: libraryKodyRules.title,
                    rule: libraryKodyRules.rule,
                    // Kept exactly as sent: a directory import sends
                    // `<directory>/**`, and the language narrows that further
                    // through the scope below instead of replacing it.
                    path: libraryKodyRules.path,
                    severity: libraryKodyRules.severity,
                    repositoryId: repoId,
                    examples: libraryKodyRules.examples,
                    origin: KodyRulesOrigin.LIBRARY,
                    type: KodyRulesType.STANDARD,
                };

                // Internal write path: `CreateKodyRuleDto` is the HTTP boundary
                // and does not declare `fileScope` (no form field, same reason
                // `contextNeed` is undeclared), but `createOrUpdate` persists it
                // from the plain rule object it is handed.
                (kodyRule as Partial<IKodyRule>).fileScope =
                    resolveLibraryRuleFileScope(
                        libraryKodyRules.rule,
                        libraryKodyRules.language,
                    );

                const result =
                    await this.createOrUpdateKodyRulesUseCase.execute(
                        kodyRule,
                        this.request.user.organization.uuid,
                        undefined,
                        undefined,
                        libraryKodyRules.teamId,
                        this.request.user,
                    );

                if (!result) {
                    throw new Error('Failed to add library Kody rule');
                }
                if (
                    (result as CentralizedPrMetadata)?.mode === 'centralized-pr'
                ) {
                    centralizedPrResult = result as CentralizedPrMetadata;
                } else {
                    results.push(result);
                }
            }

            // Processar diretórios se existirem
            if (
                libraryKodyRules?.directoriesInfo &&
                libraryKodyRules?.directoriesInfo?.length > 0
            ) {
                for await (const directoryInfo of libraryKodyRules.directoriesInfo) {
                    const kodyRule: CreateKodyRuleDto = {
                        title: libraryKodyRules.title,
                        rule: libraryKodyRules.rule,
                        // Kept exactly as sent, like the repositories branch: the
                        // directory narrows through `path` and the language
                        // through the scope below.
                        path: libraryKodyRules.path,
                        severity: libraryKodyRules.severity,
                        repositoryId: directoryInfo.repositoryId,
                        directoryId: directoryInfo.directoryId,
                        examples: libraryKodyRules.examples,
                        origin: KodyRulesOrigin.LIBRARY,
                        type: KodyRulesType.STANDARD,
                    };

                    // Same scope as the repositories branch, and for the same
                    // reason: without it a directory import persists an
                    // unscoped rule that applies to every file in the PR.
                    (kodyRule as Partial<IKodyRule>).fileScope =
                        resolveLibraryRuleFileScope(
                            libraryKodyRules.rule,
                            libraryKodyRules.language,
                        );

                    const result =
                        await this.createOrUpdateKodyRulesUseCase.execute(
                            kodyRule,
                            this.request.user.organization.uuid,
                            undefined,
                            undefined,
                            libraryKodyRules.teamId,
                            this.request.user,
                        );

                    if (!result) {
                        throw new Error(
                            'Failed to add library Kody rule for directory',
                        );
                    }
                    if (
                        (result as CentralizedPrMetadata)?.mode ===
                        'centralized-pr'
                    ) {
                        centralizedPrResult = result as CentralizedPrMetadata;
                    } else {
                        results.push(result);
                    }
                }
            }

            void this.telemetry.kodyRulesImported({
                organizationId: this.request.user.organization.uuid,
                teamId: libraryKodyRules.teamId,
                actorUserId: (this.request.user as any)?.uuid,
                source: 'library',
                // One rule row per target scope: every selected repository
                // plus every selected directory.
                ruleCount:
                    libraryKodyRules.repositoriesIds.length +
                    (libraryKodyRules.directoriesInfo?.length ?? 0),
                repositoryCount: libraryKodyRules.repositoriesIds.length,
            });

            if (centralizedPrResult) {
                return centralizedPrResult;
            }

            return results;
        } catch (error) {
            this.logger.error({
                message: 'Could not add library Kody rules',
                context: AddLibraryKodyRulesUseCase.name,
                serviceName: 'AddLibraryKodyRulesUseCase',
                error: error,
                metadata: {
                    libraryKodyRules,
                    organizationAndTeamData: {
                        organizationId: this.request.user.organization.uuid,
                    },
                },
            });
            throw error;
        }
    }
}

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
    KodyRulesOrigin,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { CentralizedPrMetadata } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';

import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { AddLibraryKodyRulesDto } from '@libs/kodyRules/dtos/add-library-kody-rules.dto';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';

/**
 * Languages recognised on import, mapped to the file extensions a glob for
 * that language should cover. Mirrors the canonical `SUPPORTED_LANGUAGES`
 * table in the code-review domain (kept local to avoid a cross-domain import
 * from the kody-rules use-case into code-review): when a library rule declares
 * a `language` but ships no `path`, the engine's only scoping mechanism
 * (`if (!rule.path) return true`) would otherwise apply the rule to EVERY
 * file in every PR (#1832).
 */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
    typescript: ['.ts', '.tsx'],
    javascript: ['.js', '.jsx'],
    python: ['.py'],
    java: ['.java'],
    go: ['.go'],
    ruby: ['.rb', '.rake', '.erb', '.gemspec'],
    php: ['.php'],
    csharp: ['.cs'],
    rust: ['.rs'],
};

/**
 * Resolve the path glob an imported rule should be persisted with. Prefer an
 * explicit `path`; fall back to a language-derived glob when the rule carries
 * a `language`; otherwise keep whatever was given (this preserves current
 * behaviour for installs that rely on an empty path).
 */
export function resolveLibraryRulePath(
    path: string | undefined,
    language: string | undefined,
): string | undefined {
    if (path) {
        return path;
    }
    const extensions = language ? LANGUAGE_EXTENSIONS[language] : undefined;
    if (!extensions || extensions.length === 0) {
        return path;
    }
    if (extensions.length === 1) {
        return `**/*${extensions[0]}`;
    }
    return `**/*{${extensions.join(',')}}`;
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
                    path: resolveLibraryRulePath(
                        libraryKodyRules.path,
                        libraryKodyRules.language,
                    ),
                    severity: libraryKodyRules.severity,
                    repositoryId: repoId,
                    examples: libraryKodyRules.examples,
                    origin: KodyRulesOrigin.LIBRARY,
                    type: KodyRulesType.STANDARD,
                };

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
                        path: resolveLibraryRulePath(
                            libraryKodyRules.path,
                            libraryKodyRules.language,
                        ),
                        severity: libraryKodyRules.severity,
                        repositoryId: directoryInfo.repositoryId,
                        directoryId: directoryInfo.directoryId,
                        examples: libraryKodyRules.examples,
                        origin: KodyRulesOrigin.LIBRARY,
                        type: KodyRulesType.STANDARD,
                    };

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

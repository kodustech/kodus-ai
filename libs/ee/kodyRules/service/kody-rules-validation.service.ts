/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { environment } from '@libs/ee/configs/environment';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IKodyRule,
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { Injectable } from '@nestjs/common';

/**
 * Service for validating and ordering Kody Rules in cloud mode
 */
@Injectable()
export class KodyRulesValidationService {
    public readonly MAX_KODY_RULES = 10;
    private readonly isCloud: boolean;

    constructor(
        private readonly permissionValidationService: PermissionValidationService,
    ) {
        this.isCloud = environment.API_CLOUD_MODE;
    }

    /**
     * Validates if the total number of rules is within the allowed limit.
     * @param totalRules Total number of rules.
     * @returns True if the number of rules is within the limit, false otherwise.
     */
    async validateRulesLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        totalRules: number,
    ): Promise<boolean> {
        const limited =
            await this.permissionValidationService.shouldLimitResources(
                organizationAndTeamData,
                KodyRulesValidationService.name,
            );

        if (!limited) {
            return true;
        }

        return totalRules <= this.MAX_KODY_RULES;
    }

    /**
     * Orders an array of items that have a 'createdAt' field and limits the result if needed.
     * @param items Array of items to order.
     * @param limit Maximum number of items to return. Use 0 for no limit.
     * @param order Order type: 'asc' (oldest first) or 'desc' (newest first).
     * @returns Ordered (and limited) array.
     */
    private orderByCreatedAtAndLimit<T extends { createdAt?: Date | string }>(
        items: T[],
        limit: number = 0,
        order: 'asc' | 'desc' = 'asc',
    ): T[] {
        const safeTimestamp = (item: T): number => {
            try {
                const dateValue = item.createdAt;
                if (!dateValue) return 0;
                const timestamp = new Date(dateValue).getTime();
                return isNaN(timestamp) ? 0 : timestamp;
            } catch (error) {
                console.error('Error converting createdAt:', error);
                return 0;
            }
        };

        // Order the items based on their createdAt timestamp.
        const ordered = items.sort((a, b) => {
            const diff = safeTimestamp(a) - safeTimestamp(b);
            return order === 'asc' ? diff : -diff;
        });

        return limit > 0 ? ordered.slice(0, limit) : ordered;
    }

    /**
     * Filters and orders Kody Rules.
     * It selects directory-specific, repository-specific and global active rules, removes duplicates,
     * orders them by createdAt (oldest first), and if not in cloud mode, limits the result to MAX_KODY_RULES.
     *
     * @param rules Array of KodyRules.
     * @param repositoryId Repository identifier.
     * @param directoryId Optional directory identifier.
     * @returns Array of filtered, ordered, and possibly limited KodyRules.
     */
    filterKodyRules(
        rules: Partial<IKodyRule>[] = [],
        repositoryId: string,
        directoryId?: string,
        limited?: boolean,
    ): {
        standardRules: Partial<IKodyRule>[];
        memoryRules: Partial<IKodyRule>[];
    } {
        if (!rules?.length) {
            return { standardRules: [], memoryRules: [] };
        }

        const repositoryRules: Partial<IKodyRule>[] = [];
        const directoryRules: Partial<IKodyRule>[] = [];
        const globalRules: Partial<IKodyRule>[] = [];

        for (const rule of rules) {
            if (rule.status !== KodyRulesStatus.ACTIVE) {
                continue;
            }

            if (
                rule.centralizedConfig?.status ===
                KodyRuleCentralizedStatus.PENDING_ADD
            ) {
                continue;
            }

            if (rule.repositoryId === 'global') {
                globalRules.push(rule);
                continue;
            }

            if (rule.repositoryId !== repositoryId) {
                continue;
            }

            if (directoryId && rule.directoryId) {
                if (rule.directoryId === directoryId) {
                    directoryRules.push(rule);
                }
            } else {
                repositoryRules.push(rule);
            }
        }

        const mergedRules = [
            ...repositoryRules,
            ...directoryRules,
            ...globalRules,
        ];
        const mergedRulesWithoutDuplicates =
            this.extractUniqueKodyRules(mergedRules);

        const limit = limited ? this.MAX_KODY_RULES : 0;
        const orderedRules = this.orderByCreatedAtAndLimit(
            mergedRulesWithoutDuplicates,
            limit,
            'asc',
        );

        const [standardRules, memoryRules] = orderedRules.reduce(
            (acc, rule) => {
                if (rule.type === KodyRulesType.MEMORY) {
                    acc[1].push(rule);
                } else {
                    acc[0].push(rule);
                }
                return acc;
            },
            [[], []] as [Partial<IKodyRule>[], Partial<IKodyRule>[]],
        );

        // Memory rules should be last in the list, so they are applied after all standard rules.
        return { standardRules, memoryRules };
    }

    /**
     * Removes duplicate Kody Rules based on the 'rule' property.
     * @param kodyRules Array of KodyRules.
     * @returns Array of unique KodyRules.
     */
    private extractUniqueKodyRules(
        kodyRules: Partial<IKodyRule>[],
    ): Partial<IKodyRule>[] {
        const seenRules = new Set<string>();
        const uniqueKodyRules: Partial<IKodyRule>[] = [];

        kodyRules.forEach((kodyRule) => {
            if (kodyRule?.rule && !seenRules.has(kodyRule.rule)) {
                seenRules.add(kodyRule.rule);
                uniqueKodyRules.push(kodyRule);
            }
        });

        return uniqueKodyRules;
    }

    /**
     * Retrieves the specific Kody rules for a *file* based on glob patterns.
     * This method only matches rules whose glob patterns directly match the file.
     * @param fileName Name of the file to be checked.
     * @param kodyRules Array of objects containing the pattern and Kody rules.
     * @param filters Filtering options for repository and directory.
     * @returns Array of Kody rules applicable to the file.
     */
    getKodyRulesForFile(
        fileName: string | null,
        kodyRules: Partial<IKodyRule>[],
        filters: {
            directoryId?: string;
            repositoryId?: string;
            useInclude?: boolean;
            useExclude?: boolean;
        },
    ) {
        return this.getKodyRules(
            fileName,
            kodyRules,
            filters,
            // Pass the file-specific matching strategy
            (rule, normalizedFile) =>
                this.isFilePathMatch(rule, normalizedFile),
        );
    }

    /**
     * Retrieves the specific Kody rules for a *folder* based on glob patterns.
     * This matches rules that apply to the folder itself or are recursive (e.g., ** /*).
     * @param folderName Name of the folder to be checked.
     * @param kodyRules Array of objects containing the pattern and Kody rules.
     * @param filters Filtering options for repository and directory.
     * @returns Array of Kody rules applicable to the folder.
     */
    getKodyRulesForFolder(
        folderName: string | null,
        kodyRules: Partial<IKodyRule>[],
        filters: {
            directoryId?: string;
            repositoryId?: string;
            useInclude?: boolean;
            useExclude?: boolean;
        },
    ) {
        return this.getKodyRules(
            folderName,
            kodyRules,
            filters,
            // Pass the folder-specific matching strategy
            (rule, normalizedFolder) =>
                this.isFolderPathMatch(rule, normalizedFolder),
        );
    }

    getMemoryRulesForContext(
        path: string | null,
        kodyRules: Partial<IKodyRule>[],
        filters: {
            directoryId?: string;
            repositoryId?: string;
            useInclude?: boolean;
            useExclude?: boolean;
        },
    ): Partial<IKodyRule>[] {
        if (!kodyRules?.length) {
            return [];
        }

        const activeMemoryRules = kodyRules.filter(
            (rule) =>
                rule?.type === KodyRulesType.MEMORY &&
                rule?.status === KodyRulesStatus.ACTIVE,
        );

        const normalizedFilters = {
            ...filters,
            directoryId: filters.repositoryId ? filters.directoryId : undefined,
        };

        return this.getKodyRulesForFolder(
            path,
            activeMemoryRules,
            normalizedFilters,
        );
    }

    private getKodyRules(
        path: string | null,
        kodyRules: Partial<IKodyRule>[],
        filters: {
            directoryId?: string;
            repositoryId?: string;
            useInclude?: boolean;
            useExclude?: boolean;
        },
        // The path matching strategy is passed as a function
        pathMatcher: (
            rule: Partial<IKodyRule>,
            normalizedPath: string | null,
        ) => boolean,
    ) {
        const {
            directoryId,
            repositoryId,
            useInclude = true,
            useExclude = true,
        } = filters;

        if (!kodyRules?.length) {
            return [];
        }

        // Normalize the path by replacing backslashes with forward slashes (in case it's on Windows)
        const normalizedPath =
            path?.replace(/\\/g, '/')?.replace(/^\//, '') ?? null;

        // isPathMatch is a call to the provided strategy function
        const isPathMatch = (rule: Partial<IKodyRule>): boolean => {
            return pathMatcher(rule, normalizedPath);
        };

        // Check if the rule matches the repository (global or specific)
        const isRepositoryMatch = (rule: Partial<IKodyRule>): boolean => {
            // If we aren't checking a specific repository, all rules match.
            if (!repositoryId) {
                return true;
            }

            // Match if the rule is global or specific to the repository
            return (
                rule?.repositoryId === 'global' ||
                rule?.repositoryId === repositoryId
            );
        };

        const isInheritanceMatch = (rule: Partial<IKodyRule>): boolean => {
            // If we aren't checking a specific directory or repository, all rules match.
            if (!directoryId && !repositoryId) {
                return true;
            }

            const {
                inheritable = true,
                exclude = [],
                include = [],
            } = rule.inheritance ?? {};

            // If the rule is not inheritable, it doesn't match.
            if (!inheritable) {
                return false;
            }

            // Cross-directory leak guard. The historical default for a
            // rule's `inheritance.include` is `[]`, which the matcher
            // below reads as "inherit everywhere" — and so a rule
            // scoped to one directory would silently apply in every
            // sibling directory of the same repo (reported by
            // quintoandar/backend-services on rule b207a89c).
            //
            // A directory-scoped rule (`rule.directoryId` set) must NOT
            // leak into a different directory unless that directory is
            // explicitly in `include`. Repo-level and global rules
            // (`rule.directoryId` undefined) keep their original
            // semantics and continue to match across all contexts.
            if (
                directoryId &&
                rule.directoryId &&
                rule.directoryId !== directoryId &&
                !include.includes(directoryId)
            ) {
                return false;
            }

            // Check if the current directory or repository is excluded or included
            const isExcluded =
                useExclude &&
                ((directoryId && exclude.includes(directoryId)) ||
                    (repositoryId && exclude.includes(repositoryId)));

            const isIncluded =
                useInclude &&
                ((directoryId && include.includes(directoryId)) ||
                    (repositoryId && include.includes(repositoryId)));

            // If excluded, it doesn't match. If not excluded, it matches if include is empty or it is included.
            return !isExcluded && (include.length === 0 || isIncluded);
        };

        return kodyRules?.filter((rule) => {
            if (!rule) {
                return false;
            } // Skip invalid rules

            // If we are querying at the repository level (no directoryId is provided)
            // we do not allow rules that are specific to a directory (they cannot match)
            if (repositoryId && !directoryId && rule.directoryId) {
                return false;
            }

            const currentLevel = this.resolveContextLevel({
                directoryId,
                repositoryId,
            });

            const matchesExactContextLevel =
                (currentLevel === 'repository' &&
                    repositoryId === rule.repositoryId) ||
                (currentLevel === 'directory' &&
                    directoryId === rule.directoryId);

            if (matchesExactContextLevel) {
                return isPathMatch(rule) && isInheritanceMatch(rule);
            }

            return (
                isPathMatch(rule) &&
                isRepositoryMatch(rule) &&
                isInheritanceMatch(rule)
            );
        });
    }

    /**
     * Private helper to check if a rule's path matches a specific *file*.
     */
    private isFilePathMatch(
        rule: Partial<IKodyRule>,
        normalizedFilename: string | null,
    ): boolean {
        // If we aren't checking a specific file, all paths match.
        if (normalizedFilename === null) {
            return true;
        }

        // If the rule has no path defined, it matches all files.
        const rulePath = rule.path?.trim();
        if (!rulePath) {
            return true;
        }

        // Use glob matching to check if the file matches the rule's path pattern.
        return isFileMatchingGlob(normalizedFilename, [rulePath]);
    }

    /**
     * Private helper to check if a rule's path matches a specific *folder*.
     */
    private isFolderPathMatch(
        rule: Partial<IKodyRule>,
        normalizedFolder: string | null,
    ): boolean {
        // If we aren't checking a specific folder, all paths match.
        if (normalizedFolder === null) {
            return true;
        }

        // If the rule has no path defined, it matches all files/folders.
        const rulePath = rule.path?.trim();
        if (!rulePath) {
            return true;
        }

        if (isFileMatchingGlob(normalizedFolder, [rulePath])) {
            return true;
        }

        const ruleBasePath = this.getGlobBasePath(rulePath);

        if (ruleBasePath === '') {
            return true;
        }

        if (ruleBasePath === normalizedFolder) {
            return true;
        }

        if (ruleBasePath.startsWith(normalizedFolder + '/')) {
            return true;
        }

        if (
            rulePath.startsWith('**') &&
            normalizedFolder.endsWith('/' + ruleBasePath)
        ) {
            return true;
        }

        return false;
    }

    /**
     * Gets the non-glob base path from a glob pattern.
     * e.g., 'src/app/*.ts' -> 'src/app'
     * e.g., '** /*.ts' -> ''
     */
    private getGlobBasePath(pattern: string): string {
        const globChars = ['*', '?', '{', '}', '[', ']', '!'];
        const parts = pattern.replace(/^\/|\/$/g, '').split('/');
        const basePathParts: string[] = [];

        for (const part of parts) {
            // Check if any glob character exists in the current path segment
            if (globChars.some((char) => part.includes(char))) {
                break; // Stop at the first segment with a wildcard
            }
            basePathParts.push(part);
        }

        return basePathParts.join('/');
    }

    private resolveContextLevel(params: {
        directoryId?: string;
        repositoryId?: string;
    }): 'global' | 'repository' | 'directory' {
        if (params.directoryId) {
            return 'directory';
        }

        if (params.repositoryId) {
            return 'repository';
        }

        return 'global';
    }

    private resolveRuleLevel(
        rule: Partial<IKodyRule>,
    ): 'global' | 'repository' | 'directory' {
        if (rule?.directoryId) {
            return 'directory';
        }

        if (rule?.repositoryId && rule.repositoryId !== 'global') {
            return 'repository';
        }

        return 'global';
    }
}

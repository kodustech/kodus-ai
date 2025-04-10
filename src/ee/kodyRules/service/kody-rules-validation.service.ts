/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import {
    IKodyRule,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { environment } from '@/ee/configs/environment';
import { Injectable } from '@nestjs/common';

/**
 * Service for validating and ordering Kody Rules in cloud mode
 */
@Injectable()
export class KodyRulesValidationService {
    public readonly MAX_KODY_RULES = 10;
    public readonly isCloud: boolean;

    constructor() {
        this.isCloud = environment.API_CLOUD_MODE;
    }

    /**
     * Validates if the total number of rules is within the allowed limit.
     * @param totalRules Total number of rules.
     * @returns True if the number of rules is within the limit, false otherwise.
     */
    validateRulesLimit(totalRules: number): boolean {
        return this.isCloud ? true : totalRules <= this.MAX_KODY_RULES;
    }

    /**
     * Returns the error message for exceeded rules limit.
     * @param organizationId Organization identifier.
     * @returns Error message if limit exceeded, or empty string.
     */
    getExceededLimitErrorMessage(organizationId: string): string {
        return this.isCloud
            ? ''
            : `Maximum number of Kody Rules (${this.MAX_KODY_RULES}) reached for organization ${organizationId}`;
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
     * It selects repository-specific and global active rules, removes duplicates,
     * orders them by createdAt (oldest first), and if not in cloud mode, limits the result to MAX_KODY_RULES.
     *
     * @param rules Array of KodyRules.
     * @param repositoryId Repository identifier.
     * @returns Array of filtered, ordered, and possibly limited KodyRules.
     */
    filterKodyRules(
        rules: Partial<IKodyRule>[] = [],
        repositoryId: string,
    ): Partial<IKodyRule>[] {
        if (!rules?.length) {
            return [];
        }

        const repositoryRules = rules.filter(
            (rule) =>
                rule?.repositoryId === repositoryId &&
                rule?.status === KodyRulesStatus.ACTIVE,
        );

        const globalRules = rules.filter(
            (rule) =>
                rule?.repositoryId === 'global' &&
                rule?.status === KodyRulesStatus.ACTIVE,
        );

        const mergedRules = [...repositoryRules, ...globalRules];
        const mergedRulesWithoutDuplicates =
            this.extractUniqueKodyRules(mergedRules);

        const limit = this.isCloud ? 0 : this.MAX_KODY_RULES;
        const orderedRules = this.orderByCreatedAtAndLimit(
            mergedRulesWithoutDuplicates,
            limit,
            'asc',
        );

        return orderedRules;
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
}

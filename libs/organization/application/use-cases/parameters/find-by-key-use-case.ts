import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createLogger } from '@libs/core/log/logger';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IParameters } from '@libs/organization/domain/parameters/interfaces/parameters.interface';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';

/**
 * PERF: In-memory cache entry with TTL support
 */
interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

/**
 * PERF: Default cache TTL in milliseconds (60 seconds)
 * Parameters rarely change, so 60s is safe and reduces DB calls significantly
 * Can be overridden via PARAMETERS_CACHE_TTL_MS env var
 */
const DEFAULT_CACHE_TTL_MS = 60_000;

@Injectable()
export class FindByKeyParametersUseCase {
    private readonly logger = createLogger(FindByKeyParametersUseCase.name);

    /**
     * PERF: In-memory cache for parameters
     *
     * Problem: findByKey is called 30+ times across the codebase per request
     * Solution: Cache results with short TTL (60s default)
     *
     * Key format: `${parametersKey}:${organizationId}:${teamId || 'no-team'}`
     */
    private readonly cache = new Map<string, CacheEntry<IParameters<any>>>();
    private readonly cacheTTL: number;

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly configService: ConfigService,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
    ) {
        this.cacheTTL = this.configService.get<number>(
            'PARAMETERS_CACHE_TTL_MS',
            DEFAULT_CACHE_TTL_MS,
        );
    }

    /**
     * Generates a cache key from the parameters key and organization/team data
     */
    private getCacheKey(
        parametersKey: ParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): string {
        const orgId = organizationAndTeamData.organizationId || 'no-org';
        const teamId = organizationAndTeamData.teamId || 'no-team';
        return `${parametersKey}:${orgId}:${teamId}`;
    }

    /**
     * Gets a cached value if it exists and hasn't expired
     */
    private getFromCache<K extends ParametersKey>(
        cacheKey: string,
    ): IParameters<K> | null {
        const entry = this.cache.get(cacheKey);
        if (!entry) {
            return null;
        }

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(cacheKey);
            return null;
        }

        return entry.data as IParameters<K>;
    }

    /**
     * Sets a value in the cache with TTL
     */
    private setInCache<K extends ParametersKey>(
        cacheKey: string,
        data: IParameters<K>,
    ): void {
        this.cache.set(cacheKey, {
            data,
            expiresAt: Date.now() + this.cacheTTL,
        });
    }

    async execute<K extends ParametersKey>(
        parametersKey: K,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IParameters<K> | null> {
        const cacheKey = this.getCacheKey(
            parametersKey,
            organizationAndTeamData,
        );

        // PERF: Check cache first
        const cached = this.getFromCache<K>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const parameter = await this.parametersService.findByKey(
                parametersKey,
                organizationAndTeamData,
            );

            if (!parameter) {
                return null;
            }

            const updatedParameters =
                await this.getUpdatedParametersWithCentralizedValidation(
                    parameter,
                    parametersKey,
                    organizationAndTeamData,
                );

            // PERF: Cache the result
            this.setInCache(cacheKey, updatedParameters);

            return updatedParameters;
        } catch (error) {
            this.logger.error({
                message: 'Error while fetching parameters by key',
                context: FindByKeyParametersUseCase.name,
                error: error,
                metadata: { parametersKey, organizationAndTeamData },
            });

            throw error;
        }
    }

    /**
     * Invalidates cache for a specific key or all keys for an organization
     * Call this when parameters are updated
     */
    invalidateCache(
        parametersKey?: ParametersKey,
        organizationAndTeamData?: OrganizationAndTeamData,
    ): void {
        if (!parametersKey && !organizationAndTeamData) {
            // Clear entire cache
            this.cache.clear();
            return;
        }

        if (parametersKey && organizationAndTeamData) {
            // Clear specific key
            const cacheKey = this.getCacheKey(
                parametersKey,
                organizationAndTeamData,
            );
            this.cache.delete(cacheKey);
            return;
        }

        // Clear by prefix (all keys for an org or all instances of a param)
        const prefix = parametersKey
            ? `${parametersKey}:`
            : `${organizationAndTeamData?.organizationId || ''}`;

        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix) || key.includes(`:${prefix}`)) {
                this.cache.delete(key);
            }
        }
    }

    private async getUpdatedParametersWithCentralizedValidation<
        K extends ParametersKey,
    >(
        parameter: ParametersEntity<K>,
        parametersKey: K,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IParameters<K>> {
        if (parametersKey === ParametersKey.CENTRALIZED_CONFIG) {
            const validatedConfigValue =
                await this.centralizedConfigPrService.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            if (validatedConfigValue) {
                return {
                    configKey: parameter.configKey,
                    configValue: validatedConfigValue as any,
                    team: parameter.team,
                    uuid: parameter.uuid,
                    active: parameter.active,
                    description: parameter.description,
                    version: parameter.version,
                    createdAt: parameter.createdAt,
                    updatedAt: parameter.updatedAt,
                };
            }
        }

        return this.getUpdatedParameters(parameter);
    }

    private getUpdatedParameters<K extends ParametersKey>(
        parameter: ParametersEntity<K>,
    ): IParameters<K> {
        if (parameter.configKey === ParametersKey.CODE_REVIEW_CONFIG) {
            /**
             * TEMPORARY LOGIC: Show/hide code review version toggle based on user registration date
             *
             * Purpose: Gradually migrate users from legacy to v2 engine
             * - Users registered BEFORE 2025-09-11: Can see version toggle (legacy + v2)
             * - Users registered ON/AFTER 2025-09-11: Only see v2 (no toggle)
             *
             * This logic should be REMOVED after all clients migrate to v2 engine
             * TODO: Remove this temporary logic after client migration completion
             */
            const cutoffYear = 2025;
            const cutoffMonth = 8; // September (0-indexed)
            const cutoffDay = 11;

            const paramYear = parameter.createdAt.getUTCFullYear();
            const paramMonth = parameter.createdAt.getUTCMonth();
            const paramDay = parameter.createdAt.getUTCDate();

            const showToggleCodeReviewVersion =
                paramYear < cutoffYear ||
                (paramYear === cutoffYear && paramMonth < cutoffMonth) ||
                (paramYear === cutoffYear &&
                    paramMonth === cutoffMonth &&
                    paramDay < cutoffDay);

            return {
                configKey: parameter.configKey,
                configValue: {
                    ...parameter.configValue,
                    showToggleCodeReviewVersion,
                },
                team: parameter.team,
                uuid: parameter.uuid,
                createdAt: parameter.createdAt,
                updatedAt: parameter.updatedAt,
                active: parameter.active,
                description: parameter.description,
                version: parameter.version,
            } as IParameters<K>;
        } else {
            return {
                configKey: parameter.configKey,
                configValue: parameter.configValue,
                team: parameter.team,
                uuid: parameter.uuid,
                active: parameter.active,
                description: parameter.description,
                version: parameter.version,
                createdAt: parameter.createdAt,
                updatedAt: parameter.updatedAt,
            } as IParameters<K>;
        }
    }
}

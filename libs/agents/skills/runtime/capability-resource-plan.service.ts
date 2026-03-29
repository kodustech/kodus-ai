import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Logger, Optional } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';

import { BoundedMap } from './bounded-map';
import { CapabilityStrategyScope } from './skill-runtime.types';

interface CapabilityResourcePlan {
    providerType: string;
    capability: string;
    tools: string[];
}

const RESOURCE_PLAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_SEED_DIR = 'resources';
const PRIMARY_SEED_DIR = 'capability-seeds';

@Injectable()
export class CapabilityResourcePlanService {
    private readonly logger = new Logger(CapabilityResourcePlanService.name);
    // TODO: Add staleness/TTL check (like CapabilityStrategyService MEMORY_STALENESS_MS)
    // if multi-pod deployments need fresher resource plans. Currently entries live
    // until BoundedMap capacity eviction, which is acceptable because resource plans
    // are quasi-static (seed + learned tools change infrequently).
    private readonly memoryCache = new BoundedMap<string, string[]>(256);
    private readonly seedCache = new BoundedMap<string, string[]>(64);

    constructor(@Optional() private readonly cacheService?: CacheService) {}

    async getCachedTools(scope: CapabilityStrategyScope): Promise<string[]> {
        const key = this.buildKey(scope);
        if (this.memoryCache.has(key)) {
            return this.memoryCache.get(key) ?? [];
        }

        if (!this.cacheService) {
            return [];
        }

        const cached = await this.cacheService.getFromCache<string[]>(key);
        const tools = Array.isArray(cached) ? cached : [];
        this.memoryCache.set(key, tools);
        return tools;
    }

    async saveCachedTools(
        scope: CapabilityStrategyScope,
        tools: string[],
    ): Promise<void> {
        const key = this.buildKey(scope);
        const normalized = [
            ...new Set(tools.filter((tool) => tool.trim().length > 0)),
        ];
        this.memoryCache.set(key, normalized);

        if (!this.cacheService) {
            return;
        }

        await this.cacheService.addToCache(
            key,
            normalized,
            RESOURCE_PLAN_CACHE_TTL_MS,
        );
    }

    getSeedTools(providerType: string, capability: string): string[] {
        if (
            !this.isSafeSegment(providerType) ||
            !this.isSafeCapability(capability)
        ) {
            return [];
        }

        const cacheKey = `${providerType}:${capability}`;
        if (this.seedCache.has(cacheKey)) {
            return this.seedCache.get(cacheKey) ?? [];
        }

        const providerCandidates =
            this.resolveProviderSeedCandidates(providerType);
        for (const providerCandidate of providerCandidates) {
            const candidates = this.getSeedFileCandidates(
                providerCandidate,
                capability,
            );
            for (const filePath of candidates) {
                if (!fs.existsSync(filePath)) {
                    continue;
                }

                try {
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    const parsed = JSON.parse(raw) as CapabilityResourcePlan;
                    const tools = Array.isArray(parsed?.tools)
                        ? parsed.tools.filter(
                              (tool): tool is string =>
                                  typeof tool === 'string' &&
                                  tool.trim().length > 0,
                          )
                        : [];

                    this.seedCache.set(cacheKey, tools);
                    return tools;
                } catch (error) {
                    this.logger.warn(
                        `Failed to read seed capability resource plan from ${filePath}: ${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`,
                    );
                }
            }
        }

        this.seedCache.set(cacheKey, []);
        return [];
    }

    private buildKey(scope: CapabilityStrategyScope): string {
        return [
            'skill-capability-resource-plan',
            scope.organizationId,
            scope.teamId,
            scope.skillName,
            scope.capability,
            scope.provider,
        ].join(':');
    }

    private getSeedFileCandidates(
        providerType: string,
        capability: string,
    ): string[] {
        const fileName = `${capability}.json`;
        const dirs = [
            path.join(
                process.cwd(),
                'libs',
                'agents',
                'skills',
                'runtime',
                PRIMARY_SEED_DIR,
                providerType,
            ),
            path.join(__dirname, '..', PRIMARY_SEED_DIR, providerType),
            path.join(
                process.cwd(),
                'libs',
                'agents',
                'skills',
                LEGACY_SEED_DIR,
                providerType,
            ),
            path.join(
                __dirname,
                '..',
                '..',
                'skills',
                LEGACY_SEED_DIR,
                providerType,
            ),
        ];

        return dirs.map((dirPath) => path.join(dirPath, fileName));
    }

    private isSafeSegment(value: string): boolean {
        return /^[a-z0-9_-]+$/i.test(value);
    }

    private isSafeCapability(value: string): boolean {
        return /^[a-z0-9._-]+$/i.test(value);
    }

    private resolveProviderSeedCandidates(providerType: string): string[] {
        const normalized = this.normalizeProviderToken(providerType);
        const compact = normalized.replace(/[-_]/g, '');
        const candidates = [normalized];

        if (normalized.includes('jira') || normalized.includes('atlassian')) {
            candidates.push('jira');
        }
        if (normalized.includes('linear')) {
            candidates.push('linear');
        }
        if (normalized.includes('notion')) {
            candidates.push('notion');
        }
        if (normalized.includes('clickup')) {
            candidates.push('clickup');
        }
        if (
            normalized.includes('kodus-github-issues') ||
            compact.includes('kodusgithubissues') ||
            (compact.includes('github') && compact.includes('issues'))
        ) {
            candidates.push('kodus-github-issues');
        }

        return [...new Set(candidates)];
    }

    private normalizeProviderToken(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '');
    }
}

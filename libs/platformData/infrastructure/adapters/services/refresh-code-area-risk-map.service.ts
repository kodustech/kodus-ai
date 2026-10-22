import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { createHash } from 'node:crypto';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { with429Retry } from '@libs/core/infrastructure/http/rate-limit-retry';
import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    buildCodeAreaRiskMap,
    type CodeAreaRiskMap,
    type HistoricalAreaPullRequest,
} from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import {
    analyzeCodeStructure,
    supportsCodeStructureAnalysis,
} from '@libs/platformData/domain/code-area-risk/analyze-code-structure';
import {
    CodeAreaHistoryPrModel,
    CodeAreaHistorySyncModel,
} from '../repositories/schemas/code-area-history.model';
import {
    CODE_AREA_RISK_MAP_SERVICE_TOKEN,
    ICodeAreaRiskMapService,
} from '@libs/platformData/domain/code-area-risk/code-area-risk-map.contract';

const WINDOW_DAYS = 7;
const LOOKBACK_DAYS = 365;
const MAX_PRS_PER_BATCH = 20;
const MAX_STRUCTURE_FILES = 60;
const MAX_FILES_PER_DIRECTORY = 3;
const STRUCTURE_FETCH_CONCURRENCY = 5;
const STRUCTURE_FETCH_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSING_REFERENCE =
    /\b(?:fix(?:es)?|clos(?:e|es)|resolv(?:e|es))\s+#(\d+)\b/gi;
const BUG_LABEL = /\b(?:bug|defect|regression)\b/i;

interface SyncState {
    source: string;
    windowStart: string;
    windowEnd: string;
    cursorEnd: string;
    scanFloor: string;
    offset: number;
    discoveredMergedPrs: number;
    complete: boolean;
}

@Injectable()
export class RefreshCodeAreaRiskMapService {
    private readonly logger = createLogger(RefreshCodeAreaRiskMapService.name);
    constructor(
        private readonly codeManagement: CodeManagementService,
        @Inject(CODE_AREA_RISK_MAP_SERVICE_TOKEN)
        private readonly maps: ICodeAreaRiskMapService,
        @InjectModel(CodeAreaHistoryPrModel.name)
        private readonly history: Model<CodeAreaHistoryPrModel>,
        @InjectModel(CodeAreaHistorySyncModel.name)
        private readonly sync: Model<CodeAreaHistorySyncModel>,
    ) {}

    async readStatus(organizationId: string, repositoryId: string) {
        if (
            typeof organizationId !== 'string' ||
            !organizationId ||
            typeof repositoryId !== 'string' ||
            !repositoryId
        ) {
            throw new Error('Invalid code-area map key');
        }
        const state = await this.sync
            .findOne(
                {
                    organizationId: { $eq: organizationId },
                    repositoryId: { $eq: repositoryId },
                },
                {
                    source: 1,
                    windowStart: 1,
                    windowEnd: 1,
                    cursorEnd: 1,
                    discoveredMergedPrs: 1,
                    complete: 1,
                },
            )
            .lean()
            .exec();
        if (!state) return null;
        return {
            source: state.source,
            windowStart: state.windowStart,
            windowEnd: state.windowEnd,
            cursorEnd: state.cursorEnd,
            discoveredMergedPrs: state.discoveredMergedPrs,
            complete: state.complete,
        };
    }

    /** One bounded, idempotent batch. A scheduler can call it until complete. */
    async refreshOneBatch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    }): Promise<{ complete: boolean; processed: number; cursorEnd: string }> {
        const { organizationAndTeamData, repository } = params;
        const organizationId = organizationAndTeamData.organizationId;
        if (
            typeof organizationId !== 'string' ||
            !organizationId ||
            typeof repository.id !== 'string' ||
            !repository.id ||
            typeof repository.name !== 'string' ||
            !repository.name
        ) {
            throw new Error(
                'Organization and repository are required for area history',
            );
        }
        const key = { organizationId, repositoryId: repository.id };
        let state = (await this.sync.findOne(key).lean().exec()) as
            (SyncState & typeof key) | null;
        if (!state) {
            const now = new Date();
            state = {
                ...key,
                source:
                    (await this.codeManagement.getTypeIntegration(
                        organizationAndTeamData,
                    )) ?? 'unknown',
                windowStart: new Date(
                    now.getTime() - LOOKBACK_DAYS * DAY_MS,
                ).toISOString(),
                windowEnd: now.toISOString(),
                cursorEnd: now.toISOString(),
                scanFloor: new Date(
                    now.getTime() - LOOKBACK_DAYS * DAY_MS,
                ).toISOString(),
                offset: 0,
                discoveredMergedPrs: 0,
                complete: false,
            };
            await this.sync.updateOne(
                key,
                { $setOnInsert: state },
                { upsert: true },
            );
        }
        if (
            ![PlatformType.GITHUB, PlatformType.GITLAB].includes(
                state.source as PlatformType,
            )
        ) {
            throw new Error(
                `Area history does not support ${state.source} date-filtered scans yet`,
            );
        }
        if (state.complete) {
            const now = new Date();
            if (now.getTime() - Date.parse(state.windowEnd) < DAY_MS) {
                const existing = await this.maps.read(
                    organizationId,
                    repository.id,
                );
                if (existing && !existing.structureCoverage) {
                    await this.addCodeStructureSample(
                        existing,
                        organizationAndTeamData,
                        repository,
                    );
                    await this.maps.save(
                        organizationId,
                        repository.id,
                        existing,
                    );
                }
                return {
                    complete: true,
                    processed: 0,
                    cursorEnd: state.cursorEnd,
                };
            }
            state = {
                ...state,
                scanFloor: state.windowEnd,
                windowEnd: now.toISOString(),
                cursorEnd: now.toISOString(),
                offset: 0,
                complete: false,
            };
            await this.sync.updateOne(key, { $set: state });
        }

        const rangeEnd = Date.parse(state.cursorEnd);
        const rangeStart = Math.max(
            Date.parse(state.scanFloor ?? state.windowStart),
            rangeEnd - WINDOW_DAYS * DAY_MS,
        );
        const listed = await with429Retry(
            () =>
                this.codeManagement.getPullRequestsByRepository({
                    organizationAndTeamData,
                    repository,
                    filters: {
                        startDate: new Date(rangeStart).toISOString(),
                        endDate: new Date(rangeEnd).toISOString(),
                        dateField: 'updated',
                    },
                }),
            { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 },
        );
        if (!Array.isArray(listed)) {
            throw new Error('Could not list PR history for area map');
        }
        const ordered = listed
            .filter((pr) => Number.isInteger(pr.number ?? pr.pull_number))
            .sort(
                (a, b) =>
                    String(b.updated_at ?? b.created_at ?? '').localeCompare(
                        String(a.updated_at ?? a.created_at ?? ''),
                    ) ||
                    (b.number ?? b.pull_number) - (a.number ?? a.pull_number),
            );
        const batch = ordered.slice(
            state.offset,
            state.offset + MAX_PRS_PER_BATCH,
        );
        const issuesSupported = await this.codeManagement
            .isIssuesSupported(organizationAndTeamData)
            .catch(() => false);
        let processed = 0;
        for (const listedPr of batch) {
            const number = listedPr.number ?? listedPr.pull_number;
            const pr = listedPr.merged_at
                ? listedPr
                : await with429Retry(
                      () =>
                          this.codeManagement.getPullRequest({
                              organizationAndTeamData,
                              repository,
                              prNumber: number,
                          }),
                      {
                          maxAttempts: 4,
                          baseDelayMs: 2_000,
                          maxDelayMs: 30_000,
                      },
                  );
            if (!pr?.merged_at) continue;
            const files = await with429Retry(
                () =>
                    this.codeManagement.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: number,
                        headSha: pr.head?.sha,
                    }),
                { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 },
            );
            const linkedBugIssues = issuesSupported
                ? await this.findLinkedBugIssues(
                      organizationAndTeamData,
                      String(pr.repository ?? repository.name),
                      String(pr.body ?? ''),
                      String(pr.prURL ?? ''),
                  )
                : null;
            const evidence: HistoricalAreaPullRequest = {
                number,
                url: pr.prURL ?? '',
                title: pr.title ?? '',
                mergedAt: pr.merged_at,
                linkedBugIssues,
                files: Array.isArray(files)
                    ? files
                          .map((file) => file.filename ?? file.path)
                          .filter((path): path is string => !!path)
                    : [],
                filesComplete: Array.isArray(files),
            };
            await this.history.updateOne(
                { ...key, number },
                { $set: evidence },
                { upsert: true },
            );
            processed += 1;
        }

        const finishedRange = state.offset + batch.length >= ordered.length;
        const nextState: SyncState = {
            ...state,
            offset: finishedRange ? 0 : state.offset + batch.length,
            cursorEnd: finishedRange
                ? new Date(rangeStart).toISOString()
                : state.cursorEnd,
            discoveredMergedPrs: state.discoveredMergedPrs + processed,
            complete:
                finishedRange &&
                rangeStart <= Date.parse(state.scanFloor ?? state.windowStart),
        };
        await this.sync.updateOne(key, { $set: nextState });
        const records = await this.history.find(key).lean().exec();
        const snapshot = buildCodeAreaRiskMap({
            source: state.source,
            windowStart: state.windowStart,
            windowEnd: state.windowEnd,
            refreshedAt: new Date().toISOString(),
            discoveredMergedPrs: nextState.discoveredMergedPrs,
            scanComplete: nextState.complete,
            pullRequests: records,
        });
        const previous = await this.maps.read(organizationId, repository.id);
        if (
            nextState.complete ||
            !previous?.structureCoverage ||
            (previous.structureCoverage.eligibleFiles > 0 &&
                previous.structureCoverage.analyzedFiles === 0)
        ) {
            await this.addCodeStructureSample(
                snapshot,
                organizationAndTeamData,
                repository,
            );
        } else {
            const previousByPath = new Map(
                previous.directDirectories.map((area) => [
                    area.path,
                    area.structure,
                ]),
            );
            snapshot.directDirectories = snapshot.directDirectories.map(
                (area) => ({
                    ...area,
                    ...(previousByPath.get(area.path)
                        ? { structure: previousByPath.get(area.path) }
                        : {}),
                }),
            );
            const eligibleFiles = snapshot.files.filter((file) =>
                supportsCodeStructureAnalysis(file.path),
            ).length;
            const analyzedFiles = snapshot.directDirectories.reduce(
                (sum, area) => sum + (area.structure?.analyzedFiles ?? 0),
                0,
            );
            snapshot.structureCoverage = {
                eligibleFiles,
                analyzedFiles,
                sampled: analyzedFiles < eligibleFiles,
            };
            snapshot.version = createHash('sha256')
                .update(JSON.stringify(snapshot))
                .digest('hex');
        }
        await this.maps.save(organizationId, repository.id, snapshot);
        return {
            complete: nextState.complete,
            processed,
            cursorEnd: nextState.cursorEnd,
        };
    }

    private async addCodeStructureSample(
        snapshot: CodeAreaRiskMap,
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
    ): Promise<void> {
        const eligible = snapshot.files.filter((area) =>
            supportsCodeStructureAnalysis(area.path),
        );
        const filesByDirectory = new Map<string, typeof eligible>();
        for (const file of eligible) {
            const slash = file.path.lastIndexOf('/');
            const parent = slash < 0 ? '.' : file.path.slice(0, slash);
            const files = filesByDirectory.get(parent) ?? [];
            files.push(file);
            filesByDirectory.set(parent, files);
        }
        const selected = new Set<string>();
        for (const area of [...snapshot.directDirectories].sort(
            (a, b) => b.changedPrs - a.changedPrs,
        )) {
            const candidates = [
                ...(filesByDirectory.get(area.path) ?? []),
            ].sort((a, b) => b.changedPrs - a.changedPrs);
            for (const file of candidates.slice(0, MAX_FILES_PER_DIRECTORY)) {
                if (selected.size >= MAX_STRUCTURE_FILES) break;
                selected.add(file.path);
            }
            if (selected.size >= MAX_STRUCTURE_FILES) break;
        }
        const results = new Map<
            string,
            { functions: number; functionsNeedingAttention: number }
        >();
        if (selected.size) {
            const branch = await this.codeManagement
                .getDefaultBranch({ organizationAndTeamData, repository })
                .catch((error) => {
                    this.logger.warn({
                        message:
                            'Could not load default branch for structure sampling',
                        context: RefreshCodeAreaRiskMapService.name,
                        error,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                            repositoryId: repository.id,
                        },
                    });
                    return null;
                });
            if (typeof branch === 'string' && branch) {
                const paths = [...selected];
                for (
                    let offset = 0;
                    offset < paths.length;
                    offset += STRUCTURE_FETCH_CONCURRENCY
                ) {
                    await Promise.all(
                        paths
                            .slice(offset, offset + STRUCTURE_FETCH_CONCURRENCY)
                            .map(async (path) => {
                                const response = await runWithBoundedTimeout(
                                    this.codeManagement.getRepositoryContentFile(
                                        {
                                            organizationAndTeamData,
                                            repository,
                                            file: { filename: path },
                                            pullRequest: {
                                                head: { ref: branch },
                                                base: { ref: branch },
                                            },
                                            suppressNotFoundLogs: true,
                                        },
                                    ),
                                    STRUCTURE_FETCH_TIMEOUT_MS,
                                    'structure file fetch',
                                ).catch((error) => {
                                    const failure = error as {
                                        status?: number;
                                        response?: { status?: number };
                                    };
                                    if (
                                        (failure?.status ??
                                            failure?.response?.status) !== 404
                                    ) {
                                        this.logger.warn({
                                            message:
                                                'Could not load file for structure sampling',
                                            context:
                                                RefreshCodeAreaRiskMapService.name,
                                            error,
                                            metadata: {
                                                organizationId:
                                                    organizationAndTeamData.organizationId,
                                                teamId: organizationAndTeamData.teamId,
                                                repositoryId: repository.id,
                                                branch,
                                                path,
                                                timeoutMs:
                                                    STRUCTURE_FETCH_TIMEOUT_MS,
                                            },
                                        });
                                    }
                                    return null;
                                });
                                const encoded = response?.data?.content;
                                const encoding = response?.data?.encoding;
                                if (typeof encoded !== 'string') return;
                                const content =
                                    encoding === 'base64'
                                        ? Buffer.from(
                                              encoded,
                                              'base64',
                                          ).toString('utf8')
                                        : encoding === 'utf-8'
                                          ? encoded
                                          : null;
                                if (content === null) return;
                                const result = analyzeCodeStructure(
                                    path,
                                    content,
                                );
                                if (result) results.set(path, result);
                            }),
                    );
                }
            }
        }
        snapshot.directDirectories = snapshot.directDirectories.map((area) => {
            const files = filesByDirectory.get(area.path) ?? [];
            const measured = files
                .map((file) => results.get(file.path))
                .filter((result) => result !== undefined);
            return {
                ...area,
                structure: {
                    eligibleFiles: files.length,
                    analyzedFiles: measured.length,
                    functions: measured.reduce(
                        (sum, result) => sum + result.functions,
                        0,
                    ),
                    functionsNeedingAttention: measured.reduce(
                        (sum, result) => sum + result.functionsNeedingAttention,
                        0,
                    ),
                    files: files
                        .filter((file) => results.has(file.path))
                        .map((file) => ({
                            path: file.path,
                            ...results.get(file.path)!,
                        }))
                        .sort(
                            (a, b) =>
                                b.functionsNeedingAttention -
                                    a.functionsNeedingAttention ||
                                a.path.localeCompare(b.path),
                        ),
                },
            };
        });
        snapshot.structureCoverage = {
            eligibleFiles: eligible.length,
            analyzedFiles: results.size,
            sampled: results.size < eligible.length,
        };
        snapshot.version = createHash('sha256')
            .update(JSON.stringify(snapshot))
            .digest('hex');
    }

    private async findLinkedBugIssues(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryName: string,
        body: string,
        prUrl: string,
    ): Promise<string[] | null> {
        let pathParts = repositoryName.split('/').filter(Boolean);
        try {
            const urlParts = new URL(prUrl).pathname.split('/').filter(Boolean);
            const boundary = urlParts.findIndex((part) =>
                ['-', 'pull', 'pulls', 'merge_requests'].includes(part),
            );
            if (boundary > 1) pathParts = urlParts.slice(0, boundary);
        } catch {
            // The stored repository path remains the fallback.
        }
        const name = pathParts.at(-1);
        const owner = pathParts.slice(0, -1).join('/');
        if (!owner || !name) return null;
        const numbers = [
            ...new Set(
                [...body.matchAll(CLOSING_REFERENCE)]
                    .map((match) => Number(match[1]))
                    .filter(
                        (number) => Number.isSafeInteger(number) && number > 0,
                    ),
            ),
        ].slice(0, 5);
        const urls: string[] = [];
        for (const issueNumber of numbers) {
            try {
                const issue = await with429Retry(
                    () =>
                        this.codeManagement.getIssue({
                            organizationAndTeamData,
                            repository: { owner, name },
                            issueNumber,
                        }),
                    { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 },
                );
                if (issue?.labels.some((label) => BUG_LABEL.test(label))) {
                    urls.push(issue.url);
                }
            } catch {
                return null;
            }
        }
        return urls;
    }
}

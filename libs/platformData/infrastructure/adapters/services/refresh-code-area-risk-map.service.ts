import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { with429Retry } from '@libs/core/infrastructure/http/rate-limit-retry';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    buildCodeAreaRiskMap,
    type HistoricalAreaPullRequest,
} from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import {
    CodeAreaHistoryPrModel,
    CodeAreaHistorySyncModel,
} from '../repositories/schemas/code-area-history.model';
import { CodeAreaRiskMapService } from './code-area-risk-map.service';

const WINDOW_DAYS = 7;
const LOOKBACK_DAYS = 365;
const MAX_PRS_PER_BATCH = 20;
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
    constructor(
        private readonly codeManagement: CodeManagementService,
        private readonly maps: CodeAreaRiskMapService,
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
        await this.maps.save(organizationId, repository.id, snapshot);
        return {
            complete: nextState.complete,
            processed,
            cursorEnd: nextState.cursorEnd,
        };
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

/**
 * What a pull request webhook costs the PR document, measured against a REAL
 * MongoDB through the real save path (SavePullRequestUseCase →
 * PullRequestsService → PullRequestsRepository).
 *
 * A PR with 300 files is opened, reviewed, then gets events that change no
 * file: a close (no file fetch) and a synchronize whose files are the ones
 * already stored. Neither may rewrite the files, and the close must not wipe
 * what the review recorded on them (reviewMode, codeReviewModelUsed). A push
 * that edits one file writes that file only.
 *
 * Command monitoring counts the write statements the server received and the
 * bytes it sent back.
 */
import { BSON } from 'mongodb';
import mongoose, { Connection, Model } from 'mongoose';

import { PlatformType } from '@libs/core/domain/enums';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsService } from '@libs/platformData/infrastructure/adapters/services/pullRequests.service';

import { SavePullRequestUseCase } from './save.use-case';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
const gate = resolveMongoTestGate();
const TEST_DB = 'kodus_pr_webhook_writes_it';
const ORG = 'org-webhook-it';
const FILES = 300;
const PATCH =
    '@@ -1,40 +1,40 @@\n' + '-old line of code\n+new line of code\n'.repeat(40);

const file = (i: number, patch = PATCH) => ({
    filename: `src/module-${i}/file-${i}.ts`,
    sha: `sha-${i}`,
    status: 'modified',
    additions: 40,
    deletions: 40,
    changes: 80,
    patch,
});

const payload = (action: string) => ({
    action,
    repository: {
        id: 4242,
        name: 'repo-it',
        full_name: 'acme/repo-it',
        html_url: 'https://github.com/acme/repo-it',
    },
    pull_request: {
        number: 7,
        title: 'A wide change',
        state: action === 'closed' ? 'closed' : 'open',
        merged: false,
        closed_at: action === 'closed' ? '2026-11-18T12:00:00Z' : null,
        user: { login: 'dev', id: 1 },
        requested_reviewers: [],
        assignees: [],
        head: {
            ref: 'feat',
            sha: 'head-sha',
            repo: { full_name: 'acme/repo-it' },
        },
        base: {
            ref: 'main',
            sha: 'base-sha',
            repo: { full_name: 'acme/repo-it' },
        },
        html_url: 'https://github.com/acme/repo-it/pull/7',
    },
});

type Cost = {
    fileWrites: number;
    writes: number;
    aggregates: number;
    replyBytes: number;
    commands: Record<string, number>;
};

let connection: Connection | null = null;
let available = false;

(gate.shouldSkip ? describe.skip : describe)(
    'pull request webhook writes (real MongoDB)',
    () => {
        let model: Model<PullRequestsModel>;
        let useCase: SavePullRequestUseCase;
        let service: PullRequestsService;
        let filesFromApi: ReturnType<typeof file>[];
        const tracked = new Map<number, string>();
        let cost: Cost;

        beforeAll(async () => {
            const uri = gate.mongoUri;
            connection = await mongoose
                .createConnection(uri, {
                    dbName: TEST_DB,
                    monitorCommands: true,
                    serverSelectionTimeoutMS: 2000,
                })
                .asPromise();
            available = true;
            await connection.dropDatabase();

            const client = connection.getClient();
            client.on('commandStarted', (event) => {
                const cmd = event.command;
                // The command's own key names the collection (a findAndModify
                // also carries an `update` key: its update document).
                const target = cmd[event.commandName];
                if (target !== 'pullRequests' || !cost) return;
                tracked.set(event.requestId, event.commandName);
                cost.commands[event.commandName] =
                    (cost.commands[event.commandName] ?? 0) + 1;
                if (event.commandName === 'update') {
                    const statements = cmd.updates ?? [];
                    cost.writes += statements.length;
                    cost.fileWrites += statements.filter((s: any) =>
                        Object.keys(s.u?.$set ?? {}).some((k) =>
                            k.startsWith('files.$.patch'),
                        ),
                    ).length;
                }
                if (event.commandName === 'findAndModify') cost.writes += 1;
                if (event.commandName === 'aggregate') cost.aggregates += 1;
            });
            client.on('commandSucceeded', (event) => {
                if (!tracked.delete(event.requestId)) return;
                cost.replyBytes += BSON.calculateObjectSize(event.reply as any);
            });

            model = connection.model<PullRequestsModel>(
                PullRequestsModel.name,
                PullRequestsSchema,
            );
            await model.init();

            const repository = new PullRequestsRepository(model as any);
            // Any provider call the save makes besides files and commits answers
            // "nothing known", as for a user without a linked account.
            const codeManagement = new Proxy(
                {
                    getFilesByPullRequestId: async () => filesFromApi,
                    getCommitsForPullRequestForCodeReview: async () => [
                        {
                            sha: 'c1',
                            message: 'change',
                            author: { name: 'dev' },
                        },
                    ],
                } as Record<string, unknown>,
                {
                    get: (target, key: string) =>
                        Object.hasOwn(target, key)
                            ? target[key]
                            : async () => undefined,
                },
            );
            service = new PullRequestsService(
                repository as any,
                codeManagement as any,
            );
            useCase = new SavePullRequestUseCase(
                {
                    findIntegrationConfigWithTeams: async () => [
                        {
                            team: {
                                uuid: 'team-it',
                                organization: { uuid: ORG },
                            },
                        },
                    ],
                } as any,
                service as any,
                repository as any,
                codeManagement as any,
            );
            for (const target of [service, useCase] as any[]) {
                target.logger = { log() {}, warn() {}, error() {}, debug() {} };
            }
        }, 30_000);

        afterAll(async () => {
            if (connection) {
                if (available) await connection.dropDatabase();
                await connection.close();
            }
        });

        const measure = async (run: () => Promise<unknown>): Promise<Cost> => {
            cost = {
                fileWrites: 0,
                writes: 0,
                aggregates: 0,
                replyBytes: 0,
                commands: {},
            };
            await run();
            return { ...cost };
        };
        const webhook = (action: string) =>
            useCase.execute({
                payload: payload(action),
                platformType: PlatformType.GITHUB,
                event: 'pull_request',
            });
        const stored = async () => {
            const doc: any = await model
                .findOne({ organizationId: ORG, number: 7 })
                .lean();
            return { doc, bytes: BSON.calculateObjectSize(doc) };
        };

        it('an event that changes no file does not rewrite the files', async () => {
            filesFromApi = Array.from({ length: FILES }, (_, i) => file(i));
            await measure(() => webhook('opened'));

            // The review records how each file was reviewed.
            await service.aggregateAndSaveDataStructure(
                {
                    ...payload('synchronize').pull_request,
                    repository: { id: '4242' },
                },
                { id: '4242', name: 'repo-it' },
                filesFromApi.map((f) => ({
                    ...f,
                    reviewMode: 'heavy_mode',
                    codeReviewModelUsed: {
                        generateSuggestions: 'model-x',
                        safeguard: 'model-y',
                    },
                })),
                [],
                [],
                PlatformType.GITHUB,
                { organizationId: ORG, teamId: 'team-it' },
                [],
                undefined,
                { keepStoredState: true },
            );
            const reviewed = await stored();
            expect(reviewed.doc.files).toHaveLength(FILES);

            const closed = await measure(() => webhook('closed'));
            const afterClose = await stored();
            const resync = await measure(() => webhook('synchronize'));

            filesFromApi = filesFromApi.map((f, i) =>
                i === 3 ? file(3, PATCH + '+one more line\n') : f,
            );
            const onePush = await measure(() => webhook('synchronize'));
            const afterPush = await stored();

            console.log(
                '[pr-webhook-it] ' +
                    JSON.stringify({
                        documentBytes: reviewed.bytes,
                        closed,
                        resync,
                        onePush,
                    }),
            );

            // A close rewrites no file and reads/returns no copy of the document.
            expect(closed.fileWrites).toBe(0);
            expect(closed.aggregates).toBe(0);
            expect(closed.replyBytes).toBeLessThan(reviewed.bytes);
            // ...and keeps what the review recorded on each file.
            expect(afterClose.doc.status).toBe('closed');
            expect(
                afterClose.doc.files.every(
                    (f: any) =>
                        f.reviewMode === 'heavy_mode' &&
                        f.codeReviewModelUsed?.generateSuggestions ===
                            'model-x',
                ),
            ).toBe(true);
            // A synchronize whose files are the stored ones rewrites none of them,
            // and the totals are not recomputed.
            expect(resync.fileWrites).toBe(0);
            expect(resync.aggregates).toBe(0);
            // A push that edits one file writes that file.
            expect(onePush.fileWrites).toBe(1);
            expect(afterPush.doc.files[3].patch).toContain('+one more line');
            expect(afterPush.doc.files).toHaveLength(FILES);
            // The push keeps what the review recorded on the files it did not edit.
            expect(afterPush.doc.files[5].reviewMode).toBe('heavy_mode');
        }, 120_000);
    },
);

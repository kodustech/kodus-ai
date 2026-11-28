/**
 * What one centralized-config sync costs the Kody Rules document, measured
 * against a REAL MongoDB.
 *
 * Production (Nov 2026): every PR event re-ran the sync, and every run marked
 * the same 154 already-deleted rules as deleted again and rewrote every
 * unchanged rule. Each of those writes is a findAndModify on the organization's
 * single kodyRules document that hands the whole document back. This spec
 * replays that history through the real repository, service and use cases:
 *
 *   1. the config repository holds 174 rule files  → sync creates 174 rules
 *   2. 154 of the files are removed                → sync deletes those 154
 *   3. nothing changes in the repository           → sync runs again
 *
 * Step 3 is what every later PR event looks like. It must not write to the
 * document at all, nor ask the detector compiler (an LLM call) to recompile
 * rules nobody edited.
 *
 * The Mongo client is opened with command monitoring, so the assertions count
 * the commands the server actually received and the bytes it sent back.
 *
 * Runs in a throwaway database that is dropped afterwards.
 */
import { BSON } from 'mongodb';
import mongoose, { Connection, Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { KodyRulesRepository } from '@libs/ee/kodyRules/repository/kodyRules.repository';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    KodyRulesModel,
    KodyRulesSchema,
} from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { IKodyRuleFileMeta } from '@libs/centralized-config/domain/contracts/CentralizedConfigService.contract';

import { CentralizedConfigService } from '../centralized-config.service';
import { resolveMongoTestGate } from '../../../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
// No API_MG_DB_HOST fallback: that is a docker-network hostname that never
// resolves from the host, so a local .env carrying it must skip, not fail.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_kody_rules_sync_it';
const ORG = 'org-sync-it';
const organizationAndTeamData = { organizationId: ORG, teamId: 'team-it' };
// The actor the real sync passes (CentralizedConfigSyncUseCase).
const actor = {
    organizationId: ORG,
    source: 'sync' as const,
    userEmail: 'kody@kodus.io',
    userId: 'kody',
};

const TOTAL_FILES = 174;
const KEPT_FILES = 20;
const REMOVED_FILES = TOTAL_FILES - KEPT_FILES; // 154, as in production

// Rule text of a realistic size, so the document is not trivially small.
const ruleText = (i: number) =>
    `Rule ${i}: ` +
    'Prefer explicit error handling over silent catches. '.repeat(40);

const fileMeta = (i: number): IKodyRuleFileMeta => ({
    centralizedDirectoryPath: 'repo-1/.kody-rules/review',
    repositoryId: 'repo-1',
    ruleType: KodyRulesType.STANDARD,
    ruleFilePath: `repo-1/.kody-rules/review/rule-${i}.yml`,
    path: `repo-1/.kody-rules/review/rule-${i}.yml`,
});

const fileContent = (i: number) => ({
    title: `Rule ${i}`,
    rule: ruleText(i),
    severity: 'high',
});

type Measured = {
    /** findAndModify / update commands sent to kodyRules. */
    writes: number;
    /** Bytes the server sent back for every kodyRules command. */
    replyBytes: number;
    /** Detector compiles requested (each one is an LLM call). */
    compiles: number;
};

let connection: Connection | null = null;
let available = false;

(gate.shouldSkip ? describe.skip : describe)(
    'centralized-config sync of Kody Rules (real MongoDB)',
    () => {
        let model: Model<KodyRulesModel>;
        let service: CentralizedConfigService;
        let compileAndSave: jest.Mock;
        const kodyRulesCommands = new Map<number, string>();
        let counters = { writes: 0, replyBytes: 0 };

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

            const client = connection.getClient();
            client.on('commandStarted', (event) => {
                const target =
                    event.command.findAndModify ??
                    event.command.update ??
                    event.command.find ??
                    event.command.aggregate ??
                    event.command.insert;
                if (target !== 'kodyRules') return;
                kodyRulesCommands.set(event.requestId, event.commandName);
                if (
                    event.commandName === 'findAndModify' ||
                    event.commandName === 'update'
                ) {
                    counters.writes += 1;
                }
            });
            client.on('commandSucceeded', (event) => {
                if (!kodyRulesCommands.has(event.requestId)) return;
                kodyRulesCommands.delete(event.requestId);
                counters.replyBytes += BSON.calculateObjectSize(
                    event.reply as any,
                );
            });

            model = connection.model<KodyRulesModel>(
                KodyRulesModel.name,
                KodyRulesSchema,
            );
            await model.deleteMany({});

            const validation = {
                validateRulesLimit: jest.fn().mockResolvedValue(true),
            } as any;
            const repository = new KodyRulesRepository(
                model as any,
                validation,
            );
            const kodyRulesService = new KodyRulesService(
                repository as any,
                new EventEmitter2(),
                {} as any, // ruleLikeService
                {} as any, // pullRequestsRepository
                validation,
                {} as any, // mcpManagerService
                {} as any, // observabilityService
                {} as any, // permissionValidationService
                // No parameters/integration providers: the repository-config
                // backfill after a create bails out, as it does when they are absent.
                {
                    get: () => {
                        throw new Error('not provided');
                    },
                } as any,
                {} as any, // codeBaseConfigService
            );

            compileAndSave = jest.fn().mockResolvedValue({ compiled: false });
            const createOrUpdate = new CreateOrUpdateKodyRulesUseCase(
                kodyRulesService as any,
                {} as any, // contextResolutionService
                {} as any, // authorizationService
                {} as any, // contextReferenceDetectionService
                {} as any, // centralizedConfigPrService
                {} as any, // permissionValidationService
                { compileAndSave } as any,
                { kodyRuleChanged: jest.fn() } as any,
            );
            // Reference detection is an LLM call too; it is not what this measures.
            jest.spyOn(
                createOrUpdate as any,
                'detectAndSaveReferencesAsync',
            ).mockResolvedValue(undefined);

            const deleteRule = new DeleteRuleInOrganizationByIdKodyRulesUseCase(
                kodyRulesService as any,
                {} as any, // centralizedConfigPrService (not reached by a sync)
                {} as any, // authorizationService (not reached by a sync)
                { kodyRuleChanged: jest.fn() } as any,
                {} as any, // teamService (no teamId on the sync actor)
            );

            service = new CentralizedConfigService(
                {
                    findByKey: jest.fn(),
                    findActiveByKeyInOrganization: jest
                        .fn()
                        .mockResolvedValue([]),
                } as any, // parametersService
                {
                    findIntegrationConfigFormatted: jest
                        .fn()
                        .mockResolvedValue([{ id: 'repo-1', name: 'repo-1' }]),
                } as any,
                // The rules' source is stamped with the connection's server.
                {
                    connectionServerKey: jest
                        .fn()
                        .mockResolvedValue('GITHUB|github.com'),
                } as any, // codeManagementService
                { execute: jest.fn() } as any,
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                {} as any, // codeBaseConfigService (no directory-scoped rules here)
                createOrUpdate,
                deleteRule,
                kodyRulesService as any,
                // Every rule's last detection reads as clean.
                {
                    lastDetectionFailed: jest.fn().mockResolvedValue(false),
                } as any,
            );
            jest.spyOn(
                service,
                'getCentralizedConfigRepository',
            ).mockResolvedValue({
                id: 'config-repo',
                name: 'config-repo',
            } as any);
            jest.spyOn(service, 'fetchKodyRuleFile').mockImplementation(
                async ({ filePath }: { filePath: string }) => {
                    const i = Number(/rule-(\d+)\.yml$/.exec(filePath)?.[1]);
                    return fileContent(i) as any;
                },
            );
            for (const method of ['log', 'warn', 'error', 'debug'] as const) {
                jest.spyOn((service as any).logger, method).mockImplementation(
                    () => undefined,
                );
            }
        }, 30_000);

        afterAll(async () => {
            if (connection) {
                if (available) await connection.dropDatabase();
                await connection.close();
            }
        });

        /** One sync, as CentralizedConfigSyncUseCase runs it: rules, then stale. */
        async function sync(ruleFiles: IKodyRuleFileMeta[]): Promise<Measured> {
            counters = { writes: 0, replyBytes: 0 };
            compileAndSave.mockClear();

            const synced = await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });
            expect(synced.success).toBe(true);

            const removed = await service.removeStaleKodyRules({
                organizationAndTeamData,
                ruleFiles,
                configFiles: [{ path: 'kodus-config.yml' } as any],
                actor,
            });
            expect(removed.success).toBe(true);

            // Detector compiles are fired without being awaited.
            await new Promise((resolve) => setImmediate(resolve));

            return { ...counters, compiles: compileAndSave.mock.calls.length };
        }

        const statusCounts = async () => {
            const doc = await model.findOne({ organizationId: ORG }).lean();
            const counts: Record<string, number> = {};
            for (const rule of doc?.rules ?? []) {
                counts[rule.status] =
                    (Object.hasOwn(counts, rule.status)
                        ? counts[rule.status]
                        : 0) + 1;
            }
            return { counts, bytes: BSON.calculateObjectSize(doc as any) };
        };

        it('an unchanged repository costs the rules document no write', async () => {
            const all = Array.from({ length: TOTAL_FILES }, (_, i) =>
                fileMeta(i),
            );
            const kept = all.slice(0, KEPT_FILES);

            await sync(all);
            expect((await statusCounts()).counts).toEqual({
                [KodyRulesStatus.ACTIVE]: TOTAL_FILES,
            });

            const removal = await sync(kept);
            const afterRemoval = await statusCounts();
            expect(afterRemoval.counts).toEqual({
                [KodyRulesStatus.ACTIVE]: KEPT_FILES,
                [KodyRulesStatus.DELETED]: REMOVED_FILES,
            });

            const idle = await sync(kept);
            const idleAgain = await sync(kept);

            console.log(
                '[kody-rules-sync-it] ' +
                    JSON.stringify({
                        documentBytes: afterRemoval.bytes,
                        removalSync: removal,
                        unchangedSync: idle,
                        unchangedSyncAgain: idleAgain,
                    }),
            );

            // Removing 154 rules writes each once and reads each rule, not the
            // whole document once per rule.
            expect(removal.writes).toBe(REMOVED_FILES);
            expect(removal.replyBytes).toBeLessThan(afterRemoval.bytes * 10);

            // Nothing changed, so nothing is written and nothing is recompiled.
            expect(idle.writes).toBe(0);
            expect(idle.compiles).toBe(0);
            expect(idleAgain).toEqual(idle);
            // What comes back is the reads the sync needs, not a copy of the
            // document per rule: at most a few documents' worth in total.
            expect(idle.replyBytes).toBeLessThan(afterRemoval.bytes * 4);
            // The stored rules are what they were.
            expect((await statusCounts()).counts).toEqual(afterRemoval.counts);
        }, 120_000);

        it('still writes what changed: an edited file and a file that came back', async () => {
            const kept = Array.from({ length: KEPT_FILES }, (_, i) =>
                fileMeta(i),
            );
            const ruleOf = async (i: number) => {
                const doc = await model.findOne({ organizationId: ORG }).lean();
                return doc?.rules.find(
                    (rule) => rule.centralizedConfig?.path === fileMeta(i).path,
                );
            };
            const before = await statusCounts();
            const edited = await ruleOf(3);
            const bystander = await ruleOf(5);
            const returning = await ruleOf(KEPT_FILES); // removed by the first test
            expect(returning?.status).toBe(KodyRulesStatus.DELETED);

            const original = fileContent;
            const fetch = jest.spyOn(service, 'fetchKodyRuleFile');
            fetch.mockImplementation(
                async ({ filePath }: { filePath: string }) => {
                    const i = Number(/rule-(\d+)\.yml$/.exec(filePath)?.[1]);
                    return (
                        i === 3
                            ? { ...original(i), rule: 'Edited rule text.' }
                            : original(i)
                    ) as any;
                },
            );

            const editSync = await sync([...kept, fileMeta(KEPT_FILES)]);

            console.log('[kody-rules-sync-it] ' + JSON.stringify({ editSync }));

            // One rule edited, one brought back: two writes, nothing else.
            expect(editSync.writes).toBe(2);
            expect(editSync.compiles).toBe(2);
            // Each write returns the rule it wrote, not the document: the
            // sync reads four documents, and two writes returning theirs
            // would make it six.
            expect(editSync.replyBytes).toBeLessThan(before.bytes * 5);

            const afterEdit = await ruleOf(3);
            expect(afterEdit?.uuid).toBe(edited?.uuid);
            expect(afterEdit?.rule).toBe('Edited rule text.');
            expect(afterEdit?.status).toBe(KodyRulesStatus.ACTIVE);

            const back = await ruleOf(KEPT_FILES);
            expect(back?.uuid).toBe(returning?.uuid);
            expect(back?.status).toBe(KodyRulesStatus.ACTIVE);

            // The other rules were left exactly as they were, not rewritten.
            expect(await ruleOf(5)).toEqual(bystander);

            // And the next sync over the same files writes nothing again.
            const idle = await sync([...kept, fileMeta(KEPT_FILES)]);
            expect(idle.writes).toBe(0);
            expect(idle.compiles).toBe(0);
        }, 120_000);
    },
);

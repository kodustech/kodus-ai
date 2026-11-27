import { createHash, randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import mongoose, { Connection, Model } from 'mongoose';
import { CliKodyRulesController } from '../../../apps/api/src/controllers/cli/cli-kody-rules.controller';
import {
    ruleCompileHash,
    ruleContextNeedHash,
} from '@libs/common/utils/kody-rules/compile-hash';
import { KodyRulesRepository } from '@libs/ee/kodyRules/repository/kodyRules.repository';
import { KodyRuleDetectorCompilerService } from '@libs/ee/kodyRules/service/kody-rule-detector-compiler.service';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    KodyRulesModel,
    KodyRulesSchema,
} from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { LLM } from '@libs/llm/llm';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { resolveMongoTestGate } from '../mongo-test-uri';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
const runModel = LLM.run as jest.Mock;
const gate = resolveMongoTestGate('kodus_test_kodyrules', false);

(gate.shouldSkip ? describe.skip : describe)(
    'Kody Rule compile on save (real Mongo)',
    () => {
        const organizationId = randomUUID();
        const repositoryId = 'repo-1';
        let connection: Connection;
        let model: Model<KodyRulesModel>;
        let repository: KodyRulesRepository;
        let rules: KodyRulesService;
        let compiler: KodyRuleDetectorCompilerService;
        let cli: CliKodyRulesController;
        let compile: jest.SpiedFunction<
            KodyRuleDetectorCompilerService['compileAndSave']
        >;

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    serverSelectionTimeoutMS: 3000,
                })
                .asPromise();
            model = connection.model(KodyRulesModel.name, KodyRulesSchema);
            repository = new KodyRulesRepository(model, undefined);
            rules = new KodyRulesService(
                repository,
                new EventEmitter2(),
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
            );
            compiler = new KodyRuleDetectorCompilerService(
                { resolveTaskSlot: jest.fn() } as any,
                undefined,
                rules,
            );
            compile = jest.spyOn(compiler, 'compileAndSave');
            const save = new CreateOrUpdateKodyRulesUseCase(
                rules,
                undefined,
                undefined,
                undefined,
                { getCentralizedRepositoryIfEnabled: jest.fn() } as any,
                undefined,
                compiler,
                { kodyRuleChanged: jest.fn() } as any,
            );
            // Exercise direct saves with centralized routing and reference detection disabled.
            jest.spyOn(
                save as any,
                'createCentralizedMutationIfEnabled',
            ).mockResolvedValue(null);
            jest.spyOn(
                save as any,
                'detectAndSaveReferencesAsync',
            ).mockResolvedValue(undefined);
            cli = new CliKodyRulesController(
                {
                    validateKey: async () => ({
                        team: { uuid: 'team-1' },
                        organization: { uuid: organizationId },
                        config: {
                            capabilities: [
                                TEAM_CLI_KEY_CAPABILITIES.KODY_RULES_MANAGE,
                            ],
                        },
                    }),
                } as any,
                save,
                undefined,
            );
        }, 30_000);

        afterEach(async () => {
            await model?.deleteMany({ organizationId });
            runModel.mockReset();
        });

        afterAll(() => connection?.close());

        async function patch(uuid: string, fields: Partial<IKodyRule>) {
            compile.mockClear();
            await cli.updateKodyRule(
                { repositoryId, ...fields },
                uuid,
                'kodus_test',
            );
            // The compiler runs in the background. Wait for its writes before the next save.
            await Promise.all(compile.mock.results.map(({ value }) => value));
        }

        it('settles both compiler records after an edit and spends zero calls on ten unchanged saves', async () => {
            const ids = Array.from({ length: 10 }, () => randomUUID());
            await model.create({
                organizationId,
                rules: ids.map((uuid) => ({
                    uuid,
                    repositoryId,
                    rule: 'Old body',
                    title: 'Enrollment',
                    contextNeed: {
                        need: 'diff-only',
                        source: 'compiler',
                        sourceHash: 'old',
                    },
                    fileScope: {
                        extensions: ['.rb'],
                        source: 'compiler',
                        sourceHash: 'old',
                    },
                })),
            });
            const rule =
                'Check enrollment before recording a grade in TypeScript.';
            runModel.mockResolvedValue({
                mechanical: false,
                contextNeed: 'full-file',
                extensions: ['.ts', '.js'],
            });

            for (const id of ids) {
                await patch(id, { rule });
            }
            const editCalls = runModel.mock.calls.length;
            const edited = (
                await repository.findByOrganizationId(organizationId)
            ).rules;
            expect(editCalls).toBe(ids.length);
            for (const saved of edited) {
                expect(saved.compileAttempt).toStrictEqual({
                    outcome: 'declined',
                    declineReason: 'not-mechanical',
                    sourceHash: ruleCompileHash({ rule }),
                    model: 'system',
                    attemptedAt: expect.any(Date),
                });
                expect(saved.contextNeed).toStrictEqual({
                    need: 'full-file',
                    sourceHash: ruleContextNeedHash({ rule }),
                    source: 'compiler',
                    model: 'system',
                    inferredAt: expect.any(Date),
                });
                expect(saved.fileScope).toStrictEqual({
                    extensions: ['.ts', '.js'],
                    sourceHash: createHash('sha256').update(rule).digest('hex'),
                    source: 'compiler',
                    model: 'system',
                    inferredAt: expect.any(Date),
                });
            }

            runModel.mockClear();
            for (const id of ids) {
                await patch(id, { rule });
            }
            expect(runModel).not.toHaveBeenCalled();
            const reloaded = (
                await repository.findByOrganizationId(organizationId)
            ).rules;
            const records = ({
                uuid,
                compileAttempt,
                contextNeed,
                fileScope,
            }: Partial<IKodyRule>) => ({
                uuid,
                compileAttempt,
                contextNeed,
                fileScope,
            });
            expect(reloaded.map(records)).toEqual(edited.map(records));
        });

        it('preserves a context write that lands between the file scope read and write', async () => {
            const uuid = randomUUID();
            const rule = 'Check enrollment before recording a grade.';
            const contextNeed = {
                need: 'full-file',
                source: 'compiler',
                sourceHash: ruleContextNeedHash({ rule }),
                inferredAt: new Date(),
            } as const;
            const fileScope = {
                extensions: ['.ts'],
                source: 'compiler' as const,
                sourceHash: 'current',
                inferredAt: new Date(),
            };
            await model.create({
                organizationId,
                rules: [
                    {
                        uuid,
                        repositoryId,
                        rule,
                        contextNeed: {
                            ...contextNeed,
                            need: 'diff-only',
                            sourceHash: 'stale',
                        },
                    },
                ],
            });

            // The scope writer has already read the old need. Let the context
            // writer finish its real Mongo write before that scope write lands.
            const write = repository.updateRule.bind(repository);
            const interleaved = jest
                .spyOn(repository, 'updateRule')
                .mockImplementationOnce(async (...args) => {
                    await rules.updateRuleContextNeed(
                        organizationId,
                        uuid,
                        contextNeed,
                    );
                    return write(...args);
                });
            try {
                await rules.updateRuleFileScope(
                    organizationId,
                    uuid,
                    fileScope,
                );
            } finally {
                interleaved.mockRestore();
            }
            const saved = await repository.findById(uuid, organizationId);
            expect(saved.contextNeed).toEqual(contextNeed);
            expect(saved.fileScope).toEqual(fileScope);
        });

        it('disarms a detector on a cosmetic title edit and keeps ordinary renames free', async () => {
            const uuid = randomUUID();
            const rule = 'Use the logger instead of console.log.';
            const examples = [
                { snippet: 'console.log(x)', isCorrect: false },
                { snippet: 'logger.info(x)', isCorrect: true },
            ];
            await model.create({
                organizationId,
                rules: [
                    {
                        uuid,
                        repositoryId,
                        rule,
                        title: 'Use the logger',
                        examples,
                    },
                ],
            });
            runModel.mockResolvedValue({
                mechanical: true,
                pattern: 'console\\.log\\(',
            });
            await patch(uuid, { rule, examples });
            const compiled = await repository.findById(uuid, organizationId);
            expect(compiled.detector?.pattern).toBe('console\\.log\\(');
            runModel.mockClear();

            await patch(uuid, {
                title: 'Log messages containing single quotes',
                rule,
            });
            const renamed = await repository.findById(uuid, organizationId);
            expect(renamed.detector).toEqual(compiled.detector);
            expect(renamed.compileAttempt).toStrictEqual(
                compiled.compileAttempt,
            );
            await patch(uuid, { title: 'Semicolons' });
            const cosmetic = await repository.findById(uuid, organizationId);
            expect(cosmetic.detector).toBeNull();
            expect(cosmetic.compileAttempt).toStrictEqual({
                outcome: 'declined',
                declineReason: 'cosmetic',
                cosmeticSource: 'gate',
                sourceHash: ruleCompileHash({ rule, examples }),
                model: 'system',
                attemptedAt: expect.any(Date),
            });
            expect(runModel).not.toHaveBeenCalled();

            await patch(uuid, { title: 'Logger policy' });
            expect(runModel).toHaveBeenCalledTimes(1);
            expect(
                (await repository.findById(uuid, organizationId)).detector
                    ?.pattern,
            ).toBe(compiled.detector.pattern);

            // Older saves could leave an active regex under a cosmetic title.
            await repository.updateRuleFieldsByOrganization(
                organizationId,
                uuid,
                { title: 'Semicolons' },
            );
            runModel.mockClear();
            await patch(uuid, { rule });
            expect(
                (await repository.findById(uuid, organizationId)).detector,
            ).toBeNull();
            expect(runModel).not.toHaveBeenCalled();
        });

        it('classifies a cosmetic rename with missing context once and retries an empty response', async () => {
            const uuid = randomUUID();
            const rule = 'Check the policy against the full file.';
            await model.create({
                organizationId,
                rules: [{ uuid, repositoryId, title: 'Review policy', rule }],
            });
            runModel.mockResolvedValueOnce(null).mockResolvedValueOnce({
                mechanical: true,
                pattern: 'policy',
                contextNeed: 'full-file',
                extensions: ['.ts'],
            });

            await patch(uuid, { title: 'Semicolons' });
            const empty = await repository.findById(uuid, organizationId);
            expect(empty.contextNeed).toBeUndefined();
            expect(empty.compileAttempt).toBeNull();
            await patch(uuid, { rule });
            const classified = await repository.findById(uuid, organizationId);
            expect(classified.contextNeed).toEqual({
                need: 'full-file',
                source: 'compiler',
                sourceHash: ruleContextNeedHash({ rule }),
                inferredAt: expect.any(Date),
                model: 'system',
            });
            expect(classified.fileScope?.extensions).toEqual(['.ts']);
            expect(classified.detector).toBeUndefined();
            expect(classified.compileAttempt.declineReason).toBe('cosmetic');

            await patch(uuid, { rule });
            const repeated = await repository.findById(uuid, organizationId);
            expect(repeated.compileAttempt).toEqual(classified.compileAttempt);
            expect(repeated.contextNeed).toEqual(classified.contextNeed);
            expect(repeated.fileScope).toEqual(classified.fileScope);
            expect(runModel).toHaveBeenCalledTimes(2);
        });

        it('rechecks a legacy cosmetic decline once and reuses a model-confirmed decline', async () => {
            const uuid = randomUUID();
            const rule =
                'Use double quotes in all translation catalog entries.';
            const sourceHash = ruleCompileHash({ rule });
            await model.create({
                organizationId,
                rules: [
                    {
                        uuid,
                        repositoryId,
                        title: 'Translation catalog',
                        rule,
                        compileAttempt: {
                            outcome: 'declined',
                            declineReason: 'cosmetic',
                            sourceHash,
                        },
                        contextNeed: {
                            need: 'diff-only',
                            source: 'compiler',
                            sourceHash: ruleContextNeedHash({ rule }),
                        },
                    },
                ],
            });
            runModel.mockResolvedValue({
                mechanical: false,
                cosmetic: true,
                contextNeed: 'full-file',
            });
            await patch(uuid, { rule });
            const rechecked = await repository.findById(uuid, organizationId);
            expect(rechecked.compileAttempt.cosmeticSource).toBe('model');
            expect(rechecked.contextNeed.need).toBe('full-file');
            await patch(uuid, { rule });
            expect(
                (await repository.findById(uuid, organizationId))
                    .compileAttempt,
            ).toEqual(rechecked.compileAttempt);
            expect(runModel).toHaveBeenCalledTimes(1);
        });

        it('disarms a stored cosmetic detector when its context classification fails', async () => {
            const uuid = randomUUID();
            await model.create({
                organizationId,
                rules: [
                    {
                        uuid,
                        repositoryId,
                        title: 'Semicolons',
                        rule: 'Avoid unnecessary semicolons.',
                        detector: { type: 'regex', pattern: ';' },
                    },
                ],
            });
            runModel.mockRejectedValueOnce(new Error('provider unavailable'));
            const stored = await repository.findById(uuid, organizationId);
            const result = await compiler.compileAndSave(
                { organizationId },
                uuid,
                stored,
            );
            const reloaded = await repository.findById(uuid, organizationId);
            expect(result.declineReason).toBe('cosmetic');
            expect(reloaded.detector).toBeNull();
            expect(reloaded.contextNeed).toBeUndefined();
            expect(reloaded.compileAttempt).toBeUndefined();
        });

        it('preserves the detector and attempt when a CLI patch omits examples and recompiles an explicit clear', async () => {
            const uuid = randomUUID();
            const rule = 'Use the logger instead of console.log.';
            const examples = [
                { snippet: 'console.log(x)', isCorrect: false },
                { snippet: 'logger.info(x)', isCorrect: true },
            ];
            await model.create({
                organizationId,
                rules: [
                    {
                        uuid,
                        repositoryId,
                        title: 'Use the logger',
                        rule,
                        examples,
                        // A prior partial PATCH compiled with no examples.
                        detector: null,
                        contextNeed: {
                            source: 'compiler',
                            need: 'diff-only',
                            sourceHash: ruleContextNeedHash({ rule }),
                        },
                        compileAttempt: {
                            sourceHash: ruleCompileHash({ rule }),
                            outcome: 'declined',
                            declineReason: 'no-usable-examples',
                        },
                    },
                ],
            });
            runModel.mockResolvedValue({
                mechanical: true,
                pattern: 'console\\.log\\(',
            });
            await patch(uuid, { rule, examples });
            const compiled = await repository.findById(uuid, organizationId);
            expect(runModel).toHaveBeenCalledTimes(1);
            expect(compiled.detector?.pattern).toBe('console\\.log\\(');
            expect(compiled.compileAttempt.sourceHash).toBe(
                ruleCompileHash({ rule, examples }),
            );
            runModel.mockClear();

            await patch(uuid, { rule });
            const afterPatch = await repository.findById(uuid, organizationId);
            const patchCalls = runModel.mock.calls.length;
            runModel.mockClear();
            await patch(uuid, { rule, examples });
            expect({
                patchCalls,
                repeatCalls: runModel.mock.calls.length,
                detector: afterPatch.detector,
                compileAttempt: afterPatch.compileAttempt,
                examples: afterPatch.examples,
            }).toEqual({
                patchCalls: 0,
                repeatCalls: 0,
                detector: compiled.detector,
                compileAttempt: compiled.compileAttempt,
                examples,
            });

            await patch(uuid, { examples: [] });
            expect(runModel).toHaveBeenCalledTimes(1);
            const cleared = await repository.findById(uuid, organizationId);
            expect(cleared.examples).toEqual([]);
            expect(cleared.detector).toBeNull();
            expect(cleared.compileAttempt).toStrictEqual({
                outcome: 'declined',
                declineReason: 'no-usable-examples',
                sourceHash: ruleCompileHash({ rule, examples: [] }),
                model: 'system',
                attemptedAt: expect.any(Date),
            });
        });

        it('reuses a legacy attempt across CLI and web key orders until an example changes', async () => {
            const uuid = randomUUID();
            const rule = 'Check enrollment before recording a grade.';
            const cliExamples = [
                { isCorrect: false, snippet: 'recordGrade()' },
                { snippet: 'checkEnrollment()', isCorrect: true },
            ];
            const webExamples = cliExamples.map(({ snippet, isCorrect }) => ({
                snippet,
                isCorrect,
            }));
            const legacyHash = createHash('sha256')
                .update(`${rule} ${JSON.stringify(cliExamples)}`)
                .digest('hex');
            await model.create({
                organizationId,
                rules: [
                    {
                        uuid,
                        repositoryId,
                        title: 'Enrollment',
                        rule,
                        examples: cliExamples,
                        contextNeed: {
                            need: 'full-file',
                            source: 'compiler',
                            sourceHash: ruleContextNeedHash({ rule }),
                        },
                        compileAttempt: {
                            sourceHash: legacyHash,
                            outcome: 'declined',
                        },
                    },
                ],
            });
            runModel.mockResolvedValue({ mechanical: false });

            for (const examples of [
                cliExamples,
                webExamples,
                cliExamples,
                webExamples,
            ]) {
                await patch(uuid, { rule, examples });
            }
            expect(runModel).not.toHaveBeenCalled();

            await patch(uuid, {
                rule,
                examples: [
                    { ...webExamples[0], snippet: 'saveGrade()' },
                    webExamples[1],
                ],
            });
            expect(runModel).toHaveBeenCalledTimes(1);
        });
    },
);

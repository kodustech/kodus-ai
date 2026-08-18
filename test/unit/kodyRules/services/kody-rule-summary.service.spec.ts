import { createHash } from 'crypto';
import { KodyRuleSummaryService } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const loggerSpy = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => loggerSpy,
}));

const tracedGenerateTextMock = jest.fn();
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: (...args: unknown[]) => tracedGenerateTextMock(...args),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600_000,
}));

jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(() => ({})),
    buildModelFromSlot: jest.fn(() => ({})),
    getModelName: jest.fn(() => 'openai_compatible:test-model'),
}));

jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => undefined),
}));

// Structured calls (atom decomposition + per-atom detector compilation) are
// routed by runName so each test controls both stages independently.
const structuredCallMock = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (...args: unknown[]) =>
        structuredCallMock(...args),
}));

const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');

const LONG_TEXT = 'x'.repeat(1001);
const orgData = { organizationId: 'org-1', teamId: 'team-1' };

function createService(
    opts: {
        byokConfig?: object | null;
        subscriptionStatus?: SubscriptionStatus | string;
        repository?: Partial<{
            findByOrganizationId: jest.Mock;
            updateRule: jest.Mock;
        }>;
    } = {},
) {
    const permissionValidationService = {
        // v2-native: generateAtoms/summary ask the service for the codeReview
        // carrier (null → env/managed default).
        resolveTaskSlot: jest.fn().mockResolvedValue(null),
        getBYOKConfig: jest
            .fn()
            .mockResolvedValue(
                opts.byokConfig === undefined
                    ? { main: { model: 'm' } }
                    : opts.byokConfig,
            ),
        getSubscriptionStatus: jest
            .fn()
            .mockResolvedValue(
                opts.subscriptionStatus ?? SubscriptionStatus.TRIAL,
            ),
    };
    const repository = {
        findByOrganizationId: jest
            .fn()
            .mockResolvedValue({ uuid: 'doc-uuid' }),
        updateRule: jest.fn().mockResolvedValue({ uuid: 'doc-uuid' }),
        ...opts.repository,
    };
    // Pass-through observability stub: exec() runs, usage span is a no-op.
    // The "records the usage span" test asserts runAiSdkLLMInSpan was used.
    const observabilityService = {
        runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
    };
    const service = new KodyRuleSummaryService(
        permissionValidationService as any,
        repository as any,
        observabilityService as any,
    );
    return {
        service,
        permissionValidationService,
        repository,
        observabilityService,
    };
}

const validSummaryText =
    'WHAT TO VALIDATE:\n- condition\n\nHOW TO VALIDATE:\n- signal';

describe('KodyRuleSummaryService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tracedGenerateTextMock.mockResolvedValue({ text: validSummaryText });
        // default: decomposition yields 2 atoms; compiler declines both
        structuredCallMock.mockImplementation(async ({ runName }: any) => {
            if (runName === 'kody-rules.atom-decomposition') {
                return {
                    atoms: [
                        {
                            title: 'No .call(...) forward syntax',
                            spec: 'WHAT: forward syntax\nHOW: def self.call(...)',
                            examples: [
                                { snippet: 'def self.call(...)', isCorrect: false },
                                { snippet: 'def self.call(a:)', isCorrect: true },
                            ],
                        },
                        {
                            title: 'errors: must be a string array',
                            spec: 'WHAT: raw errors object\nHOW: Failure.new(errors: x.errors)',
                        },
                    ],
                };
            }
            // atom detector compiler: decline by default
            return { mechanical: false, reason: 'semantic' };
        });
    });

    describe('isLong', () => {
        it('treats exactly 1000 chars as short and 1001 as long', () => {
            const { service } = createService();

            expect(service.isLong('x'.repeat(1000))).toBe(false);
            expect(service.isLong('x'.repeat(1001))).toBe(true);
            expect(service.isLong(undefined)).toBe(false);
        });
    });

    describe('resolveForReview', () => {
        it('swaps a long rule for its summary when the sourceHash matches', () => {
            const { service } = createService();
            const rule: Partial<IKodyRule> = {
                uuid: 'r1',
                rule: LONG_TEXT,
                summary: {
                    content: validSummaryText,
                    sourceHash: sha256(LONG_TEXT),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };

            const resolved = service.resolveForReview(rule);

            expect(resolved.rule).toBe(validSummaryText);
            // original never mutated — other consumers see the full text
            expect(rule.rule).toBe(LONG_TEXT);
        });

        it('returns the original and logs when the sourceHash does not match', () => {
            const { service } = createService();
            const rule: Partial<IKodyRule> = {
                uuid: 'r1',
                rule: LONG_TEXT,
                summary: {
                    content: validSummaryText,
                    sourceHash: sha256('some other text'),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };

            const resolved = service.resolveForReview(rule);

            expect(resolved.rule).toBe(LONG_TEXT);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('stale summary'),
                }),
            );
        });

        it('leaves short rules untouched even when a summary exists', () => {
            const { service } = createService();
            const shortText = 'short rule';
            const rule: Partial<IKodyRule> = {
                uuid: 'r1',
                rule: shortText,
                summary: {
                    content: 'stale content from a former long version',
                    sourceHash: sha256(shortText),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };

            const resolved = service.resolveForReview(rule);

            expect(resolved.rule).toBe(shortText);
        });
    });

    describe('generate', () => {
        it('returns a summary with the sourceHash of the exact rule text', async () => {
            const { service } = createService();

            const summary = await service.generate(
                { uuid: 'r1', title: 't', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).not.toBeNull();
            expect(summary!.content).toBe(validSummaryText);
            expect(summary!.sourceHash).toBe(sha256(LONG_TEXT));
            expect(summary!.model).toBe('openai_compatible:test-model');
        });

        it('returns null for short rules without calling the LLM', async () => {
            const { service } = createService();

            const summary = await service.generate(
                { uuid: 'r1', rule: 'short' },
                orgData,
            );

            expect(summary).toBeNull();
            expect(tracedGenerateTextMock).not.toHaveBeenCalled();
        });

        it('skips generation post-trial without BYOK', async () => {
            const { service } = createService({
                byokConfig: null,
                subscriptionStatus: SubscriptionStatus.EXPIRED,
            });

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).toBeNull();
            expect(tracedGenerateTextMock).not.toHaveBeenCalled();
        });

        it('generates on the managed default during trial without BYOK', async () => {
            const { service } = createService({
                byokConfig: null,
                subscriptionStatus: SubscriptionStatus.TRIAL,
            });

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).not.toBeNull();
            expect(tracedGenerateTextMock).toHaveBeenCalled();
        });

        it('discards output missing the required sections', async () => {
            const { service } = createService();
            tracedGenerateTextMock.mockResolvedValue({
                text: 'some prose that is not the expected spec',
            });

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).toBeNull();
        });

        it('returns null instead of throwing when the LLM call fails', async () => {
            const { service } = createService();
            tracedGenerateTextMock.mockRejectedValue(new Error('boom'));

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).toBeNull();
        });

        it('does not set a temperature (some BYOK models reject 0)', async () => {
            const { service } = createService();

            await service.generate({ uuid: 'r1', rule: LONG_TEXT }, orgData);

            const callArgs = tracedGenerateTextMock.mock.calls[0][0];
            expect(callArgs).not.toHaveProperty('temperature');
        });

        it('records the LLM call through the usage span (BYOK token accounting)', async () => {
            // Generation may burn the customer's BYOK key: the call MUST go
            // through runAiSdkLLMInSpan so tokens reach the usage analytics.
            const { service, observabilityService } = createService();

            await service.generate(
                { uuid: 'r1', title: 't', rule: LONG_TEXT },
                orgData,
            );

            expect(
                observabilityService.runAiSdkLLMInSpan,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    runName: 'kody-rules.summary-generation',
                    model: 'openai_compatible:test-model',
                    attrs: expect.objectContaining({
                        organizationId: orgData.organizationId,
                    }),
                }),
            );
        });
    });

    describe('ensureSummaries', () => {
        it('generates and persists only for long rules lacking a valid summary', async () => {
            const { service, repository } = createService();
            const alreadySummarized: Partial<IKodyRule> = {
                uuid: 'ok',
                rule: LONG_TEXT,
                summary: {
                    content: validSummaryText,
                    sourceHash: sha256(LONG_TEXT),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };
            const shortRule: Partial<IKodyRule> = { uuid: 's', rule: 'short' };
            const pendingRule: Partial<IKodyRule> = {
                uuid: 'p',
                rule: LONG_TEXT,
            };

            const result = await service.ensureSummaries(
                [alreadySummarized, shortRule, pendingRule],
                orgData,
            );

            expect(tracedGenerateTextMock).toHaveBeenCalledTimes(1);
            expect(repository.updateRule).toHaveBeenCalledWith(
                'doc-uuid',
                'p',
                expect.objectContaining({
                    summary: expect.objectContaining({
                        sourceHash: sha256(LONG_TEXT),
                    }),
                }),
            );
            const updated = result.find((r) => r.uuid === 'p');
            expect(updated?.summary?.content).toBe(validSummaryText);
        });

        it('still returns the in-memory summary when persistence fails', async () => {
            const { service } = createService({
                repository: {
                    updateRule: jest
                        .fn()
                        .mockRejectedValue(new Error('mongo down')),
                },
            });

            const result = await service.ensureSummaries(
                [{ uuid: 'p', rule: LONG_TEXT }],
                orgData,
            );

            expect(result[0].summary?.content).toBe(validSummaryText);
        });

        it('returns rules untouched when generation fails', async () => {
            const { service, repository } = createService();
            tracedGenerateTextMock.mockRejectedValue(new Error('llm down'));
            const rule: Partial<IKodyRule> = { uuid: 'p', rule: LONG_TEXT };

            const result = await service.ensureSummaries([rule], orgData);

            expect(result[0].summary).toBeUndefined();
            expect(repository.updateRule).not.toHaveBeenCalled();
        });
    });

    describe('atoms (virtual decomposition)', () => {
        it('decomposes a long rule into atoms carrying stable ids and the atoms hash', async () => {
            const { service } = createService();

            const atoms = await service.generateAtoms(
                { uuid: 'r1', title: 't', rule: LONG_TEXT, examples: [] },
                orgData,
            );

            expect(atoms).not.toBeNull();
            expect(atoms!.items).toHaveLength(2);
            expect(atoms!.items[0].id).toBe('r1-atom-1');
            expect(atoms!.sourceHash).toBe(
                service.atomsHashOf({ rule: LONG_TEXT, examples: [] }),
            );
        });

        it('attaches a detector when the atom compiler returns a mechanical pattern', async () => {
            const { service } = createService();
            structuredCallMock.mockImplementation(async ({ runName }: any) => {
                if (runName === 'kody-rules.atom-decomposition') {
                    return {
                        atoms: [
                            { title: 'a', spec: 's', examples: [
                                { snippet: 'def self.call(...)', isCorrect: false },
                                { snippet: 'def self.call(a:)', isCorrect: true },
                            ] },
                        ],
                    };
                }
                return {
                    mechanical: true,
                    pattern: 'def\\s+self\\.call\\(\\.\\.\\.\\)',
                    reason: 'mechanical',
                };
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(atoms!.items[0].detector?.pattern).toBeTruthy();
        });

        it('atoms hash covers examples — an examples edit invalidates', () => {
            const { service } = createService();
            const base = { rule: LONG_TEXT, examples: [{ snippet: 'a', isCorrect: false }] };

            const h1 = service.atomsHashOf(base);
            const h2 = service.atomsHashOf({ ...base, examples: [{ snippet: 'b', isCorrect: false }] });

            expect(h1).not.toBe(h2);
        });

        it('expandForReview maps atoms to rules carrying the PARENT uuid and only the atom detector', () => {
            const { service } = createService();
            const parent: any = {
                uuid: 'parent-1', title: 'Big rule', rule: LONG_TEXT,
                severity: 'high', path: 'app/**', scope: 'file',
                detector: { type: 'regex', pattern: 'PARENT' },
                examples: [],
            };
            parent.atoms = {
                items: [
                    { id: 'parent-1-atom-1', title: 'atom A', spec: 'WHAT: a', detector: { type: 'regex', pattern: 'ATOM' } },
                    { id: 'parent-1-atom-2', title: 'atom B', spec: 'WHAT: b' },
                ],
                sourceHash: service.atomsHashOf(parent),
                generatedAt: new Date(), model: 'm',
            };

            const units = service.expandForReview(parent);

            expect(units).toHaveLength(2);
            expect(units.every((u) => u.uuid === 'parent-1')).toBe(true);
            expect(units[0].detector?.pattern).toBe('ATOM');
            expect(units[1].detector).toBeUndefined();
            expect(units.every((u) => u.severity === 'high' && u.path === 'app/**')).toBe(true);
        });

        it('expandForReview falls back to summary/full text on stale atoms hash', () => {
            const { service } = createService();
            const parent: any = {
                uuid: 'p', rule: LONG_TEXT,
                atoms: { items: [{ id: 'x', title: 'a', spec: 's' }], sourceHash: 'stale', generatedAt: new Date(), model: 'm' },
            };

            const units = service.expandForReview(parent);

            expect(units).toHaveLength(1);
            expect(units[0].rule).toBe(LONG_TEXT);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('stale atoms') }),
            );
        });

        it('caps atom generation per review and defers the rest (backfill budget)', async () => {
            const { service, repository } = createService();
            const rules = Array.from({ length: 8 }, (_, i) => ({
                uuid: `r${i}`,
                rule: LONG_TEXT,
            }));

            const out = await service.ensureAtoms(rules, orgData);

            // 5 decomposed (persisted), 3 deferred untouched
            expect(repository.updateRule).toHaveBeenCalledTimes(5);
            expect(out.filter((r) => r.atoms).length).toBe(5);
            expect(loggerSpy.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('backfill budget'),
                }),
            );
        });

        it('ensureAtoms persists the decomposition on the rule doc', async () => {
            const { service, repository } = createService();

            await service.ensureAtoms([{ uuid: 'p', rule: LONG_TEXT }], orgData);

            expect(repository.updateRule).toHaveBeenCalledWith(
                'doc-uuid', 'p',
                expect.objectContaining({ atoms: expect.objectContaining({ items: expect.any(Array) }) }),
            );
        });

        it('prepareForReview expands long rules and leaves short rules intact', async () => {
            const { service } = createService();
            const shortRule = { uuid: 's', rule: 'short rule' };

            const out = await service.prepareForReview(
                [shortRule, { uuid: 'p', rule: LONG_TEXT }],
                orgData,
            );

            // short passes through; long became its 2 atoms
            expect(out).toHaveLength(3);
            expect(out[0]).toEqual(shortRule);
            expect(out.filter((r) => r.uuid === 'p')).toHaveLength(2);
        });

        it('decomposition failure falls back to the summary path (never blocks)', async () => {
            const { service } = createService();
            structuredCallMock.mockRejectedValue(new Error('llm down'));

            const out = await service.prepareForReview(
                [{ uuid: 'p', rule: LONG_TEXT }],
                orgData,
            );

            expect(out).toHaveLength(1);
            expect(out[0].rule).toBe(LONG_TEXT);
        });
    });

    describe('atom verification (polarity, fidelity, coverage)', () => {
        // Both atoms decomposed here carry examples, so both are eligible
        // for the verify call regardless of which index the test flags.
        function mockDecompositionWithTwoAtoms() {
            structuredCallMock.mockImplementation(async ({ runName }: any) => {
                if (runName === 'kody-rules.atom-decomposition') {
                    return {
                        atoms: [
                            {
                                title: 'Declaration is direct (not via a mixin)',
                                spec: 'WHAT: direct typography declaration\nHOW: property: value in the diff',
                                examples: [
                                    {
                                        snippet: ".title { font-family: 'Roboto'; }",
                                        isCorrect: true,
                                    },
                                    {
                                        snippet:
                                            ".title { @include font-family('Roboto'); }",
                                        isCorrect: false,
                                    },
                                ],
                            },
                            {
                                title: 'Property is font-family/size/weight',
                                spec: 'WHAT: property name\nHOW: matches one of the three',
                                examples: [
                                    {
                                        snippet: '.text { font-size: 14px; }',
                                        isCorrect: true,
                                    },
                                    {
                                        snippet: '.text { line-height: 1.5; }',
                                        isCorrect: false,
                                    },
                                ],
                            },
                        ],
                    };
                }
                return { mechanical: false, reason: 'semantic' };
            });
        }

        it('drops an atom the verify pass flags as inverted, keeps the rest', async () => {
            const { service } = createService();
            mockDecompositionWithTwoAtoms();
            const decompose = structuredCallMock.getMockImplementation()!;
            structuredCallMock.mockImplementation(async (args: any) => {
                if (args.runName === 'kody-rules.atom-verify') {
                    return {
                        invalidAtoms: [
                            { index: 0, reason: 'inverted polarity' },
                        ],
                    };
                }
                return decompose(args);
            });

            const atoms = await service.generateAtoms(
                {
                    uuid: 'r1',
                    title: 'Avoid direct typography properties in styles',
                    rule: LONG_TEXT,
                },
                orgData,
            );

            expect(atoms).not.toBeNull();
            expect(atoms!.items).toHaveLength(1);
            expect(atoms!.items[0].title).toBe(
                'Property is font-family/size/weight',
            );
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('dropped 1/2 atom(s)'),
                }),
            );
        });

        it('drops an atom flagged as invented (not present in the original rule)', async () => {
            const { service } = createService();
            mockDecompositionWithTwoAtoms();
            const decompose = structuredCallMock.getMockImplementation()!;
            structuredCallMock.mockImplementation(async (args: any) => {
                if (args.runName === 'kody-rules.atom-verify') {
                    return {
                        invalidAtoms: [
                            { index: 1, reason: 'not in original rule' },
                        ],
                    };
                }
                return decompose(args);
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(atoms!.items).toHaveLength(1);
            expect(atoms!.items[0].title).toBe(
                'Declaration is direct (not via a mixin)',
            );
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('dropped 1/2 atom(s)'),
                    metadata: expect.objectContaining({
                        dropped: [
                            expect.objectContaining({
                                reason: 'not in original rule',
                            }),
                        ],
                    }),
                }),
            );
        });

        it('logs missing coverage without dropping any atom or blocking generation', async () => {
            const { service } = createService();
            mockDecompositionWithTwoAtoms();
            const decompose = structuredCallMock.getMockImplementation()!;
            structuredCallMock.mockImplementation(async (args: any) => {
                if (args.runName === 'kody-rules.atom-verify') {
                    return {
                        invalidAtoms: [],
                        missingRequirements: [
                            'icon-vs-text scoping is never checked',
                        ],
                    };
                }
                return decompose(args);
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(atoms!.items).toHaveLength(2);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'missing coverage for 1 requirement(s)',
                    ),
                }),
            );
        });

        it('falls back to summary/full text when every atom fails verification', async () => {
            const { service } = createService();
            structuredCallMock.mockImplementation(async ({ runName }: any) => {
                if (runName === 'kody-rules.atom-decomposition') {
                    return {
                        atoms: [
                            {
                                title: 'Declaration is direct',
                                spec: 'WHAT: x\nHOW: y',
                                examples: [
                                    { snippet: 'a', isCorrect: true },
                                    { snippet: 'b', isCorrect: false },
                                ],
                            },
                        ],
                    };
                }
                if (runName === 'kody-rules.atom-verify') {
                    return { invalidAtoms: [{ index: 0, reason: 'inverted polarity' }] };
                }
                return { mechanical: false, reason: 'semantic' };
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(atoms).toBeNull();
        });

        it('ships atoms unverified when the verify call itself fails', async () => {
            const { service } = createService();
            mockDecompositionWithTwoAtoms();
            const originalImpl = structuredCallMock.getMockImplementation();
            structuredCallMock.mockImplementation(async (args: any) => {
                if (args.runName === 'kody-rules.atom-verify') {
                    throw new Error('verify call down');
                }
                return originalImpl!(args);
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(atoms).not.toBeNull();
            expect(atoms!.items).toHaveLength(2);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('verification failed'),
                }),
            );
        });

        it('still calls the verify pass when no atom has examples, so coverage gaps are caught', async () => {
            // An all-semantic decomposition (no atom carries examples) must
            // still get its coverage checked — restricting the call to
            // example-bearing atoms would make a coverage gap silently read
            // as "fully enforced" just because nothing had examples.
            const { service } = createService();
            structuredCallMock.mockImplementation(async ({ runName }: any) => {
                if (runName === 'kody-rules.atom-decomposition') {
                    return {
                        atoms: [{ title: 'no examples here', spec: 'WHAT: x\nHOW: y' }],
                    };
                }
                if (runName === 'kody-rules.atom-verify') {
                    return {
                        invalidAtoms: [],
                        missingRequirements: ['icon-vs-text scoping is never checked'],
                    };
                }
                return { mechanical: false, reason: 'semantic' };
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(structuredCallMock).toHaveBeenCalledWith(
                expect.objectContaining({ runName: 'kody-rules.atom-verify' }),
            );
            expect(atoms!.items).toHaveLength(1);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'missing coverage for 1 requirement(s)',
                    ),
                }),
            );
        });

        it('ignores a returned index outside the atoms actually sent for verification', async () => {
            const { service } = createService();
            mockDecompositionWithTwoAtoms();
            const decompose = structuredCallMock.getMockImplementation()!;
            structuredCallMock.mockImplementation(async (args: any) => {
                if (args.runName === 'kody-rules.atom-verify') {
                    // Hallucinated: only 2 atoms exist (indexes 0-1), but
                    // the model answers with an out-of-bounds index.
                    return {
                        invalidAtoms: [
                            { index: 5, reason: 'inverted polarity' },
                        ],
                    };
                }
                return decompose(args);
            });

            const atoms = await service.generateAtoms(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            // Nothing gets dropped on a hallucinated index — safer than
            // risking a drop that doesn't correspond to what the model
            // actually judged.
            expect(atoms!.items).toHaveLength(2);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'outside the atoms it was sent',
                    ),
                    metadata: expect.objectContaining({ outOfRange: [5] }),
                }),
            );
        });
    });
});

import { ScanBudgetMeter } from '../domain/budget-meter';
import type { SurfaceMap } from '../domain/surface/surface.types';
import { reportUsage } from '@libs/llm/usage-meter';

import { SecurityScanEngine } from './security-scan-engine';

const RATES = {
    input: { default: 1e-6 },
    output: { default: 1e-6 },
    cacheRead: { default: 1e-7 },
    cacheWrite: { default: 1e-6 },
};

const FILES: Record<string, string> = {
    'src/orders/orders.controller.ts': `@Controller('orders')
export class OrdersController {
    constructor(private readonly orders: OrdersService) {}

    @Get(':id')
    async findOne(@Param('id') id: string) {
        return this.orders.repo.findOne({ where: { id } });
    }
}`,
    'src/orders/orders.service.ts': 'export class OrdersService {}',
    'src/admin/exec.ts': `export function run(req) {
    return exec('ls ' + req.query.dir);
}`,
    'src/util/date.ts': 'export const now = () => new Date();',
};

const SURFACE: SurfaceMap = {
    languages: ['typescript'],
    hits: [
        {
            file: 'src/orders/orders.controller.ts',
            line: 5,
            text: "@Get(':id')",
            patternId: 'ts.nest.route',
            role: 'entry_point',
            language: 'typescript',
            framework: 'nestjs',
        },
        {
            file: 'src/admin/exec.ts',
            line: 2,
            text: "return exec('ls ' + req.query.dir);",
            patternId: 'ts.exec',
            role: 'sink',
            language: 'typescript',
            vulnClass: 'injection',
            cwe: 'CWE-78',
        },
    ],
    files: {
        'src/orders/orders.controller.ts': {
            entryPoints: 1,
            authChecks: 0,
            sinks: 0,
            classes: [],
        },
        'src/admin/exec.ts': {
            entryPoints: 0,
            authChecks: 0,
            sinks: 1,
            classes: ['injection'],
        },
    },
    errors: [],
};

function fakeSandbox(type: 'e2b' | 'local' = 'e2b') {
    const written: Record<string, string> = {};
    return {
        type,
        repoDir: '/repo',
        sandboxId: 'sbx',
        written,
        remoteCommands: {
            grep: jest.fn(async () => 'No matches found.'),
            read: jest.fn(async (path: string) => {
                if (FILES[path] === undefined) {
                    throw new Error('No such file');
                }
                return FILES[path];
            }),
            listDir: jest.fn(async () => ''),
            exec: jest.fn(async () => ({
                stdout: '',
                stderr: '',
                exitCode: 0,
            })),
        },
        run: jest.fn(async (command: string) => {
            if (command.includes('ls-files')) {
                return { stdout: Object.keys(FILES).join('\n'), exitCode: 0 };
            }
            if (command.includes('npx jest')) {
                return { stdout: 'PASS', exitCode: 0 };
            }
            return { stdout: '', exitCode: 0 };
        }),
        writeFile: jest.fn(async (path: string, content: string) => {
            written[path] = content;
        }),
        readFile: jest.fn(),
        cleanup: jest.fn(),
    } as any;
}

/** A lens that reports what the test tells it to, and spends $0.10 per run. */
function fakeLens(findingsFor: (file: string, cls: string) => any[]) {
    return jest.fn(async (input: any, _secrets: any) => {
        reportUsage({ inputTokens: 90_000, outputTokens: 10_000 } as any, {
            runName: input.usageRunName,
        });
        const file = /Start from this file:\n(.+)\n/.exec(input.userPrompt)[1];
        const cls = input.agentName.replace('security-scan-', '');
        return {
            findings: { reasoning: '', suggestions: findingsFor(file, cls) },
            finishReason: 'stop',
        } as any;
    });
}

const FINALIZED_CWE: Record<string, string> = {
    authz: 'CWE 639',
    injection: 'CWE 89',
    ssrf: 'CWE 918',
    data_exposure: 'CWE 200',
    secret_identity: 'CWE 798',
    misconfiguration: 'CWE 16',
};

function fakeLlm(plan?: any) {
    return jest.fn(async (req: any) => {
        reportUsage({ inputTokens: 1000, outputTokens: 100 } as any, {
            runName: req.runName,
        });
        if (req.runName.endsWith('-map')) {
            if (plan instanceof Error) throw plan;
            return plan;
        }
        if (req.runName.endsWith('-finalize')) {
            // Each lens's weakness gets its own CWE, as a real model gives.
            const cls = /Vulnerability class: (\w+)/.exec(req.user)?.[1] ?? 'authz';
            return {
                title: 'Any user reads any order',
                severity: 'high',
                cwe: FINALIZED_CWE[cls] ?? 'CWE 639',
                attackPath: [
                    {
                        file: 'src/orders/orders.controller.ts',
                        line: 5,
                        note: 'id from the path',
                    },
                ],
                fix: 'Scope the query by the caller.',
            };
        }
        if (req.runName.endsWith('-repro')) {
            return {
                path: 'src/orders/idor.repro.spec.ts',
                content: 'test("idor", () => {})',
                command: 'npx jest src/orders/idor.repro.spec.ts',
            };
        }
        throw new Error(`unexpected ${req.runName}`);
    }) as any;
}

const IDOR = {
    label: 'security',
    relevantFile: 'src/orders/orders.controller.ts',
    relevantLinesStart: 7,
    relevantLinesEnd: 7,
    suggestionContent:
        'Entry: src/orders/orders.controller.ts:5\nThe id from the path loads any order with no owner check.',
};

const baseParams = (overrides: Record<string, unknown> = {}) => ({
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    repositoryFullName: 'acme/shop',
    model: { modelName: 'fireworks:deepseek' },
    maxUnits: 10,
    reproduce: false,
    ...overrides,
});

describe('SecurityScanEngine', () => {
    it('maps the repository, audits each unit per class and returns structured findings', async () => {
        const runLens = fakeLens((file, cls) =>
            file.endsWith('orders.controller.ts') && cls === 'authz'
                ? [IDOR]
                : [],
        );
        const llm = fakeLlm({
            units: [
                {
                    file: 'src/orders/orders.controller.ts',
                    relatedFiles: [
                        'src/orders/orders.service.ts',
                        'src/invented.ts',
                    ],
                    classes: ['authz'],
                    priority: 90,
                    reason: 'loads orders by id',
                },
                {
                    file: 'src/admin/exec.ts',
                    relatedFiles: [],
                    classes: ['injection'],
                    priority: 80,
                    reason: 'shell',
                },
            ],
        });
        const engine = new SecurityScanEngine({
            runLens,
            llm,
            collectSurface: jest.fn(async () => SURFACE),
        });
        const meter = new ScanBudgetMeter({ maxUsd: 100 }, RATES);

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter,
        } as any);

        expect(result.finished).toBe(true);
        expect(result.units.map((u) => u.file)).toEqual([
            'src/orders/orders.controller.ts',
            'src/admin/exec.ts',
        ]);
        expect(result.units[0].relatedFiles).toEqual([
            'src/orders/orders.service.ts',
        ]);
        // The controller holds a route: its unit runs injection and
        // misconfiguration besides the authz the plan asked for.
        expect(runLens).toHaveBeenCalledTimes(4);
        expect(result.findings).toEqual([
            expect.objectContaining({
                vulnerabilityClass: 'authz',
                title: 'Any user reads any order',
                severity: 'high',
                cwe: 'CWE-639',
                filePath: 'src/orders/orders.controller.ts',
                startLine: 7,
                symbol: 'OrdersController.findOne',
            }),
        ]);
        expect(result.examinedFiles.sort()).toEqual([
            'src/admin/exec.ts',
            'src/orders/orders.controller.ts',
            'src/orders/orders.service.ts',
        ]);
        // Every model request inside the scan was metered.
        // Four lenses, the map and one finalize.
        expect(meter.snapshot().requests).toBe(4 + 1 + 1);
    });

    it('gives each lens the scan prompt, the sandbox tools and no diff', async () => {
        const runLens = fakeLens(() => []);
        const sandbox = fakeSandbox();
        const engine = new SecurityScanEngine({
            runLens,
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
        });

        await engine.run({
            ...baseParams(),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        const [input, secrets] = runLens.mock.calls[0];
        expect(input.changedFiles).toBeUndefined();
        expect(input.allowedLabels).toEqual(['security']);
        expect(input.skipHeavyPasses).toBe(true);
        // Its verify drops a finding that crosses no security boundary.
        expect(input.laneFocus).toMatch(/crosses a security boundary/);
        expect(input.systemPrompt).toMatch(/not reviewing a pull request/);
        expect(secrets.remoteCommands).toBe(sandbox.remoteCommands);
    });

    it('falls back to the pattern ranking when the planner fails', async () => {
        const engine = new SecurityScanEngine({
            runLens: fakeLens(() => []),
            llm: fakeLlm(new Error('provider down')),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        // The file with both an entry point… no: the sink scores above an
        // entry point alone.
        expect(result.units.map((u) => u.file)).toEqual([
            'src/admin/exec.ts',
            'src/orders/orders.controller.ts',
        ]);
        expect(result.finished).toBe(true);
    });

    it('stops at the spend cap and leaves the rest unexamined', async () => {
        const runLens = fakeLens(() => []);
        const engine = new SecurityScanEngine({
            runLens,
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
        });
        // Each lens run costs $0.10; with the reserve the cap is hit after one.
        const meter = new ScanBudgetMeter({ maxUsd: 0.2 }, RATES);

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter,
        } as any);

        expect(result.stoppedByBudget).toBe(true);
        expect(result.finished).toBe(false);
        expect(result.progress.map((p) => p.state)).toEqual([
            'skipped_budget',
            'skipped_budget',
        ]);
        expect(result.examinedFiles).toEqual([]);
        expect(meter.snapshot().usd).toBeLessThanOrEqual(0.2);
    });

    it('resumes a plan and skips the units already done', async () => {
        const runLens = fakeLens(() => []);
        const collect = jest.fn(async () => SURFACE);
        const llm = fakeLlm();
        const engine = new SecurityScanEngine({
            runLens,
            llm,
            collectSurface: collect,
        });
        const units = [
            {
                id: 'a',
                file: 'src/admin/exec.ts',
                relatedFiles: [],
                language: 'typescript',
                classes: ['injection'],
                priority: 90,
                reasons: [],
            },
            {
                id: 'b',
                file: 'src/orders/orders.controller.ts',
                relatedFiles: [],
                language: 'typescript',
                classes: ['authz'],
                priority: 80,
                reasons: [],
            },
        ];

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            units,
            progress: [{ unitId: 'a', state: 'done', findings: 0 }],
        } as any);

        // The plan is reused, not mapped again…
        expect(
            llm.mock.calls.some(([req]: any[]) => req.runName.endsWith('-map')),
        ).toBe(false);
        expect(runLens).toHaveBeenCalledTimes(1);
        // …but the lens still gets the pattern scan's leads for its files.
        expect(collect).toHaveBeenCalledTimes(1);
        expect(runLens.mock.calls[0][0].userPrompt).toContain(
            "src/orders/orders.controller.ts:5 [entry_point, nestjs] @Get(':id')",
        );
        expect(result.finished).toBe(true);
    });

    it('stops starting units at the deadline so a new sandbox can continue', async () => {
        let now = 0;
        const runLens = jest.fn(async () => {
            now += 60_000;
            return {
                findings: { suggestions: [] },
                finishReason: 'stop',
            } as any;
        });
        const engine = new SecurityScanEngine({
            runLens,
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
            now: () => now,
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            deadlineAt: 30_000,
        } as any);

        expect(runLens).toHaveBeenCalledTimes(1);
        expect(result.finished).toBe(false);
        expect(result.stoppedByBudget).toBe(false);
        expect(result.progress.map((p) => p.state)).toEqual([
            'done',
            'pending',
        ]);
    });

    it('runs the reproduction test in an isolated sandbox', async () => {
        const sandbox = fakeSandbox('e2b');
        const engine = new SecurityScanEngine({
            runLens: fakeLens((file, cls) =>
                file.endsWith('orders.controller.ts') && cls === 'authz'
                    ? [IDOR]
                    : [],
            ),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams({ reproduce: true }),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(
            sandbox.written['/repo/src/orders/idor.repro.spec.ts'],
        ).toBeDefined();
        expect(result.findings[0].reproduction).toEqual(
            expect.objectContaining({
                executed: true,
                exitCode: 0,
                reproduced: true,
                command: 'npx jest src/orders/idor.repro.spec.ts',
            }),
        );
    });

    it('writes the reproduction test but never runs it outside an isolated sandbox', async () => {
        const sandbox = fakeSandbox('local');
        const engine = new SecurityScanEngine({
            runLens: fakeLens((file, cls) =>
                file.endsWith('orders.controller.ts') && cls === 'authz'
                    ? [IDOR]
                    : [],
            ),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams({ reproduce: true }),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(sandbox.writeFile).not.toHaveBeenCalled();
        expect(
            sandbox.run.mock.calls.some(([c]: [string]) => c.includes('jest')),
        ).toBe(false);
        expect(result.findings[0].reproduction).toEqual(
            expect.objectContaining({ executed: false }),
        );
    });

    it('keeps one finding for an operation two lenses or two units report', async () => {
        const engine = new SecurityScanEngine({
            // Both units' lenses, every class, report the same line.
            runLens: fakeLens(() => [IDOR, { ...IDOR, relevantLinesStart: 6 }]),
            llm: fakeLlm({
                units: [
                    {
                        file: 'src/orders/orders.controller.ts',
                        relatedFiles: [],
                        classes: ['authz', 'data_exposure'],
                        priority: 90,
                        reason: '',
                    },
                    {
                        file: 'src/admin/exec.ts',
                        relatedFiles: [],
                        classes: ['injection'],
                        priority: 80,
                        reason: '',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(
            result.findings.filter((f) =>
                f.filePath.endsWith('orders.controller.ts'),
            ),
        ).toHaveLength(1);
    });

    it("runs the review's dedup on each unit against what earlier units reported", async () => {
        // The controller's IDOR and the service's leak of the same order: two
        // weaknesses, so it is the review's dedup, not the overlap check,
        // that sees them together and keeps one.
        const runLens = fakeLens((file, cls) =>
            file.endsWith('orders.controller.ts')
                ? cls === 'authz'
                    ? [IDOR]
                    : []
                : cls !== 'data_exposure'
                  ? []
                : [
                      {
                          ...IDOR,
                          relevantFile: 'src/orders/orders.service.ts',
                          relevantLinesStart: 1,
                          relevantLinesEnd: 1,
                      },
                  ],
        );
        const dedup = jest.fn(async (_deps: any, suggestions: any[]) => ({
            // Keeps the first: the service finding is the controller's bug.
            suggestions: suggestions.slice(0, 1),
            trace: {} as any,
        }));
        const engine = new SecurityScanEngine({
            runLens,
            llm: fakeLlm({
                units: [
                    {
                        file: 'src/orders/orders.controller.ts',
                        relatedFiles: [],
                        classes: ['authz'],
                        priority: 90,
                        reason: '',
                    },
                    {
                        file: 'src/orders/orders.service.ts',
                        relatedFiles: [],
                        classes: ['data_exposure'],
                        priority: 80,
                        reason: '',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
            dedup: dedup as any,
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(
            result.findings
                .filter((f) => f.filePath.startsWith('src/orders'))
                .map((f) => f.filePath),
        ).toEqual(['src/orders/orders.controller.ts']);
        // The second unit's call carries the first unit's finding too.
        const serviceCall = (
            dedup.mock.calls as unknown as [unknown, any[]][]
        ).find(([, s]) =>
            s.some((x) => x.relevantFile === 'src/orders/orders.service.ts'),
        );
        expect(serviceCall?.[1].map((s) => s.relevantFile)).toEqual([
            'src/orders/orders.controller.ts',
            'src/orders/orders.service.ts',
        ]);
        expect(result.progress.every((p) => p.state === 'done')).toBe(true);
    });

    it('keeps one finding for the route and the query of one missing check', async () => {
        // The service unit's `serviceClass` lens reports a finding whose attack
        // path runs through the controller's flagged line.
        const keepAll = jest.fn(async (_deps: any, suggestions: any[]) => ({
            suggestions,
            trace: {} as any,
        }));
        const run = (serviceClass: string) =>
            new SecurityScanEngine({
                runLens: fakeLens((file, cls) =>
                    file.endsWith('orders.controller.ts')
                        ? cls === 'authz'
                            ? [IDOR]
                            : []
                        : cls === serviceClass
                          ? [
                                {
                                    ...IDOR,
                                    relevantFile:
                                        'src/orders/orders.service.ts',
                                    relevantLinesStart: 20,
                                    relevantLinesEnd: 22,
                                },
                            ]
                          : [],
                ),
                llm: fakeLlm({
                    units: [
                        {
                            file: 'src/orders/orders.controller.ts',
                            relatedFiles: [],
                            classes: ['authz'],
                            priority: 90,
                            reason: '',
                        },
                        {
                            file: 'src/orders/orders.service.ts',
                            relatedFiles: [],
                            classes: [serviceClass],
                            priority: 80,
                            reason: '',
                        },
                    ],
                }),
                collectSurface: jest.fn(async () => SURFACE),
                dedup: keepAll as any,
            }).run({
                ...baseParams(),
                sandbox: fakeSandbox(),
                meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            } as any);

        const same = await run('authz');
        expect(same.findings.map((f) => f.filePath)).toEqual([
            'src/orders/orders.controller.ts',
        ]);

        // Another class on the same path is another bug.
        const other = await run('data_exposure');
        expect(other.findings.map((f) => f.filePath)).toEqual([
            'src/orders/orders.controller.ts',
            'src/orders/orders.service.ts',
        ]);
    });

    it('does not report again what an earlier job of the same scan reported', async () => {
        const engine = new SecurityScanEngine({
            runLens: fakeLens(() => [IDOR]),
            llm: fakeLlm(),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            units: [
                {
                    id: 'b',
                    file: 'src/orders/orders.controller.ts',
                    relatedFiles: [],
                    language: 'typescript',
                    classes: ['data_exposure'],
                    priority: 80,
                    reasons: [],
                },
            ],
            // The previous job's unit flagged the same leak on the same line.
            reported: [
                {
                    vulnerabilityClass: 'data_exposure',
                    cwe: 'CWE-200',
                    title: 'Any user can read any order',
                    description: 'No owner check.',
                    severity: 'high',
                    filePath: 'src/orders/orders.controller.ts',
                    startLine: 6,
                    endLine: 8,
                },
            ],
        } as any);

        expect(result.findings).toEqual([]);
        expect(result.progress).toEqual([
            expect.objectContaining({
                unitId: 'b',
                state: 'done',
                findings: 0,
            }),
        ]);
    });

    it("sends a unit's dedup only the earlier findings near its files", async () => {
        const dedup = jest.fn(async (_deps: any, suggestions: any[]) => ({
            suggestions,
            trace: {} as any,
        }));
        const far = {
            vulnerabilityClass: 'injection',
            title: 'Shell command from the query',
            description: 'd',
            severity: 'high',
            filePath: 'src/admin/exec.ts',
            startLine: 2,
            endLine: 2,
        };
        const near = { ...far, vulnerabilityClass: 'authz', filePath: 'src/orders/orders.controller.ts', startLine: 40, endLine: 41 };
        const engine = new SecurityScanEngine({
            runLens: fakeLens((_file, cls) => (cls === 'authz' ? [IDOR] : [])),
            llm: fakeLlm(),
            collectSurface: jest.fn(async () => SURFACE),
            dedup: dedup as any,
        });

        await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            units: [
                { id: 'b', file: 'src/orders/orders.controller.ts', relatedFiles: [], language: 'typescript', classes: ['authz'], priority: 80, reasons: [] },
            ],
            reported: [far, near],
        } as any);

        const sent = (dedup.mock.calls[0] as unknown as [unknown, any[]])[1];
        expect(sent.map((x) => x.relevantFile)).toEqual([
            'src/orders/orders.controller.ts',
            'src/orders/orders.controller.ts',
        ]);
    });

    it('keeps two different weaknesses on the same line apart', async () => {
        const keepAll = jest.fn(async (_deps: any, suggestions: any[]) => ({ suggestions, trace: {} as any }));
        const engine = new SecurityScanEngine({
            // An IDOR and a SQL injection in the same handler line.
            runLens: fakeLens((_file, cls) => (cls === 'authz' || cls === 'injection' ? [IDOR] : [])),
            llm: fakeLlm({
                units: [{ file: 'src/orders/orders.controller.ts', relatedFiles: [], classes: ['authz', 'injection'], priority: 90, reason: '' }],
            }),
            collectSurface: jest.fn(async () => SURFACE),
            dedup: keepAll as any,
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.findings.map((f) => f.cwe).sort()).toEqual(['CWE-639', 'CWE-89']);
    });

    it('keeps every finding when the dedup fails', async () => {
        const engine = new SecurityScanEngine({
            runLens: fakeLens((_file, cls) =>
                cls === 'authz'
                    ? [IDOR]
                    : cls === 'injection'
                      ? [{ ...IDOR, relevantFile: 'src/admin/exec.ts' }]
                      : [],
            ),
            llm: fakeLlm({
                units: [
                    {
                        file: 'src/orders/orders.controller.ts',
                        relatedFiles: [],
                        classes: ['authz'],
                        priority: 90,
                        reason: '',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
            dedup: (async () => {
                throw new Error('dedup model down');
            }) as any,
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.findings).toHaveLength(2);
    });
});

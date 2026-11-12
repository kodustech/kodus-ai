// No test reaches a real model: the review's dedup finds no managed key.
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

import { ScanBudgetMeter } from '../domain/budget-meter';
import type { SurfaceMap } from '../domain/surface/surface.types';
import { admitRequest, reportUsage } from '@libs/llm/usage-meter';

import { SecurityScanEngine } from './security-scan-engine';

const RATES = {
    input: { default: 1e-6 },
    output: { default: 1e-6 },
    cacheRead: { default: 1e-7 },
    cacheWrite: { default: 1e-6 },
};

/**
 * One model request as the model wrapper and its caller meter it: admitted
 * with its prompt and answer cap, settled with what it billed, recorded.
 */
function bill(inputTokens: number, outputTokens: number, runName: string) {
    const usage = { inputTokens, outputTokens } as any;
    admitRequest(() => ({
        inputTokens,
        maxOutputTokens: outputTokens,
    })).settle(usage);
    reportUsage(usage, { runName });
}

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
    'test/orders.e2e-spec.ts': "it('reads an order', () => {});",
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
            if (command.startsWith('test -e')) {
                const taken = Object.keys(FILES).some((f) =>
                    command.includes(`'/repo/${f}'`),
                );
                return { stdout: '', exitCode: taken ? 0 : 1 };
            }
            if (command.includes('ls-files -z')) {
                return { stdout: Object.keys(FILES).join('\0'), exitCode: 0 };
            }
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
        bill(90_000, 10_000, input.usageRunName);
        const file = /Start from this file:\n`{3,}\n(.+)\n/.exec(
            input.userPrompt,
        )[1];
        const cls = input.agentName.replace('security-scan-', '');
        return {
            findings: { reasoning: '', suggestions: findingsFor(file, cls) },
            finishReason: 'completed',
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
        bill(1000, 100, req.runName);
        if (req.runName.endsWith('-map')) {
            if (plan instanceof Error) throw plan;
            return plan;
        }
        if (req.runName.endsWith('-finalize')) {
            // Each lens's weakness gets its own CWE, as a real model gives.
            const cls =
                /Vulnerability class: (\w+)/.exec(req.user)?.[1] ?? 'authz';
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
        // The controller holds a route: its unit runs injection,
        // misconfiguration and resource exhaustion besides the authz the
        // plan asked for.
        expect(runLens).toHaveBeenCalledTimes(5);
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
        // Five lenses, the map and one finalize.
        expect(meter.snapshot().requests).toBe(5 + 1 + 1);
    });

    it('audits units at once and folds them in the order of the plan', async () => {
        let running = 0;
        let most = 0;
        const lens = fakeLens((file, cls) =>
            file.endsWith('exec.ts') && cls === 'injection'
                ? [{ ...IDOR, relevantFile: 'src/admin/exec.ts' }]
                : file.endsWith('orders.controller.ts') && cls === 'authz'
                  ? [IDOR]
                  : [],
        );
        const runLens = jest.fn(async (input: any, secrets: any) => {
            running++;
            most = Math.max(most, running);
            // The first unit in the plan is the slowest to finish.
            const slow = input.userPrompt.includes('orders.controller.ts');
            await new Promise((r) => setTimeout(r, slow ? 30 : 5));
            running--;
            return lens(input, secrets);
        });
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

        expect(most).toBeGreaterThan(1);
        expect(result.findings.map((f) => f.filePath)).toEqual([
            'src/orders/orders.controller.ts',
            'src/admin/exec.ts',
        ]);
    });

    it('drops, before finalizing, a finding in an invented file or a test', async () => {
        const runLens = fakeLens((file, cls) =>
            file.endsWith('orders.controller.ts') && cls === 'authz'
                ? [
                      { ...IDOR, relevantFile: 'src/orders/invented.ts' },
                      { ...IDOR, relevantFile: 'test/orders.e2e-spec.ts' },
                      { ...IDOR, relevantFile: '/repo/' + IDOR.relevantFile },
                  ]
                : [],
        );
        const llm = fakeLlm(new Error('no plan'));
        const engine = new SecurityScanEngine({
            runLens,
            llm,
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.findings.map((f) => f.filePath)).toEqual([
            'src/orders/orders.controller.ts',
        ]);
        expect(
            llm.mock.calls.filter(([req]) => req.runName.endsWith('-finalize')),
        ).toHaveLength(1);
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
                finishReason: 'completed',
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

    it('stops a unit between lenses at the deadline and keeps what it found for the next slice', async () => {
        let now = 0;
        const lens = fakeLens((file, cls) =>
            file.endsWith('orders.controller.ts') && cls === 'authz'
                ? [IDOR]
                : [],
        );
        const runLens = jest.fn(async (input: any, secrets: any) => {
            now += 60_000;
            return lens(input, secrets);
        });
        const onUnitDone = jest.fn();
        const engine = new SecurityScanEngine({
            runLens,
            llm: fakeLlm({
                units: [
                    {
                        file: 'src/orders/orders.controller.ts',
                        relatedFiles: [],
                        classes: ['authz', 'injection'],
                        priority: 90,
                        reason: '',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
            now: () => now,
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            deadlineAt: 30_000,
            onUnitDone,
        } as any);

        // The controller unit has several lenses; only the first ran.
        expect(
            runLens.mock.calls.filter(([input]: any[]) =>
                input.userPrompt.includes('orders.controller.ts'),
            ),
        ).toHaveLength(1);
        expect(result.progress[0].state).toBe('pending');
        expect(onUnitDone).toHaveBeenCalledWith(
            expect.objectContaining({ state: 'pending' }),
            [expect.objectContaining({ vulnerabilityClass: 'authz' })],
        );
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
        // Removed once it ran: later lenses never read it as the repository's.
        expect(sandbox.run).toHaveBeenCalledWith(
            "rm -f -- '/repo/src/orders/idor.repro.spec.ts'",
            expect.anything(),
        );
    });

    it('never writes over, runs or removes a file the repository already has', async () => {
        const sandbox = fakeSandbox('e2b');
        const llm = fakeLlm({ units: [] });
        const answer = llm.getMockImplementation()!;
        llm.mockImplementation(async (req: any) =>
            req.runName.endsWith('-repro')
                ? {
                      path: 'src/orders/orders.service.ts',
                      content: 'test("idor", () => {})',
                      command: 'npx jest src/orders/orders.service.ts',
                  }
                : answer(req),
        );
        const engine = new SecurityScanEngine({
            runLens: fakeLens((file, cls) =>
                file.endsWith('orders.controller.ts') && cls === 'authz'
                    ? [IDOR]
                    : [],
            ),
            llm,
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams({ reproduce: true }),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(sandbox.writeFile).not.toHaveBeenCalled();
        const commands = sandbox.run.mock.calls.map((c: any[]) => c[0]);
        expect(commands.some((c: string) => c.startsWith('rm '))).toBe(false);
        expect(commands.some((c: string) => c.includes('npx jest'))).toBe(
            false,
        );
        // The test is kept on the issue, marked as not run.
        expect(result.findings[0].reproduction).toEqual(
            expect.objectContaining({
                path: 'src/orders/orders.service.ts',
                executed: false,
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
        // The review's dedup folds what lands on the same line (deterministic
        // here; the real one asks the model).
        const sameLine = jest.fn(async (_deps: any, suggestions: any[]) => {
            const seen = new Set<string>();
            return {
                suggestions: suggestions.filter((x) => {
                    const key = `${x.relevantFile}:${x.relevantLinesStart}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                }),
                trace: {} as any,
            };
        });
        const engine = new SecurityScanEngine({
            dedup: sameLine as any,
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
        const near = {
            ...far,
            vulnerabilityClass: 'authz',
            filePath: 'src/orders/orders.controller.ts',
            startLine: 40,
            endLine: 41,
        };
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
                {
                    id: 'b',
                    file: 'src/orders/orders.controller.ts',
                    relatedFiles: [],
                    language: 'typescript',
                    classes: ['authz'],
                    priority: 80,
                    reasons: [],
                },
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
        const keepAll = jest.fn(async (_deps: any, suggestions: any[]) => ({
            suggestions,
            trace: {} as any,
        }));
        const engine = new SecurityScanEngine({
            // An IDOR and a SQL injection in the same handler line.
            runLens: fakeLens((_file, cls) =>
                cls === 'authz' || cls === 'injection' ? [IDOR] : [],
            ),
            llm: fakeLlm({
                units: [
                    {
                        file: 'src/orders/orders.controller.ts',
                        relatedFiles: [],
                        classes: ['authz', 'injection'],
                        priority: 90,
                        reason: '',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
            dedup: keepAll as any,
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.findings.map((f) => f.cwe).sort()).toEqual([
            'CWE-639',
            'CWE-89',
        ]);
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

describe('SecurityScanEngine: what a scan may resolve', () => {
    const controllerOnly = {
        units: [
            {
                file: 'src/orders/orders.controller.ts',
                relatedFiles: [],
                classes: ['authz', 'injection'],
                priority: 90,
                reason: 'loads orders by id',
            },
        ],
    };

    it('does not count a class as examined where its lens failed', async () => {
        const runLens = jest.fn(async (input: any) => {
            if (input.agentName === 'security-scan-injection') {
                throw new Error('provider 500');
            }
            return {
                findings: { reasoning: '', suggestions: [] },
                finishReason: 'completed',
            } as any;
        });
        const engine = new SecurityScanEngine({
            runLens,
            llm: fakeLlm(controllerOnly),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        const classes = result.examinedByClass.map((e) => e.vulnerabilityClass);
        expect(classes).toContain('authz');
        expect(classes).not.toContain('injection');
        // The area failed for the class it could not read, so it shows and
        // runs again; what it did read still counts.
        expect(result.progress[0]).toEqual(
            expect.objectContaining({
                state: 'failed',
                error: 'not read to the end: injection',
            }),
        );
    });

    it.each([
        [
            'ran out of steps',
            {
                finishReason: 'budget-exhausted',
                incompleteReason: 'budget-exhausted',
            },
        ],
        [
            'was cut by the provider',
            { finishReason: 'completed', incompleteReason: 'truncated' },
        ],
        [
            'never submitted a result',
            { finishReason: 'completed', submittedResult: false },
        ],
        [
            'ended in a provider error',
            { finishReason: 'error', errorName: 'APICallError' },
        ],
        [
            'could not verify a finding',
            { finishReason: 'completed', unverifiedByVerify: [IDOR] },
        ],
    ])(
        'keeps what a lens that %s found, without counting its class as examined',
        async (_case, ending) => {
            const runLens = jest.fn(async (input: any) => ({
                findings: {
                    reasoning: '',
                    suggestions:
                        input.agentName === 'security-scan-authz' ? [IDOR] : [],
                },
                ...(input.agentName === 'security-scan-authz'
                    ? ending
                    : { finishReason: 'completed' }),
            }));
            const engine = new SecurityScanEngine({
                runLens: runLens as any,
                llm: fakeLlm(controllerOnly),
                collectSurface: jest.fn(async () => SURFACE),
            });

            const result = await engine.run({
                ...baseParams(),
                sandbox: fakeSandbox(),
                meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            } as any);

            const classes = result.examinedByClass.map(
                (e) => e.vulnerabilityClass,
            );
            expect(classes).not.toContain('authz');
            expect(classes).toContain('injection');
            expect(result.findings).toEqual([
                expect.objectContaining({ vulnerabilityClass: 'authz' }),
            ]);
        },
    );

    it('lists the tracked files only when git listed them all', async () => {
        const engine = new SecurityScanEngine({
            runLens: fakeLens(() => []),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
        });
        const listed = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);
        expect(listed.trackedFiles?.sort()).toEqual(Object.keys(FILES).sort());

        const noGit = fakeSandbox();
        noGit.run.mockImplementation(async () => ({
            stdout: '',
            exitCode: 128,
        }));
        noGit.remoteCommands.listDir.mockResolvedValue(
            Object.keys(FILES).join('\n'),
        );
        const walked = await engine.run({
            ...baseParams(),
            sandbox: noGit,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);
        expect(walked.trackedFiles).toBeUndefined();
    });
});

describe('SecurityScanEngine: no request past the cap', () => {
    const execOnly = {
        units: [
            {
                file: 'src/admin/exec.ts',
                relatedFiles: [],
                classes: ['injection'],
                priority: 90,
                reason: 'shell',
            },
        ],
    };
    // Only the shell sink: one unit, one lens, nothing running beside it.
    const execSurface: SurfaceMap = {
        ...SURFACE,
        hits: SURFACE.hits.filter((h) => h.file === 'src/admin/exec.ts'),
        files: { 'src/admin/exec.ts': SURFACE.files['src/admin/exec.ts'] },
    };
    const atLine = (line: number) => ({
        ...IDOR,
        relevantFile: 'src/admin/exec.ts',
        relevantLinesStart: line,
        relevantLinesEnd: line,
    });

    it("stops finalizing a lens's findings once the next request would cross the cap", async () => {
        // The map and each finalize bill 1,100 tokens and are admitted at
        // 1,350; the lens bills none. Room for the map and one finalize.
        const meter = new ScanBudgetMeter({ maxTokens: 3000 }, null);
        const engine = new SecurityScanEngine({
            runLens: jest.fn(async () => ({
                findings: {
                    reasoning: '',
                    suggestions: [atLine(1), atLine(2), atLine(3)],
                },
                finishReason: 'completed',
            })) as any,
            llm: fakeLlm(execOnly),
            collectSurface: jest.fn(async () => execSurface),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter,
        } as any);

        expect(meter.snapshot().requests).toBe(2);
        expect(
            meter.snapshot().inputTokens + meter.snapshot().outputTokens,
        ).toBeLessThanOrEqual(3000);
        expect(result.stoppedByBudget).toBe(true);
    });
});

describe('SecurityScanEngine: failures that must not pass for a clean scan', () => {
    it('fails the scan when every search of the repository failed', async () => {
        const engine = new SecurityScanEngine({
            runLens: fakeLens(() => []),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => ({
                ...SURFACE,
                hits: [],
                files: {},
                errors: [
                    {
                        language: 'typescript',
                        patternIds: ['ts.exec'],
                        message: 'grep failed: sandbox unreachable',
                    },
                ],
            })),
        });

        await expect(
            engine.run({
                ...baseParams(),
                sandbox: fakeSandbox(),
                meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            } as any),
        ).rejects.toThrow(/could not read the repository/);
    });

    it('carries on when a search was only cut short', async () => {
        const engine = new SecurityScanEngine({
            runLens: fakeLens(() => []),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => ({
                ...SURFACE,
                errors: [
                    {
                        language: 'typescript',
                        patternIds: ['ts.exec'],
                        message: 'truncated: kept 200 hits, dropped 5',
                    },
                ],
            })),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.finished).toBe(true);
    });

    it('never starts a queued reproduction test once the slice deadline passed', async () => {
        let now = 0;
        const sandbox = fakeSandbox('e2b');
        const run = sandbox.run.getMockImplementation()!;
        // Each test run takes the sandbox for 20 minutes.
        sandbox.run.mockImplementation(async (command: string) => {
            if (command.includes('npx jest')) now += 20 * 60_000;
            return run(command);
        });
        const exec = {
            ...IDOR,
            relevantFile: 'src/admin/exec.ts',
            relevantLinesStart: 2,
            relevantLinesEnd: 2,
            suggestionContent:
                'Entry: src/admin/exec.ts:1\nThe dir query parameter reaches exec.',
        };
        const engine = new SecurityScanEngine({
            // Two units at once, one finding each: both queue a test before
            // the first one has run.
            runLens: fakeLens((file, cls) =>
                file.endsWith('orders.controller.ts') && cls === 'authz'
                    ? [IDOR]
                    : file.endsWith('exec.ts') && cls === 'injection'
                      ? [exec]
                      : [],
            ),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => SURFACE),
            now: () => now,
        });

        await engine.run({
            ...baseParams({ reproduce: true }),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            deadlineAt: 10 * 60_000,
        } as any);

        const testRuns = sandbox.run.mock.calls.filter(([c]: any[]) =>
            c.includes('npx jest'),
        );
        expect(testRuns).toHaveLength(1);
    });
});

describe('SecurityScanEngine: across slices and units', () => {
    const onlyController = {
        ...SURFACE,
        hits: SURFACE.hits.slice(0, 1),
        files: {
            'src/orders/orders.controller.ts':
                SURFACE.files['src/orders/orders.controller.ts'],
        },
    };

    it('keeps a finding in a file whose path has non-ASCII characters', async () => {
        const accented = 'src/pedidos/ação.ts';
        const sandbox = fakeSandbox();
        const run = sandbox.run.getMockImplementation()!;
        // What git prints for it without -z: quoted, with octal escapes.
        sandbox.run.mockImplementation(async (command: string) =>
            command.includes('ls-files -z')
                ? {
                      stdout: [...Object.keys(FILES), accented].join('\0'),
                      exitCode: 0,
                  }
                : command.includes('ls-files')
                  ? {
                        stdout: '"src/pedidos/a\\303\\247\\303\\243o.ts"',
                        exitCode: 0,
                    }
                  : run(command),
        );
        const read = sandbox.remoteCommands.read.getMockImplementation()!;
        sandbox.remoteCommands.read.mockImplementation(async (path: string) =>
            path.endsWith('ação.ts')
                ? FILES['src/orders/orders.controller.ts']
                : read(path),
        );
        const engine = new SecurityScanEngine({
            runLens: fakeLens((file, cls) =>
                file === accented && cls === 'authz'
                    ? [{ ...IDOR, relevantFile: accented }]
                    : [],
            ),
            llm: fakeLlm({
                units: [
                    {
                        file: accented,
                        relatedFiles: [],
                        classes: ['authz'],
                        priority: 90,
                        reason: 'loads orders by id',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.findings.map((f) => f.filePath)).toContain(accented);
    });

    it('keeps a finding in a file listed past the first 20,000, and lists it as tracked', async () => {
        const controller = 'src/orders/orders.controller.ts';
        const filler = Array.from({ length: 20_000 }, (_, i) => `vendor/f${i}.ts`);
        const sandbox = fakeSandbox();
        const run = sandbox.run.getMockImplementation()!;
        sandbox.run.mockImplementation(async (command: string) =>
            command.includes('ls-files -z')
                ? { stdout: [...filler, ...Object.keys(FILES)].join('\0'), exitCode: 0 }
                : run(command),
        );
        const engine = new SecurityScanEngine({
            runLens: fakeLens((file, cls) =>
                file === controller && cls === 'authz' ? [IDOR] : [],
            ),
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => onlyController),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox,
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.findings.map((f) => f.filePath)).toContain(controller);
        expect(result.trackedFiles).toContain(controller);
    });

    it('fails a unit no lens read to the end, instead of calling it done', async () => {
        // Every lens finishes, but its verifier could not check what it found.
        const runLens = jest.fn(async () => ({
            findings: { reasoning: '', suggestions: [] },
            finishReason: 'completed',
            unverifiedByVerify: [IDOR],
        }));
        const engine = new SecurityScanEngine({
            runLens: runLens as any,
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => onlyController),
        });

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
        } as any);

        expect(result.progress[0]).toEqual(
            expect.objectContaining({
                state: 'failed',
                error: 'no lens read the area to the end',
            }),
        );
        expect(result.examinedByClass).toEqual([]);
    });

    it('names a unit with no lens left to run for what it is, not every lens failed', async () => {
        // A pending unit whose every lens already ran, none read to the end.
        const runLens = jest.fn();
        const engine = new SecurityScanEngine({
            runLens: runLens as any,
            llm: fakeLlm({ units: [] }),
            collectSurface: jest.fn(async () => onlyController),
        });
        const first = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            deadlineAt: -1,
        } as any);
        const unit = first.units[0];

        const result = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
            units: first.units,
            progress: [
                {
                    unitId: unit.id,
                    state: 'pending',
                    findings: 0,
                    lensesRun: unit.classes,
                    lensesExamined: [],
                },
            ],
        } as any);

        expect(runLens).not.toHaveBeenCalled();
        expect(result.progress[0]).toEqual(
            expect.objectContaining({
                state: 'failed',
                error: 'no lens read the area to the end',
            }),
        );
    });

    it('picks a long unit up at its next lens in the next slice, so it gets through', async () => {
        let now = 0;
        const lensOf = (input: any) =>
            input.agentName.replace('security-scan-', '');
        // Each lens takes 8 minutes; a slice stops starting lenses at 20.
        const runLens = jest.fn(async (_input: any) => {
            now += 8 * 60_000;
            return {
                findings: { reasoning: '', suggestions: [] },
                finishReason: 'completed',
            };
        });
        const engine = new SecurityScanEngine({
            runLens: runLens as any,
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
            collectSurface: jest.fn(async () => onlyController),
            now: () => now,
        });
        const meter = () => new ScanBudgetMeter({ maxUsd: 100 }, RATES);

        const first = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: meter(),
            deadlineAt: 20 * 60_000,
        } as any);
        const classes = first.units[0].classes;
        expect(classes.length).toBeGreaterThan(3);
        expect(first.finished).toBe(false);
        expect(first.progress[0]).toEqual(
            expect.objectContaining({
                state: 'pending',
                lensesRun: classes.slice(0, 3),
            }),
        );

        runLens.mockClear();
        const second = await engine.run({
            ...baseParams(),
            sandbox: fakeSandbox(),
            meter: meter(),
            units: first.units,
            progress: first.progress,
            deadlineAt: now + 20 * 60_000,
        } as any);

        // Only the lenses the first slice never reached.
        expect(runLens.mock.calls.map(([input]) => lensOf(input))).toEqual(
            classes.slice(3),
        );
        expect(second.finished).toBe(true);
        expect(
            second.examinedByClass.map((e) => e.vulnerabilityClass).sort(),
        ).toEqual([...classes].sort());
    });

    it('keeps the stored finding when the dedup picks a later report of the same bug', async () => {
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
        const summary = (x: any) => ({
            relevantFile: x.relevantFile,
            relevantLinesStart: x.relevantLinesStart,
            relevantLinesEnd: x.relevantLinesEnd,
            oneSentenceSummary: x.oneSentenceSummary,
        });
        // Groups the two and keeps the later one, the service's.
        const dedup = jest.fn(async (_deps: any, suggestions: any[]) => {
            if (suggestions.length < 2) {
                return { suggestions, trace: {} as any };
            }
            const [earlier, later] = suggestions;
            return {
                suggestions: [later],
                trace: {
                    groups: [
                        {
                            keep: summary(later),
                            duplicates: [summary(earlier)],
                        },
                    ],
                } as any,
            };
        });
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

        // The controller's finding was stored first and stays the one.
        expect(
            result.findings
                .filter((f) => f.filePath.startsWith('src/orders'))
                .map((f) => f.filePath),
        ).toEqual(['src/orders/orders.controller.ts']);
    });
});

describe('SecurityScanEngine: a unit that cannot be stored', () => {
    it('stops the lenses still running, not only new units', async () => {
        const started: string[] = [];
        const runLens = jest.fn(async (input: any) => {
            const file = /Start from this file:\n`{3,}\n(.+)\n/.exec(
                input.userPrompt,
            )![1];
            started.push(file);
            // The controller's lenses are slow; the shell unit's are not.
            if (file.endsWith('orders.controller.ts')) {
                await new Promise((r) => setTimeout(r, 30));
            }
            return {
                findings: { reasoning: '', suggestions: [] },
                finishReason: 'completed',
            };
        });
        const engine = new SecurityScanEngine({
            runLens: runLens as any,
            llm: fakeLlm({
                units: [
                    {
                        file: 'src/admin/exec.ts',
                        relatedFiles: [],
                        classes: ['injection'],
                        priority: 90,
                        reason: '',
                    },
                    {
                        file: 'src/orders/orders.controller.ts',
                        relatedFiles: [],
                        classes: ['authz'],
                        priority: 80,
                        reason: '',
                    },
                ],
            }),
            collectSurface: jest.fn(async () => SURFACE),
        });

        await expect(
            engine.run({
                ...baseParams(),
                sandbox: fakeSandbox(),
                meter: new ScanBudgetMeter({ maxUsd: 100 }, RATES),
                onUnitDone: async () => {
                    throw new Error('mongo down');
                },
            } as any),
        ).rejects.toThrow('mongo down');

        // The controller's unit has four lenses; only the one already
        // running when the store failed ever started.
        expect(
            started.filter((f) => f.endsWith('orders.controller.ts')),
        ).toHaveLength(1);
    });
});

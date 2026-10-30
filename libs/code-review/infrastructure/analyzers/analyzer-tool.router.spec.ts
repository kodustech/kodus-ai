import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { AnalyzerToolRouter } from './analyzer-tool.router';
import { AnalyzerTool, ChangedFile } from './tool.contract';

const file = (filename: string): ChangedFile => ({
    filename,
    patch: '@@ -0,0 +1,1 @@\n+x',
});

/** A tool that claims files by extension. */
const toolFor = (
    extension: string,
    overrides: Partial<AnalyzerTool> = {},
): AnalyzerTool => ({
    id: 'dependencies',
    coverage: ManagedTool.DEPENDENCIES,
    selectFiles: (files) => files.filter((f) => f.filename.endsWith(extension)),
    run: jest.fn().mockResolvedValue([]),
    ...overrides,
});

describe('AnalyzerToolRouter', () => {
    const router = new AnalyzerToolRouter();

    it('runs a tool whose files are in the change', () => {
        const [decision] = router.route([toolFor('.go')], {
            changedFiles: [file('src/db.go')],
            modes: { dependencies: true },
        });

        expect(decision).toEqual({
            toolId: 'dependencies',
            run: true,
            fileCount: 1,
        });
    });

    // "Never run a tool that does not apply to the changed files."
    it('skips a tool that claims none of the changed files', () => {
        const [decision] = router.route([toolFor('.go')], {
            changedFiles: [file('README.md')],
            modes: { dependencies: true },
        });

        expect(decision.run).toBe(false);
        expect(decision.reason).toBe('no-matching-files');
        expect(decision.fileCount).toBe(0);
    });

    it('skips a tool the configuration disables', () => {
        const [decision] = router.route([toolFor('.go')], {
            changedFiles: [file('src/db.go')],
            modes: { dependencies: false },
        });

        expect(decision.run).toBe(false);
        expect(decision.reason).toBe('disabled-by-config');
    });

    // Absent configuration is off, not on: a deterministic pass must be opted
    // into rather than appearing on someone's PRs unannounced.
    it('treats an unset mode as disabled', () => {
        const [decision] = router.route([toolFor('.go')], {
            changedFiles: [file('src/db.go')],
        });

        expect(decision.run).toBe(false);
        expect(decision.reason).toBe('disabled-by-config');
    });

    describe('deferring to the customer CI', () => {
        it('skips on auto when their CI covers the category', () => {
            const [decision] = router.route([toolFor('.go')], {
                changedFiles: [file('src/db.go')],
                modes: { dependencies: true },
                ciCoveredTools: [ManagedTool.DEPENDENCIES],
            });

            expect(decision.run).toBe(false);
            expect(decision.reason).toBe('covered-by-ci');
        });

        it('runs on auto when their CI covers a different category', () => {
            const [decision] = router.route([toolFor('.go')], {
                changedFiles: [file('src/db.go')],
                modes: { dependencies: true },
                ciCoveredTools: [ManagedTool.SECRETS],
            });

            expect(decision.run).toBe(true);
        });

        it('skips when enabled and their CI covers the category', () => {
            const [decision] = router.route([toolFor('.go')], {
                changedFiles: [file('src/db.go')],
                modes: { dependencies: true },
                ciCoveredTools: [ManagedTool.DEPENDENCIES],
            });

            expect(decision.run).toBe(false);
            expect(decision.reason).toBe('covered-by-ci');
        });

        it('ignores CI coverage for a tool that declares no category', () => {
            const [decision] = router.route(
                [toolFor('.go', { coverage: undefined })],
                {
                    changedFiles: [file('src/db.go')],
                    modes: { dependencies: true },
                    ciCoveredTools: [ManagedTool.DEPENDENCIES],
                },
            );

            expect(decision.run).toBe(true);
        });
    });

    // The issue asks us to record why each tool did or did not run, so every
    // registered tool must appear in the decisions — including the skipped.
    it('returns a decision for every tool, run or not', () => {
        const decisions = router.route(
            [toolFor('.go'), toolFor('.ts', { id: 'dependencies' })],
            {
                changedFiles: [file('src/db.go')],
                modes: { dependencies: true },
            },
        );

        expect(decisions).toHaveLength(2);
        expect(decisions.filter((d) => d.run)).toHaveLength(1);
        expect(decisions.filter((d) => !d.run)).toHaveLength(1);
    });

    it('returns nothing for no tools', () => {
        expect(router.route([], { changedFiles: [file('src/db.go')] })).toEqual(
            [],
        );
    });

    it('skips everything when nothing changed', () => {
        const [decision] = router.route([toolFor('.go')], {
            changedFiles: [],
            modes: { dependencies: true },
        });

        expect(decision.run).toBe(false);
        expect(decision.reason).toBe('no-matching-files');
    });

    // Config is checked before file selection: a disabled tool should not be
    // asked to inspect the change at all.
    it('does not consult a disabled tool about the files', () => {
        const selectFiles = jest.fn();
        router.route([toolFor('.go', { selectFiles })], {
            changedFiles: [file('src/db.go')],
            modes: { dependencies: false },
        });

        expect(selectFiles).not.toHaveBeenCalled();
    });
});

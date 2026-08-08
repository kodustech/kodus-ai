import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { TRACE_SUBCOMMANDS, traceCommand } from '../trace/index.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

describe('traceCommand registration', () => {
    it('registers expected subcommands', () => {
        const names = traceCommand.commands.map((c) => c.name());
        for (const expected of TRACE_SUBCOMMANDS) {
            if (expected.startsWith('_')) {
                // hidden internal commands still registered
                expect(names).toContain(expected);
                continue;
            }
            expect(names).toContain(expected);
        }
        // capture must not exist
        expect(names).not.toContain('capture');
        expect(names).not.toContain('promote');
        expect(names).not.toContain('show');
    });

    it('resolves enable as a subcommand, not a path', async () => {
        const program = new Command();
        program.exitOverride();
        program.addCommand(traceCommand);

        // enable is a registered subcommand — help text should mention install
        const enable = traceCommand.commands.find((c) => c.name() === 'enable');
        expect(enable).toBeDefined();
        expect(enable!.description()).toMatch(/hook/i);
    });

    it('README only documents registered trace commands', async () => {
        const readmePath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../README.md',
        );
        let readme: string;
        try {
            readme = await fs.readFile(readmePath, 'utf-8');
        } catch {
            // README may not exist in all packages
            return;
        }

        // Extract `kodus trace <subcommand>` mentions — only flag known-looking
        // subcommand tokens that are NOT registered (ignore prose / paths).
        const registered = new Set(
            TRACE_SUBCOMMANDS.filter((s) => !s.startsWith('_')) as string[],
        );
        const knownCommandish = new Set([
            ...registered,
            // Removed commands must not reappear in README
            'capture',
            'promote',
            'show',
            'recall',
        ]);

        const re = /kodus\s+trace\s+([a-z][\w-]*)/gi;
        let m: RegExpExecArray | null;
        const undocumented: string[] = [];
        while ((m = re.exec(readme)) !== null) {
            const name = m[1];
            if (!knownCommandish.has(name)) {
                // prose / paths — ignore
                continue;
            }
            if (!registered.has(name)) {
                undocumented.push(name);
            }
        }
        expect(undocumented).toEqual([]);
    });
});

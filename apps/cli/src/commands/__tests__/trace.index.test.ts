import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { traceCommand } from '../trace/index.js';
import { normalizeTraceArgv } from '../trace/argv.js';

function registeredCommandNames(): string[] {
    return traceCommand.commands.map((command) => command.name()).sort();
}

describe('traceCommand registration', () => {
    it('registers the documented commands', () => {
        expect(registeredCommandNames()).toEqual([
            'commit-trailer',
            'disable',
            'distill',
            'enable',
            'forget',
            'hooks',
            'pin',
            'status',
            'ui',
        ]);
    });

    it('accepts a bare path list on the group itself', () => {
        const args = traceCommand.registeredArguments.map((arg) => arg.name());
        expect(args).toContain('paths');
    });

    it('never registers a `recall` verb — reading needs no subcommand', () => {
        expect(registeredCommandNames()).not.toContain('recall');
    });
});

describe('README parity', () => {
    /**
     * The previous README documented `decisions status`, `decisions show`
     * and `decisions promote`, none of which had an implementation. This test
     * fails when the README grows another one.
     */
    it('every `kodus trace <verb>` in the README resolves to a registered command', () => {
        const readmePath = path.resolve(process.cwd(), 'README.md');
        const readme = fs.readFileSync(readmePath, 'utf-8');

        const registered = new Set(registeredCommandNames());
        const documented = new Set<string>();

        // A verb is a bare word: `kodus trace src/billing/invoice.ts` is a path
        // argument, not a command, so the token must end at the word boundary.
        for (const match of readme.matchAll(
            /kodus trace ([a-z][a-z-]*)(?=$|[\s`])/gm,
        )) {
            documented.add(match[1]);
        }

        const undocumentedButUsed = [...documented].filter(
            (verb) => !registered.has(verb),
        );

        expect(
            undocumentedButUsed,
            `README documents commands that are not registered: ${undocumentedButUsed.join(', ')}`,
        ).toEqual([]);
    });

    it('the README documents the trace group, not the removed decisions group', () => {
        const readme = fs.readFileSync(
            path.resolve(process.cwd(), 'README.md'),
            'utf-8',
        );
        expect(readme).not.toContain('kodus decisions');
    });
});

describe('normalizeTraceArgv', () => {
    const argv = (...args: string[]): string[] => ['node', 'kodus', ...args];

    it('leaves a normal subcommand invocation alone', () => {
        expect(normalizeTraceArgv(argv('trace', 'enable'))).toEqual(
            argv('trace', 'enable'),
        );
    });

    it('leaves a bare path list alone', () => {
        expect(normalizeTraceArgv(argv('trace', 'src/billing'))).toEqual(
            argv('trace', 'src/billing'),
        );
    });

    it('rewrites everything after `--` into repeated --path options', () => {
        expect(normalizeTraceArgv(argv('trace', '--', 'enable'))).toEqual(
            argv('trace', '--path', 'enable'),
        );
        expect(normalizeTraceArgv(argv('trace', '--', 'status', 'ui'))).toEqual(
            argv('trace', '--path', 'status', '--path', 'ui'),
        );
    });

    it('ignores `--` for other commands', () => {
        expect(normalizeTraceArgv(argv('review', '--', 'trace'))).toEqual(
            argv('review', '--', 'trace'),
        );
    });

    it('sees through global options before the command name', () => {
        expect(
            normalizeTraceArgv(argv('-f', 'json', 'trace', '--', 'enable')),
        ).toEqual(argv('-f', 'json', 'trace', '--path', 'enable'));
    });
});

import { describe, expect, it } from 'vitest';
import {
    formatInstallInstruction,
    getUpdateFailureHints,
    resolveGlobalInstallInstruction,
} from '../update.js';

describe('update command helpers', () => {
    it('uses npm by default', () => {
        expect(resolveGlobalInstallInstruction(undefined)).toEqual({
            command: 'npm',
            args: ['install', '-g', '@kodus/cli@latest'],
        });
    });

    it('uses pnpm when detected', () => {
        expect(
            resolveGlobalInstallInstruction('pnpm/10.0.0 npm/? node/v22.0.0'),
        ).toEqual({
            command: 'pnpm',
            args: ['add', '-g', '@kodus/cli@latest'],
        });
    });

    it('uses yarn global for yarn classic', () => {
        expect(
            resolveGlobalInstallInstruction('yarn/1.22.22 npm/? node/v22.0.0'),
        ).toEqual({
            command: 'yarn',
            args: ['global', 'add', '@kodus/cli@latest'],
        });
    });

    it('uses bun when detected', () => {
        expect(resolveGlobalInstallInstruction('bun/1.2.0')).toEqual({
            command: 'bun',
            args: ['add', '-g', '@kodus/cli@latest'],
        });
    });

    it('formats install instruction for manual command output', () => {
        expect(
            formatInstallInstruction({
                command: 'pnpm',
                args: ['add', '-g', '@kodus/cli@latest'],
            }),
        ).toBe('pnpm add -g @kodus/cli@latest');
    });

    it('adds registry diagnostics when package lookup fails', () => {
        const hints = getUpdateFailureHints(
            'Package `@kodus/cli` could not be found',
            {
                command: 'npm',
                args: ['install', '-g', '@kodus/cli@latest'],
            },
            'https://registry.internal.example',
        );

        expect(hints.join('\n')).toContain('npm config get registry');
        expect(hints.join('\n')).toContain('--registry https://registry.npmjs.org/');
        expect(hints.join('\n')).toContain('curl -fsSL');
    });

    it('keeps manual install hint for generic failures', () => {
        const hints = getUpdateFailureHints(
            'spawn npm ENOENT',
            {
                command: 'npm',
                args: ['install', '-g', '@kodus/cli@latest'],
            },
            undefined,
        );

        expect(hints[0]).toContain('Try running manually');
        expect(hints.join('\n')).not.toContain('--registry https://registry.npmjs.org/');
    });
});

import { describe, expect, it } from 'vitest';
import {
    buildHunkArgs,
    buildHunkViewerScope,
    canRenderScopeInHunk,
} from '../hunk-viewer.js';

const CTX = '/tmp/ctx.json';

describe('buildHunkViewerScope', () => {
    it('maps the default working-tree review', () => {
        expect(buildHunkViewerScope({})).toEqual({
            staged: false,
            paths: undefined,
        });
    });

    it('maps --staged', () => {
        expect(buildHunkViewerScope({ staged: true })).toEqual({
            staged: true,
            paths: undefined,
        });
    });

    it('maps --branch to a three-dot range against HEAD', () => {
        expect(buildHunkViewerScope({ branch: 'origin/main' })).toEqual({
            range: 'origin/main...HEAD',
            paths: undefined,
        });
    });

    it('maps --commit to a single ref', () => {
        expect(buildHunkViewerScope({ commit: 'abc123' })).toEqual({
            commit: 'abc123',
            paths: undefined,
        });
    });

    it('carries explicit files through as a pathspec', () => {
        expect(
            buildHunkViewerScope({ files: ['src/a.ts', 'src/b.ts'] }),
        ).toEqual({ staged: false, paths: ['src/a.ts', 'src/b.ts'] });
    });

    it('rejects --commit combined with --branch', () => {
        expect(
            buildHunkViewerScope({ commit: 'abc123', branch: 'main' }),
        ).toBeNull();
        expect(canRenderScopeInHunk({ commit: 'abc123', branch: 'main' })).toBe(
            false,
        );
    });

    it('now accepts the scopes that used to fall back to the legacy list', () => {
        expect(canRenderScopeInHunk({ branch: 'main' })).toBe(true);
        expect(canRenderScopeInHunk({ commit: 'abc123' })).toBe(true);
        expect(canRenderScopeInHunk({ files: ['a.ts'] })).toBe(true);
    });
});

describe('buildHunkArgs', () => {
    it('builds a working-tree invocation', () => {
        expect(buildHunkArgs({ staged: false }, CTX)).toEqual([
            'diff',
            '--agent-context',
            CTX,
            '--agent-notes',
            '--experimental',
        ]);
    });

    it('builds a staged invocation', () => {
        expect(buildHunkArgs({ staged: true }, CTX)).toEqual([
            'diff',
            '--staged',
            '--agent-context',
            CTX,
            '--agent-notes',
            '--experimental',
        ]);
    });

    it('builds a range invocation', () => {
        expect(buildHunkArgs({ range: 'main...HEAD' }, CTX)).toEqual([
            'diff',
            'main...HEAD',
            '--agent-context',
            CTX,
            '--agent-notes',
            '--experimental',
        ]);
    });

    it('builds a single-commit invocation with `show`', () => {
        expect(buildHunkArgs({ commit: 'abc123' }, CTX)).toEqual([
            'show',
            'abc123',
            '--agent-context',
            CTX,
            '--agent-notes',
            '--experimental',
        ]);
    });

    it('appends pathspecs after a `--` separator', () => {
        expect(
            buildHunkArgs({ range: 'main...HEAD', paths: ['src/a.ts'] }, CTX),
        ).toEqual([
            'diff',
            'main...HEAD',
            '--agent-context',
            CTX,
            '--agent-notes',
            '--experimental',
            '--',
            'src/a.ts',
        ]);
    });

    it('never emits --staged alongside an explicit range', () => {
        expect(
            buildHunkArgs({ range: 'main...HEAD', staged: true }, CTX),
        ).not.toContain('--staged');
    });

    it('loads the Kodus sidebar extension when one is available', () => {
        expect(
            buildHunkArgs({ staged: false }, CTX, '/pkg/hunk-extension/kodus'),
        ).toEqual([
            'diff',
            '--agent-context',
            CTX,
            '--agent-notes',
            '--experimental',
            '--extension',
            '/pkg/hunk-extension/kodus',
        ]);
    });

    it('omits --extension when no extension is bundled', () => {
        expect(buildHunkArgs({ staged: false }, CTX, null)).not.toContain(
            '--extension',
        );
    });

    it('keeps the pathspec last so --extension is never eaten by it', () => {
        const args = buildHunkArgs(
            { staged: false, paths: ['src/a.ts'] },
            CTX,
            '/pkg/hunk-extension/kodus',
        );
        expect(args.indexOf('--extension')).toBeLessThan(args.indexOf('--'));
        expect(args[args.length - 1]).toBe('src/a.ts');
    });
});

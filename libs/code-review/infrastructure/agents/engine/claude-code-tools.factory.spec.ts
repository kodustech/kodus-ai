/**
 * Claude Code's Read / Grep / Glob over our sandbox (#2113, A10), checked on a
 * real checkout with ripgrep, next to the finder's own tools.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAgentTools } from './agent-tools.factory';
import { buildClaudeCodeTools, catN, CC_READ_DEFAULT_LIMIT, repoPath } from './claude-code-tools.factory';
import { buildFinderToolRegistry } from '../adapters/finder-tools.adapter';

describe('Claude Code-shaped tools', () => {
    let repo: string;
    let remote: any;

    beforeAll(() => {
        repo = mkdtempSync(path.join(os.tmpdir(), 'cc-tools-'));
        mkdirSync(path.join(repo, 'src/deep'), { recursive: true });
        writeFileSync(path.join(repo, 'src/a.ts'), ['export function load(id: string) {', '    const user = find(id);', '    return user.name;', '}', ''].join('\n'));
        writeFileSync(path.join(repo, 'src/deep/b.ts'), ['import { load } from "../a";', 'export const n = load("1");', ''].join('\n'));
        writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
        const sh = (cmd: string) => {
            try {
                return { stdout: execSync(cmd, { cwd: repo, encoding: 'utf8' }), stderr: '', exitCode: 0 };
            } catch (e: any) {
                return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 2 };
            }
        };
        remote = {
            read: async (p: string, start: number, end: number) =>
                start === 0 && end === 0 ? execFileSync('cat', [p], { cwd: repo, encoding: 'utf8' }) : execFileSync('sed', ['-n', `${start < 1 ? 1 : start},${end}p`, p], { cwd: repo, encoding: 'utf8' }),
            grep: async (pattern: string, p: string) => sh(`rg -n -e '${pattern}' -- '${p}'`).stdout,
            listDir: async (p: string) => execFileSync('ls', [p], { cwd: repo, encoding: 'utf8' }),
            exec: async (cmd: string) => sh(cmd),
        };
    });

    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    const cc = () => buildClaudeCodeTools(remote);
    const schemaOf = (t: any) => t.inputSchema.jsonSchema;

    it('has Claude Code’s tool names and parameters', () => {
        const t = cc();
        expect(Object.keys(t)).toEqual(['Read', 'Grep', 'Glob']);
        expect(Object.keys(schemaOf(t.Read).properties)).toEqual(['file_path', 'offset', 'limit']);
        expect(schemaOf(t.Read).required).toEqual(['file_path']);
        expect(Object.keys(schemaOf(t.Grep).properties)).toEqual(['pattern', 'path', 'glob', 'output_mode', '-B', '-A', '-C', '-n', '-i', 'type', 'head_limit', 'multiline']);
        expect(schemaOf(t.Grep).properties.output_mode.enum).toEqual(['content', 'files_with_matches', 'count']);
        expect(Object.keys(schemaOf(t.Glob).properties)).toEqual(['pattern', 'path']);
    });

    it('Read returns the whole file up to 2000 lines, numbered as cat -n', async () => {
        expect(await cc().Read.execute({ file_path: 'src/a.ts' })).toBe(catN('export function load(id: string) {\n    const user = find(id);\n    return user.name;\n}', 1));
        const big = await cc().Read.execute({ file_path: 'big.txt' });
        const lines = big.split('\n');
        expect(lines).toHaveLength(CC_READ_DEFAULT_LIMIT);
        expect(lines[0]).toBe('     1\tline 1');
        expect(lines[1999]).toBe('  2000\tline 2000');
        expect(await cc().Read.execute({ file_path: 'big.txt', offset: 2400, limit: 3 })).toBe('  2400\tline 2400\n  2401\tline 2401\n  2402\tline 2402');
    });

    it('Read gives the same lines as readFile for the same range', async () => {
        const ours = (await buildAgentTools(remote).readFile.execute({ path: 'src/a.ts', startLine: 2, endLine: 3 })) as string;
        const theirs = (await cc().Read.execute({ file_path: 'src/a.ts', offset: 2, limit: 2 })) as string;
        // readFile also numbers the empty line after the final newline; the content lines are the overlap.
        const strip = (s: string, re: RegExp) => s.split('\n').map((l) => l.replace(re, '')).filter((l, i, all) => !(i === all.length - 1 && l === ''));
        expect(strip(theirs, /^\s*\d+\t/)).toEqual(strip(ours, /^\d+: /));
    });

    it('rejects path traversal and treats a leading slash as the repository root, as the finder tools do', async () => {
        expect(repoPath('../etc/passwd')).toEqual({ ok: false, error: 'Path traversal using ".." is not allowed' });
        expect(repoPath('/src/a.ts')).toEqual({ ok: true, path: 'src/a.ts' });
        expect(await cc().Read.execute({ file_path: 'src/../../x' })).toBe('Error: Path traversal using ".." is not allowed');
        expect(await cc().Grep.execute({ pattern: 'x', path: '../' })).toBe('Error: Path traversal using ".." is not allowed');
        expect(await cc().Glob.execute({ pattern: '*', path: 'src/../..' })).toBe('Error: Path traversal using ".." is not allowed');
        expect(await cc().Read.execute({ file_path: '/src/a.ts' })).toContain('export function load');
    });

    it('Grep defaults to file names, and its content mode matches the finder grep for the same search', async () => {
        const files = (await cc().Grep.execute({ pattern: 'load' })).split('\n');
        expect(files[0]).toBe('Found 2 files');
        expect(files.slice(1).sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
        const theirs = await cc().Grep.execute({ pattern: 'find\\(', output_mode: 'content', '-C': 2, path: 'src' });
        const ours = await buildAgentTools(remote).grep.execute({ pattern: 'find\\(', path: 'src' });
        expect(theirs).toBe(ours);
        expect(await cc().Grep.execute({ pattern: 'load', output_mode: 'count', path: 'src/a.ts' })).toBe('1');
        expect(await cc().Grep.execute({ pattern: 'LOAD', '-i': true, output_mode: 'content', '-n': false, path: 'src/a.ts' })).toBe('export function load(id: string) {');
        expect(await cc().Grep.execute({ pattern: 'nothing-like-this' })).toBe('No matches found');
        expect(await cc().Grep.execute({ pattern: 'line', output_mode: 'content', head_limit: 2, path: 'big.txt' })).toBe('1:line 1\n2:line 2');
    });

    it('never reads a pattern or path that starts with "-" as an rg flag', async () => {
        expect(await cc().Grep.execute({ pattern: '--pre=sh', path: 'src' })).toBe('No matches found');
    });

    it('Glob lists matching files, sorted', async () => {
        expect(await cc().Glob.execute({ pattern: '**/*.ts' })).toBe('src/a.ts\nsrc/deep/b.ts');
        expect(await cc().Glob.execute({ pattern: '*.ts', path: 'src/deep' })).toBe('src/deep/b.ts');
        expect(await cc().Glob.execute({ pattern: '*.rs' })).toBe('No files found');
    });

    it('the finder registry swaps grep/readFile/listDir for Read/Grep/Glob only when asked, keeping the other tools', () => {
        const names = (shape?: 'kodus' | 'claude-code') => buildFinderToolRegistry({ remoteCommands: remote, toolShape: shape }).registry.list().map((t) => t.name);
        const kodus = names();
        expect(kodus).toEqual(expect.arrayContaining(['grep', 'readFile', 'listDir']));
        const claude = names('claude-code');
        expect(claude).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
        expect(claude).not.toEqual(expect.arrayContaining(['grep']));
        expect(claude.filter((n) => !['Read', 'Grep', 'Glob'].includes(n)).sort()).toEqual(kodus.filter((n) => !['grep', 'readFile', 'listDir'].includes(n)).sort());
    });
});

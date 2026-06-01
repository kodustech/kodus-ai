import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const INSTALLER_PATH = path.resolve(process.cwd(), 'site/install.ps1');

describe('site/install.ps1', () => {
    it('uses cross-platform npm bin lookup and path handling', async () => {
        const source = await fs.readFile(INSTALLER_PATH, 'utf8');

        expect(source).toContain('npm bin -g');
        expect(source).toContain('[System.IO.Path]::PathSeparator');
        expect(source).toContain('function Get-KodusExecutableName');
        expect(source).toContain('kodus.cmd');
        expect(source).toContain('kodus');
    });
});

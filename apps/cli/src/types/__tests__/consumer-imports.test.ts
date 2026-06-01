import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const FILES = [
    'src/services/auth.service.ts',
    'src/services/review.service.ts',
    'src/services/git.service.ts',
    'src/services/repo-config.service.ts',
    'src/services/repo-settings.service.ts',
    'src/services/repo-settings-wizard.service.ts',
    'src/services/context.service.ts',
    'src/services/fix.service.ts',
    'src/formatters/repo-config.ts',
    'src/utils/command-errors.ts',
    'src/utils/repo-settings-patterns.ts',
    'src/utils/repo-settings-schema.ts',
];

describe('Type consumers', () => {
    test.each(FILES)('%s avoids the shared types barrel', (file) => {
        const filePath = path.resolve(process.cwd(), file);
        const contents = fs.readFileSync(filePath, 'utf-8');

        expect(contents).not.toContain("types/index.js");
    });
});

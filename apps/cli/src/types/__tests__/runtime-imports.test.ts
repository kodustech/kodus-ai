import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const FILES = [
    'src/commands/review.ts',
    'src/commands/pr.ts',
    'src/commands/schema.ts',
    'src/commands/hook/install.ts',
    'src/commands/hook/uninstall.ts',
    'src/commands/memory/index.ts',
    'src/commands/memory/disable.ts',
    'src/formatters/json.ts',
    'src/formatters/markdown.ts',
    'src/formatters/prompt.ts',
    'src/formatters/terminal.ts',
    'src/ui/interactive.ts',
    'src/utils/command-context.ts',
    'src/utils/credentials.ts',
    'src/utils/input-validation.ts',
    'src/utils/rate-limit.ts',
    'src/services/api/memory.api.ts',
    'src/services/api/trial.api.ts',
] as const;

describe('Runtime and command type consumers', () => {
    test.each(FILES)('%s avoids the shared types barrel', (file) => {
        const filePath = path.resolve(process.cwd(), file);
        const contents = fs.readFileSync(filePath, 'utf-8');

        expect(contents).not.toContain("types/index.js");
    });
});

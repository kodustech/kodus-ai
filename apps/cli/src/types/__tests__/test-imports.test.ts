import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const FILES = [
    'src/services/__tests__/auth.service.test.ts',
    'src/services/__tests__/review.service.auth-fallback.test.ts',
    'src/services/__tests__/review.service.test.ts',
    'src/services/__tests__/review.suggestions-auth.test.ts',
    'src/services/api/__tests__/api.real.test.ts',
    'src/utils/__tests__/command-errors.test.ts',
] as const;

describe('Test files type imports', () => {
    test.each(FILES)('%s avoids the shared types barrel', (file) => {
        const filePath = path.resolve(process.cwd(), file);
        const contents = fs.readFileSync(filePath, 'utf-8');

        expect(contents).not.toContain("types/index.js");
    });
});

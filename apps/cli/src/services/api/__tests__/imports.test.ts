import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const API_FILES = [
    'auth.api.ts',
    'review.api.ts',
    'config.api.ts',
    'api.interface.ts',
    'api-core.ts',
    'sessions.api.ts',
];

describe('API layer type imports', () => {
    test.each(API_FILES)('%s avoids the shared types barrel', (fileName) => {
        const filePath = path.resolve(
            __dirname,
            '..',
            fileName,
        );
        const contents = fs.readFileSync(filePath, 'utf-8');

        expect(contents).not.toContain("types/index.js");
    });
});

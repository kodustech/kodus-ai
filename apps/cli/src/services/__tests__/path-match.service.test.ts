import { describe, it, expect } from 'vitest';
import { filterDecisionsByPaths, pathMatches } from '../path-match.service.js';
import { recallStrategy } from '../decision-recall.service.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

describe('path-match.service', () => {
    it('matches exact and prefix paths', () => {
        expect(pathMatches('src/billing', ['src/billing/invoice.ts'])).toBe(
            true,
        );
        expect(pathMatches('src/billing/invoice.ts', ['src/billing'])).toBe(
            true,
        );
        expect(pathMatches('src/billing/invoice.ts', ['src/auth'])).toBe(false);
    });

    it('filters decisions by path', () => {
        const decisions = [
            { id: '1', paths: ['src/a.ts'], decision: 'A' },
            { id: '2', paths: ['src/b.ts'], decision: 'B', forgotten: true },
            { id: '3', paths: ['src/c.ts'], decision: 'C' },
        ];
        const matched = filterDecisionsByPaths(decisions, ['src/a.ts']);
        expect(matched.map((d) => d.id)).toEqual(['1']);
    });

    it('recall strategy is path-prefix only (no embeddings)', () => {
        expect(recallStrategy()).toBe('path-prefix');
        const dir = path.dirname(fileURLToPath(import.meta.url));
        const src = fs.readFileSync(
            path.join(dir, '../decision-recall.service.ts'),
            'utf-8',
        );
        // Assert no import of embedding/vector libraries (comments may mention them)
        expect(src).not.toMatch(
            /from ['"][^'"]*(embed|vector|pinecone|openai)[^'"]*['"]/i,
        );
        expect(src).not.toMatch(
            /require\(['"][^'"]*(embed|vector|pinecone)[^'"]*['"]\)/i,
        );
    });
});

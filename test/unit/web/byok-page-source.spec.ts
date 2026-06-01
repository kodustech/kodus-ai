import { readFileSync } from 'fs';
import { join } from 'path';

describe('byok page source', () => {
    it('uses a serializable null fallback when getBYOK fails', () => {
        const source = readFileSync(
            join(process.cwd(), 'apps/web/src/features/ee/byok/page.tsx'),
            'utf8',
        );

        expect(source).toContain('getBYOK().catch(() => null)');
        expect(source).not.toContain('getBYOK().catch(() => undefined)');
    });
});

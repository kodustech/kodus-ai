import fs from 'node:fs';
import path from 'node:path';

describe('analysis types source', () => {
    it('does not patch reviewOptions after render with useEffect', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/code-review/[repositoryId]/general/_components/analysis-types.tsx',
            ),
            'utf8',
        );

        expect(source).not.toContain('useEffect(');
        expect(source).not.toContain('form.setValue("reviewOptions"');
    });
});

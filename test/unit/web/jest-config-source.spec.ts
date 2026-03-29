import fs from 'node:fs';
import path from 'node:path';

describe('jest config source', () => {
    it('ignores dist outputs so manual mocks are not discovered twice', () => {
        const source = fs.readFileSync(
            path.join(process.cwd(), 'jest.config.ts'),
            'utf8',
        );

        expect(source).toContain('<rootDir>/dist');
    });
});

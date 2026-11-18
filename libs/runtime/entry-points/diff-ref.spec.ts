import { diffRefOf, firstAddedLine } from './diff-ref';
import { extractEntryPoints } from './extract';

const PATCH = ['@@ -10,4 +10,5 @@ export class Orders {', ' keep', '-gone', ' keep', '+added', '+more', ' keep'].join('\n');

describe('firstAddedLine', () => {
    it('is the new-file line of the first added row', () => {
        expect(firstAddedLine(PATCH)).toBe(12);
        expect(firstAddedLine('@@ -1,2 +1,1 @@\n-a\n b')).toBeUndefined();
        expect(firstAddedLine(undefined)).toBeUndefined();
        expect(firstAddedLine('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b')).toBe(1);
    });
});

describe('diffRefOf', () => {
    const files = [
        { path: 'src/orders.controller.ts', patch: PATCH, content: "@Controller('orders')\nclass O {\n  @Post()\n  create() {}\n}" },
        { path: 'src/pricing.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
    ];
    const entryPoints = extractEntryPoints(files);

    it('takes the probe\'s via when it is a file of the diff', () => {
        expect(diffRefOf({ entryPoint: 'POST /orders', via: 'src/pricing.ts', entryPoints, files })).toEqual({ file: 'src/pricing.ts', line: 1 });
    });

    it('takes the file the extractor matched for the entry point otherwise', () => {
        const id = entryPoints.find((e) => e.match.file === 'src/orders.controller.ts')!.id;
        expect(diffRefOf({ entryPoint: id, entryPoints, files })).toEqual({ file: 'src/orders.controller.ts', line: 12 });
    });

    it('never names a path the diff does not change', () => {
        expect(diffRefOf({ entryPoint: 'unmapped', via: 'etc/passwd', entryPoints, files })).toBeUndefined();
        expect(diffRefOf({ entryPoint: 'boot', entryPoints, files })).toBeUndefined();
    });
});

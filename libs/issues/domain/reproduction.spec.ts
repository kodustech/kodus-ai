import { isPlaceholderTest } from './reproduction';

describe('isPlaceholderTest', () => {
    it.each(['', 'PLACEHOLDER', 'placeholder', '// placeholder', 'REPLACE_ME', '__READ_THE_REPO_FIRST__', 'y'])(
        'reads %j as no test',
        (content) => {
            expect(isPlaceholderTest(content, 'npx jest x.spec.ts')).toBe(true);
        },
    );

    it('reads a placeholder command as no test', () => {
        const body = 'it("leaks", async () => { expect(await leak()).toBeDefined(); });';
        expect(isPlaceholderTest(body, 'placeholder')).toBe(true);
        expect(isPlaceholderTest(body, 'REPLACE_ME')).toBe(true);
        expect(isPlaceholderTest(body, 'z')).toBe(true);
    });

    it('keeps a real test, even one naming SQL placeholders', () => {
        const body =
            'it("binds the id as a ? placeholder", async () => { expect(await query("1 OR 1=1")).toHaveLength(0); });';
        expect(isPlaceholderTest(body, 'npx jest db.spec.ts')).toBe(false);
        expect(isPlaceholderTest(body)).toBe(false);
    });

    it.each(['pytest', 'phpunit', 'rspec', 'vitest', 'jest'])('keeps a test run by the bare runner %s', (command) => {
        const body = 'def test_leaks(client):\n    assert client.get("/orders/2").status_code == 200';
        expect(isPlaceholderTest(body, command)).toBe(false);
    });
});

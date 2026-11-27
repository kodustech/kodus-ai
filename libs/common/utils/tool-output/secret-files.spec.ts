import { withoutSecretFileLines } from './secret-files';

/**
 * The name screen tests only a name's head and tail. These pin that a long
 * name is still judged by both ends, so the cheaper screen drops nothing the
 * old whole-name regex caught.
 */
describe('withoutSecretFileLines — name screen at both ends', () => {
    const long = 'a'.repeat(300);

    it.each([
        `config/${long}/server.pem:3:KEY`,
        `config/${long}/release.keystore:1:KEY`,
        `config/${long}/.env.production.local:2:API_TOKEN=x`,
        `home/${long}/.ssh/id_ed25519:1:KEY`,
        `CONFIG/${long}/SERVER.PEM:3:KEY`,
    ])('drops %s', (line) => {
        expect(withoutSecretFileLines(`src/a.ts:1:ok\n${line}`)).toBe(
            'src/a.ts:1:ok',
        );
    });

    it('keeps a long code line full of -N- boundaries', () => {
        const svg = `src/icon.tsx:4:      d="${Array.from(
            { length: 400 },
            (_, i) => `l-${i % 9}-${(i * 7) % 9}`,
        ).join(' ')}"`;
        expect(withoutSecretFileLines(svg)).toBe(svg);
    });
});

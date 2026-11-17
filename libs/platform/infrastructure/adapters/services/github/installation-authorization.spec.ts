import {
    InstallationAuthorizationError,
    installationAuthorizationRedirectUri,
    isInstallationId,
    openInstallationState,
    sealInstallationState,
} from './installation-authorization';

describe('GitHub installation authorization', () => {
    let previous: string | undefined;

    beforeEach(() => {
        previous = process.env.API_CRYPTO_KEY;
        process.env.API_CRYPTO_KEY = 'e'.repeat(64);
    });

    afterEach(() => {
        process.env.API_CRYPTO_KEY = previous;
    });

    it('takes only a positive integer, sent as text, as an installation id', () => {
        for (const id of ['1', '42', '9'.repeat(19)]) {
            expect(isInstallationId(id)).toBe(true);
        }
        for (const id of [
            42,
            '',
            '0',
            '042',
            '-1',
            '1.5',
            '12a',
            'a12',
            '12\n',
            ' 12',
            '1'.repeat(20),
            undefined,
        ]) {
            expect(isInstallationId(id)).toBe(false);
        }
    });

    it('says why a state does not open, and names the error', () => {
        const state = sealInstallationState(
            { installationId: '42', userId: 'u', organizationId: 'o' },
            0,
        );
        const failure = (fn: () => unknown) => {
            try {
                fn();
            } catch (err) {
                return err;
            }
        };

        const expired = failure(() =>
            openInstallationState(state, 10 * 60 * 1000 + 1),
        ) as Error;
        expect(expired).toBeInstanceOf(InstallationAuthorizationError);
        expect(expired.name).toBe('InstallationAuthorizationError');
        expect(expired.message).toMatch(/expired/);
        expect(
            (failure(() => openInstallationState('junk')) as Error).message,
        ).toMatch(/missing or invalid/);
    });

    it('does not hide a missing API_CRYPTO_KEY as an invalid authorization', () => {
        const state = sealInstallationState({
            installationId: '42',
            userId: 'u',
            organizationId: 'o',
        });
        delete process.env.API_CRYPTO_KEY;

        expect(() => openInstallationState(state)).toThrow('API_CRYPTO_KEY');
    });

    it('returns under the sign-in callback, whatever slashes end the frontend URL', () => {
        for (const url of [
            'https://app.example.test',
            'https://app.example.test/',
            'https://app.example.test//',
        ]) {
            expect(installationAuthorizationRedirectUri(url)).toBe(
                'https://app.example.test/api/auth/callback/github/installation',
            );
        }
    });
});

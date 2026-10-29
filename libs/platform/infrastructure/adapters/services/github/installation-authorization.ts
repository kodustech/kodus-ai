import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Linking a GitHub App installation to a Kodus team needs proof that the
 * person linking can see that installation on GitHub: the installation id
 * alone is a GitHub-wide integer, and the App's own key mints a token for any
 * installation of the App. So the link goes through GitHub's user
 * authorization of the App, and the user token it returns must list the
 * installation in `GET /user/installations`.
 *
 * The `state` of that authorization is sealed with an HMAC and binds the
 * installation to the Kodus user and organization that asked for it, so a
 * code obtained for one link cannot complete another.
 *
 * The key is derived with HKDF-SHA256 from API_CRYPTO_KEY under a label of its
 * own, used for nothing else.
 */

const KEY_LABEL = 'kodus/github-installation-authorization/v1';
/** Long enough to go through GitHub's authorization page and back. */
export const INSTALLATION_STATE_TTL_MS = 10 * 60 * 1000;

export type InstallationAuthorizationState = {
    installationId: string;
    userId: string;
    organizationId: string;
};

export class InstallationAuthorizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InstallationAuthorizationError';
    }
}

/** A GitHub installation id: a positive integer, sent as text. */
export function isInstallationId(value: unknown): value is string {
    return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value);
}

function stateKey(): Buffer {
    const ikm = Buffer.from(process.env.API_CRYPTO_KEY ?? '', 'hex');
    if (ikm.length !== 32) {
        throw new Error('API_CRYPTO_KEY must be 32 bytes in hexadecimal.');
    }
    return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), KEY_LABEL, 32));
}

const sign = (data: string) =>
    createHmac('sha256', stateKey()).update(data).digest('base64url');

export function sealInstallationState(
    state: InstallationAuthorizationState,
    now = Date.now(),
): string {
    const data = Buffer.from(
        JSON.stringify({
            ...state,
            expiresAt: now + INSTALLATION_STATE_TTL_MS,
        }),
    ).toString('base64url');
    return `${data}.${sign(data)}`;
}

export function openInstallationState(
    sealed: unknown,
    now = Date.now(),
): InstallationAuthorizationState {
    const [data, signature] =
        typeof sealed === 'string' ? sealed.split('.') : [];
    if (!data || !signature) {
        throw new InstallationAuthorizationError(
            'The GitHub authorization is missing or invalid. Start the GitHub connection again.',
        );
    }
    const expected = Buffer.from(sign(data));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        throw new InstallationAuthorizationError(
            'The GitHub authorization is missing or invalid. Start the GitHub connection again.',
        );
    }
    const { installationId, userId, organizationId, expiresAt } = JSON.parse(
        Buffer.from(data, 'base64url').toString('utf8'),
    ) as InstallationAuthorizationState & { expiresAt: number };
    if (now > expiresAt) {
        throw new InstallationAuthorizationError(
            'The GitHub authorization expired. Start the GitHub connection again.',
        );
    }
    return { installationId, userId, organizationId };
}

/** Where GitHub sends the user back: the web app's /github-integration page. */
export function installationAuthorizationRedirectUri(
    frontendUrl: string,
): string {
    return `${frontendUrl.replace(/\/+$/, '')}/github-integration`;
}

/**
 * GitHub's user authorization page for the App. `redirectUri` must be one of
 * the App's callback URLs: the first one is usually the sign-in callback, so
 * it is always given.
 */
export function githubUserAuthorizationUrl(
    clientId: string,
    state: string,
    redirectUri: string,
): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
}

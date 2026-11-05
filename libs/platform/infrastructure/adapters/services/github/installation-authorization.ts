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

/**
 * Where GitHub sends the user back. It is under the App's sign-in callback
 * URL (`/api/auth/callback/github`), so no other callback URL has to be
 * registered: GitHub accepts a subdirectory of a callback URL while wildcard
 * matching is on, the default for an App with a single callback URL. The web
 * route there passes code and state on to /github-integration.
 */
export function installationAuthorizationRedirectUri(
    frontendUrl: string,
): string {
    return `${frontendUrl.replace(/\/+$/, '')}/api/auth/callback/github/installation`;
}

/**
 * GitHub's user authorization page for the App. `redirectUri` is always
 * given: without it GitHub would use the App's first callback URL, the
 * sign-in one.
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

/**
 * The steps of linking an installation, in order. A failed link is rewrapped
 * for the client, so the step is what tells the log where it stopped.
 */
export type InstallationLinkStep =
    | 'check-env'
    | 'open-state'
    | 'exchange-user-code'
    | 'list-user-installations'
    | 'check-existing-links'
    | 'mint-installation-token'
    | 'get-installation'
    | 'list-repositories'
    | 'find-integration'
    | 'create-integration'
    | 'update-integration'
    | 'update-installation-status';

export type InstallationLinkProgress = {
    step: InstallationLinkStep;
    /** From GitHub's installation, once read: "Organization" or "User". */
    targetType?: string;
    hasAccount?: boolean;
};

/**
 * What a link log carries. Never GitHub's authorization code or state: in the
 * OAuth path `code` is logged only when it is an installation id.
 */
export function installationLinkLogMetadata(
    params: any,
    progress: InstallationLinkProgress,
) {
    return {
        step: progress.step,
        installationId: isInstallationId(params?.code)
            ? params.code
            : undefined,
        organizationAndTeamData: params?.organizationAndTeamData,
        userId: params?.userId,
        targetType: progress.targetType,
        hasAccount: progress.hasAccount,
    };
}

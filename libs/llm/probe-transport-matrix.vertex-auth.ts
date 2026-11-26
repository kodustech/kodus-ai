/**
 * Keeps the Vertex OAuth exchange in-process for the probe transport matrix.
 *
 * `@ai-sdk/google-vertex` gets its bearer token from google-auth-library,
 * whose gaxios transport is node-fetch (never the global fetch), so the
 * matrix's fetch stub cannot answer it. The SDK also ships its OWN nested
 * copy of the library, which a plain `jest.mock('google-auth-library')` in the
 * spec does not reach (it resolves the root copy). So both copies are mocked
 * by resolved path, before the provider registry loads the SDK; the model
 * call itself still goes through the global fetch the stub replaces.
 *
 * Import this FIRST in the spec.
 */
import { dirname } from 'node:path';

const fakeGoogleAuth = () => ({
    GoogleAuth: class {
        async getClient() {
            return { getAccessToken: async () => ({ token: 'stub-token' }) };
        }
    },
});

const copies = new Set<string>();
for (const from of [
    __dirname,
    dirname(require.resolve('@ai-sdk/google-vertex')),
]) {
    try {
        copies.add(require.resolve('google-auth-library', { paths: [from] }));
    } catch {
        // Not installed at that level; the other copy is the one in use.
    }
}
for (const path of copies) {
    jest.doMock(path, fakeGoogleAuth);
}

export const MOCKED_GOOGLE_AUTH_COPIES = [...copies];

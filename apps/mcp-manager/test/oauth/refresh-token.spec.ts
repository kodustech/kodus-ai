import axios from 'axios';

import { checkAndRefreshOAuth } from '../../src/common/utils/oauth';

jest.mock('axios');

// RFC 6749 §6: the server MAY issue a new refresh token on refresh. When it
// doesn't, the client keeps the old one. Dropping it left the connection ACTIVE
// with no way to refresh once the access token expired.
describe('checkAndRefreshOAuth', () => {
    const expiredTokens = {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000,
    };
    const params = {
        tokens: expiredTokens,
        clientId: 'client',
        redirectUri: 'https://app.kodus.io/callback',
    };

    it('keeps the stored refresh token when the response omits one', async () => {
        (axios.post as jest.Mock).mockResolvedValue({
            status: 200,
            data: { access_token: 'new-access', expires_in: 3600 },
        });

        const tokens = await checkAndRefreshOAuth('https://idp/token', params);

        expect(tokens?.accessToken).toBe('new-access');
        expect(tokens?.refreshToken).toBe('old-refresh');
    });

    it('takes a rotated refresh token when the response carries one', async () => {
        (axios.post as jest.Mock).mockResolvedValue({
            status: 200,
            data: {
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 3600,
            },
        });

        const tokens = await checkAndRefreshOAuth('https://idp/token', params);

        expect(tokens?.refreshToken).toBe('new-refresh');
    });
});

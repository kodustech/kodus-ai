import { api } from './api/index.js';
import {
    loadCredentials,
    saveCredentials,
    clearCredentials,
} from '../utils/credentials.js';
import { loadConfig, clearConfig } from '../utils/config.js';
import type { StoredCredentials, AuthResponse, UserInfo } from '../types/auth.js';
import { AuthError } from '../types/errors.js';
import { loginViaBrowser } from './browser-login.service.js';
import {
    loginViaDeviceCode,
    type DeviceLoginPrompt,
} from './device-login.service.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

class AuthService {
    private cachedCredentials: StoredCredentials | null = null;
    private refreshInFlight: Promise<string> | null = null;

    private getEnvAuthToken(): string | null {
        const token = process.env.KODUS_TOKEN?.trim();
        if (token) {
            return token;
        }

        const teamKey = process.env.KODUS_TEAM_KEY?.trim();
        if (teamKey) {
            return teamKey;
        }

        return null;
    }

    async login(email: string, password: string): Promise<void> {
        const response = await api.auth.login(email, password);
        await this.storeAuthResponse(response);
        // Successful login switches auth mode to user credentials.
        try {
            await clearConfig();
        } catch {
            // Best effort cleanup.
        }
    }

    async loginViaBrowser({
        onOpenUrl,
    }: {
        onOpenUrl?: (url: string) => void;
    } = {}): Promise<UserInfo> {
        const result = await loginViaBrowser({ onOpenUrl });
        const response = this.buildAuthResponse(result);
        await this.storeAuthResponse(response);
        try {
            await clearConfig();
        } catch {
            // Best effort cleanup.
        }
        return response.user;
    }

    async loginViaDeviceCode({
        onPrompt,
    }: {
        onPrompt: (prompt: DeviceLoginPrompt) => void | Promise<void>;
    }): Promise<UserInfo> {
        const result = await loginViaDeviceCode({ onPrompt });
        const response = this.buildAuthResponse(result);
        await this.storeAuthResponse(response);
        try {
            await clearConfig();
        } catch {
            // Best effort cleanup.
        }
        return response.user;
    }

    private buildAuthResponse(input: {
        accessToken: string;
        refreshToken: string;
        userEmail?: string;
    }): AuthResponse {
        const decoded = decodeJwtClaims(input.accessToken);
        return {
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            expiresIn: decoded.expiresIn ?? 3600,
            user: {
                id: decoded.sub ?? 'unknown',
                email: input.userEmail ?? decoded.email ?? 'unknown',
                orgs: decoded.organizationId ? [decoded.organizationId] : [],
            },
        };
    }

    async logout(): Promise<void> {
        const credentials = await this.getCredentials();

        if (credentials) {
            try {
                await api.auth.logout(credentials.accessToken);
            } catch {
                // Ignore logout errors
            }
        }

        await Promise.all([clearCredentials(), clearConfig()]);
        this.cachedCredentials = null;
    }

    async isAuthenticated(): Promise<boolean> {
        if (this.getEnvAuthToken()) {
            return true;
        }

        const credentials = await this.getCredentials();
        if (credentials !== null) {
            return true;
        }

        const config = await loadConfig();
        return !!config?.teamKey;
    }

    async getCredentials(): Promise<StoredCredentials | null> {
        if (this.cachedCredentials) {
            return this.cachedCredentials;
        }

        this.cachedCredentials = await loadCredentials();
        return this.cachedCredentials;
    }

    async getValidToken(): Promise<string> {
        const envToken = this.getEnvAuthToken();
        if (envToken) {
            return envToken;
        }

        const credentials = await this.getCredentials();

        if (credentials) {
            const isExpired =
                Date.now() > credentials.expiresAt - TOKEN_REFRESH_BUFFER_MS;

            if (isExpired) {
                return this.refreshTokenOrFallback(credentials.refreshToken);
            }

            return credentials.accessToken;
        }

        const config = await loadConfig();
        if (config?.teamKey) {
            return config.teamKey;
        }

        throw new AuthError(
            'Not authenticated. Run: kodus auth login or kodus auth team-key --key <your-key>',
        );
    }

    async generateCIToken(): Promise<string> {
        const token = await this.getValidToken();
        return api.auth.generateCIToken(token);
    }

    async verifyToken(): Promise<{ valid: boolean; user?: any }> {
        const credentials = await this.getCredentials();

        if (!credentials) {
            return { valid: false };
        }

        return api.auth.verify(credentials.accessToken);
    }

    private async storeAuthResponse(response: AuthResponse): Promise<void> {
        const credentials: StoredCredentials = {
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresAt: Date.now() + response.expiresIn * 1000,
            user: response.user,
        };

        await saveCredentials(credentials);
        this.cachedCredentials = credentials;
    }

    private async refreshTokenOrFallback(
        refreshToken: string,
    ): Promise<string> {
        if (!this.refreshInFlight) {
            this.refreshInFlight = (async () => {
                try {
                    const response = await api.auth.refresh(refreshToken);
                    await this.storeAuthResponse(response);
                    return response.accessToken;
                } catch {
                    await clearCredentials();
                    this.cachedCredentials = null;

                    const config = await loadConfig();
                    if (config?.teamKey) {
                        return config.teamKey;
                    }

                    throw new AuthError(
                        'Session expired. Run: kodus auth login',
                    );
                }
            })();
        }

        try {
            return await this.refreshInFlight;
        } finally {
            this.refreshInFlight = null;
        }
    }
}

export { AuthService };
export const authService = new AuthService();

interface DecodedJwtClaims {
    sub?: string;
    email?: string;
    organizationId?: string;
    expiresIn?: number;
}

function decodeJwtClaims(token: string): DecodedJwtClaims {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {return {};}
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const expiresIn =
            typeof payload.exp === 'number'
                ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
                : undefined;
        return {
            sub: payload.sub,
            email: payload.email,
            organizationId: payload.organizationId,
            expiresIn,
        };
    } catch {
        return {};
    }
}

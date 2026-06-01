import type { AuthResponse, UserInfo } from '../../types/auth.js';
import type { IAuthApi } from './api.interface.js';
import { requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export class RealAuthApi implements IAuthApi {
    constructor(private readonly requester: RequestWithRetry = requestWithRetry) {}

    async login(email: string, password: string): Promise<AuthResponse> {
        const response = await this.requester<{
            accessToken: string;
            refreshToken: string;
        }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });

        return {
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresIn: 3600,
            user: {
                id: 'unknown',
                email,
                orgs: [],
            },
        };
    }

    async refresh(refreshToken: string): Promise<AuthResponse> {
        return this.requester<AuthResponse>('/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken }),
        });
    }

    async logout(accessToken: string): Promise<void> {
        await this.requester<void>('/auth/logout', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
    }

    async generateCIToken(accessToken: string): Promise<string> {
        const response = await this.requester<{ token: string }>(
            '/auth/ci-token',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            },
        );
        return response.token;
    }

    async verify(
        accessToken: string,
    ): Promise<{ valid: boolean; user?: UserInfo }> {
        if (!accessToken || !accessToken.startsWith('eyJ')) {
            return { valid: false };
        }

        try {
            const parts = accessToken.split('.');
            if (parts.length !== 3) {
                return { valid: false };
            }

            const payload = JSON.parse(
                Buffer.from(parts[1], 'base64').toString(),
            );

            if (payload.exp && payload.exp * 1000 < Date.now()) {
                return { valid: false };
            }

            return {
                valid: true,
                user: {
                    id: payload.sub || 'unknown',
                    email: payload.email || 'unknown',
                    orgs: [],
                },
            };
        } catch {
            return { valid: false };
        }
    }
}

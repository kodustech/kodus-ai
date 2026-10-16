import {
    Inject,
    Injectable,
    InternalServerErrorException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import axios from 'axios';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

import { INTEGRATION_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';
import { createLogger } from '@libs/core/log/logger';
import { IAuthService } from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    AUTH_REPOSITORY_TOKEN,
    IAuthRepository,
} from '@libs/identity/domain/auth/contracts/auth.repository.contracts';
import {
    IUserRepository,
    USER_REPOSITORY_TOKEN,
} from '@libs/identity/domain/user/contracts/user.repository.contract';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { UserEntity } from '@libs/identity/domain/user/entities/user.entity';
import { AuthProvider } from '@libs/core/domain/enums';
import { TeamMemberEntity } from '@libs/organization/domain/teamMembers/entities/teamMember.entity';
import {
    JWT,
    TokenResponse,
} from '@libs/core/infrastructure/config/types/jwt/jwt';
import { mapSimpleEntityToModel } from '@libs/core/infrastructure/repositories/mappers';
import { UserModel } from '../../repositories/schemas/user.model';
import { getExpiryDate } from '@libs/common/utils/transforms/date';
import { IAuth } from '@libs/identity/domain/auth/interfaces/auth.interface';

@Injectable()
export class AuthService implements IAuthService {
    protected jwtConfig: JWT;

    private readonly logger = createLogger(AuthService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly jwtService: JwtService,
        @Inject(AUTH_REPOSITORY_TOKEN)
        private readonly authRepository: IAuthRepository,
        @Inject(USER_REPOSITORY_TOKEN)
        private readonly userRepository: IUserRepository,
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMemberService: ITeamMemberService,
    ) {
        this.jwtConfig = this.configService.get<JWT>('jwtConfig');
    }

    async validateUser(
        userEntity: Partial<IUser>,
    ): Promise<Partial<IUser>> | undefined {
        const userLogged = await this.userRepository.getLoginData(
            userEntity.email,
        );

        return userLogged;
    }

    async login(
        userEntity: Partial<UserEntity>,
        authProvider: AuthProvider,
        authDetails?: any,
    ): Promise<any> {
        const teamMember = await this.teamMemberService.findOne({
            user: { uuid: userEntity?.uuid },
            organization: { uuid: userEntity?.organization?.uuid },
        });

        const tokens = await this.createToken(userEntity, teamMember);

        await this.createAuth(userEntity, tokens, authProvider, authDetails);

        return tokens;
    }

    async logout(refreshToken: string): Promise<any> {
        try {
            const refreshTokenAuth = await this.authRepository.findRefreshToken(
                {
                    refreshToken: refreshToken,
                },
            );

            if (refreshTokenAuth) {
                await this.authRepository.updateRefreshToken({
                    ...refreshTokenAuth,
                    used: true,
                });
            }

            return refreshTokenAuth;
        } catch (error) {
            // Never log the refresh token itself (it's a bearer secret) —
            // only the failure, via the structured logger with redaction.
            this.logger.error({
                message: 'Failed to invalidate refresh token on logout',
                context: AuthService.name,
                error,
            });
        }
    }

    async refreshToken(oldRefreshToken: string) {
        try {
            const payload = this.verifyToken(oldRefreshToken);

            const refreshTokenAuth =
                await this.getStoredRefreshToken(oldRefreshToken);

            this.validateRefreshToken(refreshTokenAuth);

            const userEntity = await this.userRepository.findOne({
                uuid: payload.sub,
            });

            const authDetails = refreshTokenAuth.authDetails;

            const teamMember = await this.teamMemberService.findOne({
                user: { uuid: userEntity?.uuid },
                organization: { uuid: userEntity?.organization?.uuid },
            });

            const tokens = await this.createToken(userEntity, teamMember);

            await this.markTokenAsUsed(refreshTokenAuth);
            await this.createAuth(
                userEntity,
                tokens,
                refreshTokenAuth.authProvider,
                authDetails,
            );

            return tokens;
        } catch (error) {
            throw new UnauthorizedException(
                'Refresh token is invalid or has expired',
                error,
            );
        }
    }

    async createForgotPassToken(uuid: string, email: string) {
        try {
            const user = await this.validateUser({
                email,
            });
            if (!user || !user.uuid) {
                throw new UnauthorizedException('api.users.unauthorized');
            }
            if (user.uuid !== uuid) {
                throw new UnauthorizedException(
                    'User ID does not match the provided email.',
                );
            }
            const token = await this.jwtService.signAsync(
                { uuid, email },
                {
                    secret: this.jwtConfig.secret,
                    expiresIn: '24h',
                },
            );
            return token;
        } catch (e) {
            this.logger.error({
                message: 'Failed to create email token',
                context: AuthService.name,
                metadata: {
                    uuid,
                    email,
                },
                error: e,
            });
            throw new InternalServerErrorException('Failed to create token');
        }
    }
    async verifyForgotPassToken(token: string) {
        try {
            return this.jwtService.verify(token, {
                secret: this.jwtConfig.secret,
            });
        } catch (error) {
            throw new UnauthorizedException(
                'Reset password token is invalid or has expired',
                error,
            );
        }
    }

    async createEmailToken(uuid: string, email: string): Promise<string> {
        try {
            const user = await this.validateUser({
                email,
            });
            if (!user || !user.uuid) {
                throw new UnauthorizedException('api.users.unauthorized');
            }
            if (user.uuid !== uuid) {
                throw new UnauthorizedException(
                    'User ID does not match the provided email.',
                );
            }
            const token = await this.jwtService.signAsync(
                { uuid, email },
                {
                    secret: this.jwtConfig.secret,
                    expiresIn: '24h',
                },
            );
            return token;
        } catch (e) {
            this.logger.error({
                message: 'Failed to generate email confirmation token',
                context: AuthService.name,
                metadata: {
                    uuid,
                    email,
                },
                error: e,
            });
            throw new InternalServerErrorException('Failed to create token');
        }
    }

    async verifyEmailToken(token: string): Promise<any> {
        try {
            return this.jwtService.verify(token, {
                secret: this.jwtConfig.secret,
            });
        } catch (e) {
            this.logger.error({
                message: 'Email token verification failed',
                context: AuthService.name,
                error: e,
            });
            throw new UnauthorizedException(
                'Email token is invalid or has expired',
            );
        }
    }

    private async createToken(
        user: Partial<UserEntity>,
        teamMember?: Partial<TeamMemberEntity>,
    ): Promise<TokenResponse> {
        try {
            const payload = {
                email: user.email,
                role: user.role,
                teamRole: teamMember?.teamRole,
                status: user.status,
                sub: user.uuid,
                organizationId: user.organization.uuid,
                iss: 'kodus-orchestrator',
                aud: 'web',
            };

            const access_token = await this.jwtService.signAsync(payload, {
                secret: this.jwtConfig.secret,
                expiresIn: this.jwtConfig.expiresIn,
            });

            const refresh_token = await this.jwtService.signAsync(payload, {
                secret: this.jwtConfig.refreshSecret,
                expiresIn: this.jwtConfig.refreshExpiresIn,
            });

            return {
                accessToken: access_token,
                refreshToken: refresh_token,
            };
        } catch (error) {
            throw new UnauthorizedException('Login is invalid', error);
        }
    }

    async createHelpdeskToken(user: Partial<IUser>): Promise<string> {
        const privateKey = this.jwtConfig.helpdeskPrivateKey;

        if (!privateKey) {
            throw new InternalServerErrorException(
                'API_JWT_PRIVATE_KEY is not configured',
            );
        }

        const payload = { sub: user.uuid };

        return this.jwtService.sign(payload, {
            algorithm: 'RS256',
            secret: privateKey,
            issuer: 'kodus-ai',
            audience: 'kodus-helpdesk',
            expiresIn: '5m',
        } as any);
    }

    private async createAuth(
        userEntity: Partial<IUser>,
        tokens: TokenResponse,
        authProvider: AuthProvider,
        authDetails?: any,
    ): Promise<void> {
        try {
            const uuid = uuidv4();

            const userModel = mapSimpleEntityToModel(userEntity, UserModel);

            const expiryDate = getExpiryDate(this.jwtConfig.refreshExpiresIn);

            if (authProvider === AuthProvider.CREDENTIALS) {
                authDetails = {
                    refreshToken: tokens.refreshToken,
                    expiresAt: expiryDate,
                };
            }

            const tokenEntity: IAuth = {
                uuid: uuid,
                user: userModel,
                refreshToken: tokens.refreshToken,
                used: false,
                expiryDate: expiryDate,
                authDetails,
                authProvider,
            };

            await this.authRepository.saveRefreshToken({
                ...tokenEntity,
            });
        } catch (error) {
            // Do NOT rethrow: the caller already holds valid tokens and login
            // should still succeed. But this MUST be visible — a failed
            // persist means the refresh token was never stored, so the user's
            // NEXT refresh will fail (forcing a re-login). Surface it loudly
            // instead of swallowing to stdout. Log identity, never the token.
            this.logger.error({
                message:
                    'Failed to persist refresh token after login — token issued but not stored; subsequent refresh will fail',
                context: AuthService.name,
                metadata: {
                    userUuid: userEntity?.uuid,
                    authProvider,
                },
                error,
            });
        }
    }

    private verifyToken(token: string) {
        try {
            return this.jwtService.verify(token, {
                secret: this.jwtConfig.refreshSecret,
            });
        } catch (e) {
            // Token value is a secret — log only the verification failure.
            this.logger.error({
                message: 'Refresh token verification failed',
                context: AuthService.name,
                error: e,
            });
            throw new UnauthorizedException(
                'Refresh token is invalid or has expired',
            );
        }
    }

    private async getStoredRefreshToken(token: string) {
        return await this.authRepository.findRefreshToken({
            refreshToken: token,
        });
    }

    private validateRefreshToken(refreshTokenAuth: any) {
        if (
            !refreshTokenAuth ||
            refreshTokenAuth.used ||
            new Date() > refreshTokenAuth.expiry_date
        ) {
            throw new UnauthorizedException(
                'Refresh token is invalid or has expired',
            );
        }
    }

    private async markTokenAsUsed(refreshTokenAuth: any) {
        await this.authRepository.updateRefreshToken({
            ...refreshTokenAuth,
            used: true,
        });
    }

    async hashPassword(password: string, salt: number): Promise<string> {
        return await bcrypt.hash(password, salt);
    }

    async match(enteredPassword: string, dbPassword: string): Promise<boolean> {
        return await bcrypt.compare(enteredPassword, dbPassword);
    }

    /**
     * Resolve the identity an OAuth provider vouches for, by calling the
     * provider's own API with the access token the browser obtained during
     * the OAuth handshake. This is the authentication step the OAuth login
     * path was missing: without it, `/auth/oauth` trusted a client-supplied
     * email and issued a JWT for any account (GHSA-95hw-cx5j-2pg8). The caller
     * must use the returned email — not any email from the request body — as
     * the account identity. Any failure is surfaced as Unauthorized without
     * leaking provider detail.
     */
    async verifyOAuthProviderEmail(
        authProvider: AuthProvider,
        accessToken: string,
    ): Promise<{ email: string; name?: string }> {
        if (!accessToken || typeof accessToken !== 'string') {
            throw new UnauthorizedException('Missing OAuth provider token');
        }

        try {
            switch (authProvider) {
                case AuthProvider.GITHUB:
                    return await this.verifyGithubToken(accessToken);
                case AuthProvider.GITLAB:
                    return await this.verifyGitlabToken(accessToken);
                case AuthProvider.GOOGLE:
                    return await this.verifyGoogleToken(accessToken);
                default:
                    throw new UnauthorizedException(
                        'Unsupported OAuth provider',
                    );
            }
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                throw error;
            }
            // Network error, non-2xx, malformed body — never trust the token.
            throw new UnauthorizedException(
                'Could not verify OAuth provider token',
            );
        }
    }

    private async verifyGithubToken(
        accessToken: string,
    ): Promise<{ email: string; name?: string }> {
        const baseUrl = 'https://api.github.com';
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'kodus-auth',
        };

        const profile = await axios.get(`${baseUrl}/user`, {
            headers,
            timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
        });

        // GitHub's /user `email` is the PUBLIC, user-settable, UNVERIFIED
        // profile email. Trusting it lets a token that cannot read verified
        // emails (no `user:email` scope, or a failed /user/emails call) set the
        // public email to a victim's address and impersonate that account
        // (GHSA-95hw-cx5j-2pg8). Only an address confirmed by /user/emails is
        // acceptable — never seed the identity from the profile email alone.
        const profileEmail: string | undefined = profile.data?.email ?? undefined;
        let email: string | undefined;
        try {
            const emails = await axios.get(`${baseUrl}/user/emails`, {
                headers,
                timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
            });
            const list: Array<{
                email: string;
                primary: boolean;
                verified: boolean;
            }> = Array.isArray(emails.data) ? emails.data : [];
            const verified = list.filter((e) => e.verified);
            // Keep the account's existing identity. The web historically keyed
            // the account on GitHub's public profile email (NextAuth
            // `user.email`), so when that address is itself verified, return it
            // as-is — this is still the GHSA-95hw fix because the profile email
            // is only trusted once it appears in the verified list. Otherwise
            // fall back to the primary verified address, then any verified one.
            const profileVerified =
                !!profileEmail &&
                verified.some(
                    (e) => e.email.toLowerCase() === profileEmail.toLowerCase(),
                );
            email = profileVerified
                ? profileEmail
                : (verified.find((e) => e.primary) ?? verified[0])?.email;
        } catch (error) {
            // A degradation, not a fatal error — but we must not fall back to
            // the unverified profile email, so the login is rejected below.
            // Log the sanitized reason only; never the token or the raw axios
            // error, whose config.headers would leak the bearer token.
            this.logger.warn({
                message:
                    'GitHub /user/emails lookup failed; rejecting OAuth login (no verified email)',
                context: AuthService.name,
                metadata: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }

        if (!email) {
            throw new UnauthorizedException(
                'GitHub token has no verified email',
            );
        }

        // Return the address exactly as the provider stores it — do not
        // lower-case it. `getLoginData` resolves the account case-insensitively
        // but prefers an exact-case match, so preserving the casing keeps the
        // user on their own row.
        return {
            email,
            name: profile.data?.name || profile.data?.login,
        };
    }

    private async verifyGitlabToken(
        accessToken: string,
    ): Promise<{ email: string; name?: string }> {
        // A self-hosted install points the web at its own GitLab through
        // WEB_GITLAB_OAUTH_URL (apps/web/src/core/config/auth.ts); honor the
        // same variable here so the token is validated against that instance.
        // API_GITLAB_TOKEN_URL is the legacy/back-compat fallback and ships
        // empty, which would otherwise send every self-hosted login to
        // gitlab.com and 401.
        const origin = new URL(
            process.env.WEB_GITLAB_OAUTH_URL ||
                process.env.API_GITLAB_TOKEN_URL ||
                'https://gitlab.com',
        ).origin;

        const profile = await axios.get(`${origin}/api/v4/user`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
        });

        const email: string | undefined = profile.data?.email ?? undefined;
        if (!email) {
            throw new UnauthorizedException(
                'GitLab token has no verified email',
            );
        }

        return {
            email,
            name: profile.data?.name || profile.data?.username,
        };
    }

    private async verifyGoogleToken(
        accessToken: string,
    ): Promise<{ email: string; name?: string }> {
        const profile = await axios.get(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
            },
        );

        const email: string | undefined = profile.data?.email ?? undefined;
        // Google marks unverified addresses; never accept one.
        const verified =
            profile.data?.email_verified === true ||
            profile.data?.email_verified === 'true';
        if (!email || !verified) {
            throw new UnauthorizedException(
                'Google token has no verified email',
            );
        }

        return { email, name: profile.data?.name };
    }

    private async refreshThirdPartyToken(
        refreshToken: string,
        authProvider: AuthProvider,
    ): Promise<
        TokenResponse & {
            refreshTokenExpiresAt: number;
        }
    > {
        let url: string;
        let clientId: string;
        let clientSecret: string;

        switch (authProvider) {
            case AuthProvider.GOOGLE:
                url = 'https://oauth2.googleapis.com/token';
                clientId = process.env.API_GOOGLE_CLIENT_ID;
                clientSecret = process.env.API_GOOGLE_CLIENT_SECRET;
                break;
            case AuthProvider.GITHUB:
                url = 'https://github.com/login/oauth/access_token';
                clientId = process.env.GLOBAL_GITHUB_CLIENT_ID;
                clientSecret = process.env.API_GITHUB_CLIENT_SECRET;
                break;
            case AuthProvider.GITLAB:
                // Same instance the login flow validated against
                // (WEB_GITLAB_OAUTH_URL); its token endpoint is <origin>/oauth/token.
                url = process.env.WEB_GITLAB_OAUTH_URL
                    ? `${new URL(process.env.WEB_GITLAB_OAUTH_URL).origin}/oauth/token`
                    : process.env.API_GITLAB_TOKEN_URL ||
                      'https://gitlab.com/oauth/token';
                clientId = process.env.GLOBAL_GITLAB_CLIENT_ID;
                clientSecret = process.env.GLOBAL_GITLAB_CLIENT_SECRET;
                break;
            default:
                throw new UnauthorizedException('Invalid auth provider');
        }

        type RefreshResponse = {
            refresh_token: string;
            access_token: string;
            expires_at: number;
        };

        const response = await axios.post(
            url,
            {
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
            },
        );

        if (!response || response.status !== 200) {
            throw new UnauthorizedException(
                `Error refreshing third party token from ${authProvider}`,
            );
        }

        const data = JSON.parse(response.data) as RefreshResponse;

        if (!data.refresh_token || !data.access_token || !data.expires_at) {
            throw new UnauthorizedException(
                `Invalid response from ${authProvider} token refresh`,
            );
        }

        return {
            refreshToken: data.refresh_token,
            accessToken: data.access_token,
            refreshTokenExpiresAt: data.expires_at,
        };
    }
}

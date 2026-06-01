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

import { createLogger } from '@kodus/flow';
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
            console.log(error);
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
            console.log(error);
        }
    }

    private verifyToken(token: string) {
        try {
            return this.jwtService.verify(token, {
                secret: this.jwtConfig.refreshSecret,
            });
        } catch (e) {
            console.log(e);
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
                url =
                    process.env.API_GITLAB_TOKEN_URL ||
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

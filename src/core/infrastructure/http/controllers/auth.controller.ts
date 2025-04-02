import { LoginUseCase } from '@/core/application/use-cases/auth/login.use-case';
import { LogoutUseCase } from '@/core/application/use-cases/auth/logout.use-case';
import { RefreshTokenUseCase } from '@/core/application/use-cases/auth/refresh-toke.use-case';
import { CreateOrganizationUseCase } from '@/core/application/use-cases/organization/create.use-case';
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CreateUserOrganizationDto } from '../dtos/create-user-organization.dto';
import { OAuthLoginUseCase } from '@/core/application/use-cases/auth/oauth-login.use-case';
import { CreateUserOrganizationOAuthDto } from '../dtos/create-user-organization-oauth.dto';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly loginUseCase: LoginUseCase,
        private readonly refreshTokenUseCase: RefreshTokenUseCase,
        private readonly logoutUseCase: LogoutUseCase,
        private readonly createOrganizationUseCase: CreateOrganizationUseCase,
        private readonly oAuthLoginUseCase: OAuthLoginUseCase,
    ) {}

    @Post('login')
    async login(@Body() body: { email: string; password: string }) {
        return await this.loginUseCase.execute(body.email, body.password);
    }

    @Post('logout')
    async logout(@Body() body: { refreshToken: string }) {
        return await this.logoutUseCase.execute(body.refreshToken);
    }

    @Post('refresh')
    async refresh(@Body() body: { refreshToken: string }) {
        return await this.refreshTokenUseCase.execute(body.refreshToken);
    }

    @Post('signUp')
    async signUp(@Body() body: CreateUserOrganizationDto) {
        const { name, email, password } = body;

        return await this.createOrganizationUseCase.execute(
            { name },
            {
                email,
                password,
            },
        );
    }

    @Post('oauth')
    async oAuth(@Body() body: CreateUserOrganizationOAuthDto) {
        const { name, email, refreshToken, authProvider } = body;

        return await this.oAuthLoginUseCase.execute(
            name,
            email,
            refreshToken,
            authProvider,
        );
    }
}

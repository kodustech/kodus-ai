import { LoginUseCase } from '@/core/application/use-cases/auth/login.use-case';
import { LogoutUseCase } from '@/core/application/use-cases/auth/logout.use-case';
import { RefreshTokenUseCase } from '@/core/application/use-cases/auth/refresh-toke.use-case';
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SignUpDTO } from '../dtos/create-user-organization.dto';
import { OAuthLoginUseCase } from '@/core/application/use-cases/auth/oauth-login.use-case';
import { CreateUserOrganizationOAuthDto } from '../dtos/create-user-organization-oauth.dto';
import { ForgotPasswordUseCase } from '@/core/application/use-cases/auth/forgotPasswordUseCase';
import { ResetPasswordUseCase } from '@/core/application/use-cases/auth/resetPasswordUseCase';
import { SignUpUseCase } from '@/core/application/use-cases/auth/signup.use-case';
import { ConfirmEmailUseCase } from '@/core/application/use-cases/auth/confirm-email.use-case';
import { ResendEmailUseCase } from '@/core/application/use-cases/auth/resend-email.use-case';

import { CheckSSOUseCase } from '@/core/application/use-cases/auth/checkSsoUseCase';
import { SSOLoginUseCase } from '@/core/application/use-cases/auth/ssoLoginUseCase';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly loginUseCase: LoginUseCase,
        private readonly refreshTokenUseCase: RefreshTokenUseCase,
        private readonly logoutUseCase: LogoutUseCase,
        private readonly signUpUseCase: SignUpUseCase,
        private readonly oAuthLoginUseCase: OAuthLoginUseCase,
        private readonly forgotPasswordUseCase: ForgotPasswordUseCase,
        private readonly resetPasswordUseCase: ResetPasswordUseCase,
        private readonly confirmEmailUseCase: ConfirmEmailUseCase,
        private readonly resendEmailUseCase: ResendEmailUseCase,
        private readonly checkSSOUseCase: CheckSSOUseCase,
        private readonly ssoLoginUseCase: SSOLoginUseCase,
    ) { }

    @Post('sso/check')
    async checkSSO(@Body() body: { email: string }) {
        return await this.checkSSOUseCase.execute(body.email);
    }

    @Get('sso/callback')
    async ssoCallback(
        @Query('code') code: string,
        @Query('state') state: string,
    ) {
        return await this.ssoLoginUseCase.execute(code, state);
    }

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
    async signUp(@Body() body: SignUpDTO) {
        return await this.signUpUseCase.execute(body);
    }

    @Post('forgot-password')
    async forgotPassword(@Body() body: { email: string }) {
        return await this.forgotPasswordUseCase.execute(body.email);
    }
    @Post('reset-password')
    async resetPassword(@Body() body: { token: string; newPassword: string }) {
        return await this.resetPasswordUseCase.execute(
            body.token,
            body.newPassword,
        );
    }

    @Post('confirm-email')
    async confirmEmail(@Body() body: { token: string }) {
        return await this.confirmEmailUseCase.execute(body.token);
    }

    @Post('resend-email')
    async resendEmail(@Body() body: { email: string }) {
        return await this.resendEmailUseCase.execute(body.email);
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

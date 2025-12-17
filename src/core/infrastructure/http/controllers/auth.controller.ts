import { ConfirmEmailUseCase } from '@/core/application/use-cases/auth/confirm-email.use-case';
import { ForgotPasswordUseCase } from '@/core/application/use-cases/auth/forgotPasswordUseCase';
import { LoginUseCase } from '@/core/application/use-cases/auth/login.use-case';
import { LogoutUseCase } from '@/core/application/use-cases/auth/logout.use-case';
import { OAuthLoginUseCase } from '@/core/application/use-cases/auth/oauth-login.use-case';
import { RefreshTokenUseCase } from '@/core/application/use-cases/auth/refresh-toke.use-case';
import { ResendEmailUseCase } from '@/core/application/use-cases/auth/resend-email.use-case';
import { ResetPasswordUseCase } from '@/core/application/use-cases/auth/resetPasswordUseCase';
import { SignUpUseCase } from '@/core/application/use-cases/auth/signup.use-case';
import { SSOCheckUseCase } from '@/core/application/use-cases/auth/sso-check.use-case';
import { SSOLoginUseCase } from '@/core/application/use-cases/auth/sso-login.use-case';
import {
    Body,
    Controller,
    Get,
    Param,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { CreateUserOrganizationOAuthDto } from '../dtos/create-user-organization-oauth.dto';
import { SignUpDTO } from '../dtos/create-user-organization.dto';

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
        private readonly ssoLoginUseCase: SSOLoginUseCase,
        private readonly ssoCheckUseCase: SSOCheckUseCase,
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

    @Get('sso/check')
    async checkSSO(@Query('domain') domain: string) {
        return await this.ssoCheckUseCase.execute(domain);
    }

    @Get('sso/login/:organizationId')
    @UseGuards(AuthGuard('saml'))
    async ssoLogin() {
        // Handled in the guard
    }

    @Post('sso/saml/callback/:organizationId')
    @UseGuards(AuthGuard('saml'))
    async ssoCallback(
        @Req() req: Request,
        @Res() res: Response,
        @Param('organizationId') organizationId: string,
    ) {
        const { accessToken, refreshToken } =
            await this.ssoLoginUseCase.execute(req.user, organizationId);

        const frontendUrl = process.env.API_FRONTEND_URL;

        if (!frontendUrl) {
            throw new Error('Frontend URL not found');
        }

        const payload = JSON.stringify({ accessToken, refreshToken });

        res.cookie('sso_handoff', payload, {
            httpOnly: false,
            secure: process.env.API_NODE_ENV !== 'development',
            sameSite: 'lax',
            path: '/',
            maxAge: 15 * 1000,
            domain:
                process.env.API_NODE_ENV !== 'development'
                    ? '.kodus.io'
                    : undefined,
        });

        return res.redirect(`${frontendUrl}/sso-callback`);
    }
}

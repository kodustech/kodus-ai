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
import { Request, Response } from 'express';

import { deriveSsoCookieDomain } from '../utils/derive-sso-cookie-domain';
import { ConfirmEmailUseCase } from '@libs/identity/application/use-cases/auth/confirm-email.use-case';
import { CreateHelpdeskTokenUseCase } from '@libs/identity/application/use-cases/auth/create-helpdesk-token.use-case';
import { ForgotPasswordUseCase } from '@libs/identity/application/use-cases/auth/forgotPasswordUseCase';
import { LoginUseCase } from '@libs/identity/application/use-cases/auth/login.use-case';
import { LogoutUseCase } from '@libs/identity/application/use-cases/auth/logout.use-case';
import { OAuthLoginUseCase } from '@libs/identity/application/use-cases/auth/oauth-login.use-case';
import { RefreshTokenUseCase } from '@libs/identity/application/use-cases/auth/refresh-toke.use-case';
import { ResendEmailUseCase } from '@libs/identity/application/use-cases/auth/resend-email.use-case';
import { ResetPasswordUseCase } from '@libs/identity/application/use-cases/auth/resetPasswordUseCase';
import { SignUpUseCase } from '@libs/identity/application/use-cases/auth/signup.use-case';

import { SSOCheckUseCase } from '@libs/ee/sso/use-cases/sso-check.use-case';
import { SSOLoginUseCase } from '@libs/ee/sso/use-cases/sso-login.use-case';
import { SamlAuthGuard } from '@libs/ee/sso/guards/saml-auth.guard';
import { SSOTestSessionService } from '@libs/ee/sso/services/sso-test-session.service';
import { mapSSOError } from '@libs/ee/sso/utils/sso-error.util';
import { SignUpDTO } from '@libs/identity/dtos/create-user-organization.dto';
import { CreateUserOrganizationOAuthDto } from '../dtos/create-user-organization-oauth.dto';
import {
    ApiBody,
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ConfirmEmailRequestDto,
    ForgotPasswordRequestDto,
    LoginRequestDto,
    LogoutRequestDto,
    RefreshTokenRequestDto,
    ResendEmailRequestDto,
    ResetPasswordRequestDto,
} from '../dtos/auth-requests.dto';
import {
    AuthLogoutResponseDto,
    AuthMessageResponseDto,
    AuthResetPasswordResponseDto,
    AuthSsoCheckResponseDto,
    AuthTokensResponseDto,
} from '../dtos/auth-response.dto';

@ApiTags('Auth')
@ApiStandardResponses()
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
        private readonly ssoTestSessionService: SSOTestSessionService,
        private readonly createHelpdeskTokenUseCase: CreateHelpdeskTokenUseCase,
    ) {}

    @Post('login')
    @Public()
    @ApiOperation({
        summary: 'Login',
        description: 'Authenticate a user and return access/refresh tokens.',
    })
    @ApiBody({ type: LoginRequestDto })
    @ApiCreatedResponse({ type: AuthTokensResponseDto })
    async login(@Body() body: { email: string; password: string }) {
        return await this.loginUseCase.execute(body.email, body.password);
    }

    @Post('logout')
    @ApiBearerAuth('jwt')
    @ApiOperation({
        summary: 'Logout',
        description: 'Invalidate a refresh token for the authenticated user.',
    })
    @ApiBody({ type: LogoutRequestDto })
    @ApiCreatedResponse({ type: AuthLogoutResponseDto })
    async logout(@Body() body: { refreshToken: string }) {
        return await this.logoutUseCase.execute(body.refreshToken);
    }

    @Post('refresh')
    @Public()
    @ApiOperation({
        summary: 'Refresh token',
        description: 'Exchange a refresh token for a new access token.',
    })
    @ApiBody({ type: RefreshTokenRequestDto })
    @ApiCreatedResponse({ type: AuthTokensResponseDto })
    async refresh(@Body() body: { refreshToken: string }) {
        return await this.refreshTokenUseCase.execute(body.refreshToken);
    }

    @Post('signUp')
    @Public()
    @ApiOperation({
        summary: 'Sign up',
        description: 'Create a user (and organization when applicable).',
    })
    async signUp(@Body() body: SignUpDTO) {
        return await this.signUpUseCase.execute(body);
    }

    @Post('forgot-password')
    @Public()
    @ApiOperation({
        summary: 'Request password reset',
        description: 'Send password reset instructions to the user email.',
    })
    @ApiBody({ type: ForgotPasswordRequestDto })
    @ApiCreatedResponse({ type: AuthMessageResponseDto })
    async forgotPassword(@Body() body: { email: string }) {
        return await this.forgotPasswordUseCase.execute(body.email);
    }
    @Post('reset-password')
    @Public()
    @ApiOperation({
        summary: 'Reset password',
        description: 'Reset a user password using a valid reset token.',
    })
    @ApiBody({ type: ResetPasswordRequestDto })
    @ApiCreatedResponse({ type: AuthResetPasswordResponseDto })
    async resetPassword(@Body() body: { token: string; newPassword: string }) {
        return await this.resetPasswordUseCase.execute(
            body.token,
            body.newPassword,
        );
    }

    @Post('confirm-email')
    @Public()
    @ApiOperation({
        summary: 'Confirm email',
        description: 'Confirm a user email using a verification token.',
    })
    @ApiBody({ type: ConfirmEmailRequestDto })
    @ApiCreatedResponse({ type: AuthMessageResponseDto })
    async confirmEmail(@Body() body: { token: string }) {
        return await this.confirmEmailUseCase.execute(body.token);
    }

    @Post('resend-email')
    @Public()
    @ApiOperation({
        summary: 'Resend email confirmation',
        description: 'Resend the email confirmation link.',
    })
    @ApiBody({ type: ResendEmailRequestDto })
    @ApiCreatedResponse({ type: AuthMessageResponseDto })
    async resendEmail(@Body() body: { email: string }) {
        return await this.resendEmailUseCase.execute(body.email);
    }

    @Post('oauth')
    @Public()
    @ApiOperation({
        summary: 'OAuth login',
        description:
            'Login via OAuth provider and return access/refresh tokens.',
    })
    @ApiCreatedResponse({ type: AuthTokensResponseDto })
    async oAuth(@Body() body: CreateUserOrganizationOAuthDto) {
        const { name, email, refreshToken, authProvider } = body;

        return await this.oAuthLoginUseCase.execute(
            name,
            email,
            refreshToken,
            authProvider,
        );
    }

    @Get('helpdesk-token')
    @ApiBearerAuth('jwt')
    @ApiOperation({
        summary: 'Generate helpdesk SSO token',
        description:
            'Generate a short-lived RS256 token for authenticating with kodus-helpdesk.',
    })
    @ApiOkResponse({
        schema: {
            type: 'object',
            properties: { token: { type: 'string' } },
        },
    })
    async getHelpdeskToken(@Req() req: Request) {
        return this.createHelpdeskTokenUseCase.execute(
            (req as any).user,
        );
    }

    @Get('sso/check')
    @Public()
    @ApiOperation({
        summary: 'Check SSO',
        description: 'Check if SSO is enabled for a given email domain.',
    })
    @ApiOkResponse({ type: AuthSsoCheckResponseDto })
    async checkSSO(@Query('domain') domain: string) {
        return await this.ssoCheckUseCase.execute(domain);
    }

    @Get('sso/login/:organizationId')
    @Public()
    @UseGuards(SamlAuthGuard)
    @ApiParam({ name: 'organizationId', required: true })
    @ApiOperation({
        summary: 'SSO login',
        description: 'Initiate SAML SSO login for the organization.',
    })
    async ssoLogin() {
        // Handled in the guard
    }

    @Post('sso/saml/callback/:organizationId')
    @Public()
    @UseGuards(SamlAuthGuard)
    @ApiParam({ name: 'organizationId', required: true })
    @ApiOperation({
        summary: 'SSO callback',
        description: 'SAML callback endpoint that finalizes SSO login.',
    })
    async ssoCallback(
        @Req() req: Request,
        @Res() res: Response,
        @Param('organizationId') organizationId: string,
    ) {
        const frontendUrl = process.env.API_FRONTEND_URL;
        const relayState =
            (req.body?.RelayState as string) ||
            (req.query?.RelayState as string);

        if (!frontendUrl) {
            throw new Error('Frontend URL not found');
        }

        try {
            if (relayState) {
                const testSession =
                    await this.ssoTestSessionService.getSession(relayState);

                if (
                    testSession &&
                    testSession.organizationId === organizationId
                ) {
                    await this.ssoTestSessionService.markSessionSuccess(
                        relayState,
                    );

                    return res.redirect(
                        `${frontendUrl}/organization/sso?ssoTestSessionId=${encodeURIComponent(relayState)}`,
                    );
                }
            }

            const { accessToken, refreshToken } =
                await this.ssoLoginUseCase.execute(req.user, organizationId);

            const payload = JSON.stringify({ accessToken, refreshToken });

            const cookieDomain = deriveSsoCookieDomain({
                apiHost: req.get('host')?.split(':')[0] ?? '',
                frontendUrl,
                nodeEnv: process.env.API_NODE_ENV,
            });

            res.cookie('sso_handoff', payload, {
                httpOnly: false,
                secure: process.env.API_NODE_ENV !== 'development',
                sameSite: 'lax',
                path: '/',
                maxAge: 15 * 1000,
                domain: cookieDomain,
            });

            return res.redirect(`${frontendUrl}/sso-callback`);
        } catch (error) {
            const mappedError = mapSSOError(error);

            if (relayState) {
                await this.ssoTestSessionService.markSessionFailed(relayState, {
                    failureCode: mappedError.failureCode,
                    failureMessage: mappedError.message,
                });

                return res.redirect(
                    `${frontendUrl}/organization/sso?ssoTestSessionId=${encodeURIComponent(relayState)}`,
                );
            }

            const reasonMessage = encodeURIComponent(mappedError.message);

            return res.redirect(
                `${frontendUrl}/sign-in?reason=${mappedError.reasonCode}&reasonMessage=${reasonMessage}`,
            );
        }
    }
}

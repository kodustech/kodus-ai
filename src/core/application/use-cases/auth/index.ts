import { ConfirmEmailUseCase } from './confirm-email.use-case';
import { ForgotPasswordUseCase } from './forgotPasswordUseCase';
import { LoginUseCase } from './login.use-case';
import { LogoutUseCase } from './logout.use-case';
import { OAuthLoginUseCase } from './oauth-login.use-case';
import { RefreshTokenUseCase } from './refresh-toke.use-case';
import { ResendEmailUseCase } from './resend-email.use-case';
import { ResetPasswordUseCase } from './resetPasswordUseCase';
import { SignUpUseCase } from './signup.use-case';
import { SSOCheckUseCase } from './sso-check.use-case';
import { SSOLoginUseCase } from './sso-login.use-case';

export const UseCases = [
    LoginUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    OAuthLoginUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
    SignUpUseCase,
    ConfirmEmailUseCase,
    ResendEmailUseCase,
    SSOLoginUseCase,
    SSOCheckUseCase,
];

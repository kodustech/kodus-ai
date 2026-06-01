import { ConfirmEmailUseCase } from './confirm-email.use-case';
import { CreateHelpdeskTokenUseCase } from './create-helpdesk-token.use-case';
import { ForgotPasswordUseCase } from './forgotPasswordUseCase';
import { LoginUseCase } from './login.use-case';
import { LogoutUseCase } from './logout.use-case';
import { OAuthLoginUseCase } from './oauth-login.use-case';
import { RefreshTokenUseCase } from './refresh-toke.use-case';
import { ResendEmailUseCase } from './resend-email.use-case';
import { ResetPasswordUseCase } from './resetPasswordUseCase';
import { SignUpUseCase } from './signup.use-case';

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
    CreateHelpdeskTokenUseCase,
];

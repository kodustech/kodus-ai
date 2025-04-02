import { OAuthLoginUseCase } from './oauth-login.use-case';
import { LoginUseCase } from './login.use-case';
import { LogoutUseCase } from './logout.use-case';
import { RefreshTokenUseCase } from './refresh-toke.use-case';

export const UseCases = [
    LoginUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    OAuthLoginUseCase,
];

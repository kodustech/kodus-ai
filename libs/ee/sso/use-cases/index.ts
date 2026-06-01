import { CreateOrUpdateSSOConfigUseCase } from './create-or-update.use-case';
import { SSOCheckUseCase } from './sso-check.use-case';
import { SSOLoginUseCase } from './sso-login.use-case';
import { GetSSOConnectionTestResultUseCase } from './test-connection/get-sso-connection-test-result.use-case';
import { StartSSOConnectionTestUseCase } from './test-connection/start-sso-connection-test.use-case';

export const UseCases = [
    CreateOrUpdateSSOConfigUseCase,
    SSOCheckUseCase,
    SSOLoginUseCase,
    StartSSOConnectionTestUseCase,
    GetSSOConnectionTestResultUseCase,
];

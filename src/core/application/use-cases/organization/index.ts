import { GetOrganizationNameUseCase } from './get-organization-name';
import { GetOrganizationLanguageUseCase } from './get-organization-language.use-case';
import { GetOrganizationsByDomainUseCase } from './get-organizations-domain.use-case';
import { UpdateInfoOrganizationAndPhoneUseCase } from './update-infos.use-case';

export const UseCases = [
    GetOrganizationNameUseCase,
    GetOrganizationLanguageUseCase,
    UpdateInfoOrganizationAndPhoneUseCase,
    GetOrganizationsByDomainUseCase,
];

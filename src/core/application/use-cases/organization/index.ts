import { CreateOrganizationFromOAuthUseCase } from './create-from-oauth.use-case';
import { CreateOrganizationUseCase } from './create.use-case';
import { GetOrganizationNameUseCase } from './get-organization-name';
import { GetOrganizationNameByTenantUseCase } from './get-organization-name-by-tenant';
import { GetOrganizationTenantNameUseCase } from './get-organization-tenant-name';
import { GetWorkedThemesInWeekByTeams } from './get-workedThemesWeek';
import { UpdateInfoOrganizationAndPhoneUseCase } from './update-infos.use-case';

export const UseCases = [
    CreateOrganizationUseCase,
    GetOrganizationNameUseCase,
    GetOrganizationTenantNameUseCase,
    GetOrganizationNameByTenantUseCase,
    GetWorkedThemesInWeekByTeams,
    CreateOrganizationFromOAuthUseCase,
    UpdateInfoOrganizationAndPhoneUseCase,
];

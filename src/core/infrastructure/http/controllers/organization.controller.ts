import { GetOrganizationNameUseCase } from '@/core/application/use-cases/organization/get-organization-name';
import { GetOrganizationNameByTenantUseCase } from '@/core/application/use-cases/organization/get-organization-name-by-tenant';
import { GetOrganizationTenantNameUseCase } from '@/core/application/use-cases/organization/get-organization-tenant-name';
import { GetWorkedThemesInWeekByTeams } from '@/core/application/use-cases/organization/get-workedThemesWeek';
import { UpdateInfoOrganizationAndPhoneUseCase } from '@/core/application/use-cases/organization/update-infos.use-case';
import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { UpdateInfoOrganizationAndPhoneDto } from '../dtos/updateInfoOrgAndPhone.dto';

@Controller('organization')
export class OrganizationController {
    constructor(
        private readonly getOrganizationNameUseCase: GetOrganizationNameUseCase,
        private readonly getOrganizationTenantNameUseCase: GetOrganizationTenantNameUseCase,
        private readonly getOrganizationNameByTenantUseCase: GetOrganizationNameByTenantUseCase,
        private readonly getWorkedThemesInWeekByTeams: GetWorkedThemesInWeekByTeams,
        private readonly updateInfoOrganizationAndPhoneUseCase: UpdateInfoOrganizationAndPhoneUseCase,
    ) {}

    @Get('/name')
    public getOrganizationName() {
        return this.getOrganizationNameUseCase.execute();
    }

    @Get('/name-by-tenant')
    public getOrganizationNameByTenant(
        @Query('tenantName')
        tenantName: string,
    ) {
        return this.getOrganizationNameByTenantUseCase.execute(tenantName);
    }

    @Get('/tenant-name')
    public getOrganizationTenantName() {
        return this.getOrganizationTenantNameUseCase.execute();
    }

    @Get('/worked-themes')
    public async getTeamsWorkedThemes(
        @Query('teamId')
        teamId: string,
    ) {
        return await this.getWorkedThemesInWeekByTeams.execute(teamId);
    }

    @Patch('/update-infos')
    public async updateInfoOrganizationAndPhone(
        @Body() body: UpdateInfoOrganizationAndPhoneDto,
    ) {
        return await this.updateInfoOrganizationAndPhoneUseCase.execute(body);
    }
}

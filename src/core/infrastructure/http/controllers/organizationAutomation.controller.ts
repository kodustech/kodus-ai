import { GetOrganizationAutomationUseCase } from '@/core/application/use-cases/organizationAutomation/getOrganizationAutomationUseCase';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { OrganizationQueryDto } from '../dtos/organizationId-query.dto';
import { ActiveOrganizationAutomationsUseCase } from '@/core/application/use-cases/organizationAutomation/activeOrganizationAutomationsUseCase';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { RunOrganizationAutomationsUseCase } from '@/core/application/use-cases/organizationAutomation/run-organization-automations';

@Controller('organization-automation')
export class OrganizationAutomationController {
    constructor(
        private readonly getOrganizationAutomationUseCase: GetOrganizationAutomationUseCase,
        private readonly activeOrganizationAutomationUseCase: ActiveOrganizationAutomationsUseCase,
        private readonly runOrganizationAutomationsUseCase: RunOrganizationAutomationsUseCase,
    ) {}

    @Get('/')
    public async getOrganizationAutomations(
        @Query() query: OrganizationQueryDto,
    ) {
        return this.getOrganizationAutomationUseCase.execute(
            query.organizationId,
        );
    }

    @Post('/active-all')
    public async activeAllAutomations() {
        return await this.activeOrganizationAutomationUseCase.execute();
    }

    @Post('/run')
    public async runAutomation(
        @Body()
        body: {
            automationName: AutomationType;
            organizationId: string;
            channelId?: string;
            origin?: string;
        },
    ) {
        if (!Object.values(AutomationType).includes(body.automationName)) {
            throw new Error('Invalid automation type');
        }

        const originModded = body.origin ?? 'System';

        return await this.runOrganizationAutomationsUseCase.execute({
            ...body,
            origin: originModded,
        });
    }
}

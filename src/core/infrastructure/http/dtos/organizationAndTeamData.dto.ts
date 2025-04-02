import { IsOptional, IsString } from 'class-validator';

export class OrganizationAndTeamDataDto {
    @IsOptional()
    @IsString()
    teamId?: string;

    @IsOptional()
    @IsString()
    organizationId?: string;
}

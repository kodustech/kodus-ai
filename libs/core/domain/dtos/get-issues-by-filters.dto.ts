import { IsOptional, IsString, IsNumber } from 'class-validator';

import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GetIssuesByFiltersDto {
    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    title?: string;

    @IsOptional()
    @ApiPropertyOptional({
        type: String,
        enum: SeverityLevel,
        enumName: 'SeverityLevel',
    })
    severity?: SeverityLevel;

    @IsOptional()
    @ApiPropertyOptional({ enum: LabelType, enumName: 'LabelType' })
    category?: LabelType;

    @IsOptional()
    @ApiPropertyOptional({ enum: IssueStatus, enumName: 'IssueStatus' })
    status?: IssueStatus;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    organizationId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    repositoryName?: string;

    @IsOptional()
    @IsNumber()
    @ApiPropertyOptional({ type: Number })
    prNumber?: number;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    filePath?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    prAuthor?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    beforeAt?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    afterAt?: string;
}

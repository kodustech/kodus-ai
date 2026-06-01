import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangeStatusKodyRulesDTO {
    @IsOptional()
    @IsString()
    @ApiProperty({
        type: String,
        required: false,
        example: 'team_123',
    })
    teamId?: string;

    @IsArray()
    @IsString({ each: true })
    @ApiProperty({
        type: String,
        isArray: true,
        example: ['rule_123', 'rule_456'],
    })
    ruleIds: string[];

    @IsEnum(KodyRulesStatus)
    @ApiProperty({
        enum: KodyRulesStatus,
        enumName: 'KodyRulesStatus',
        example: KodyRulesStatus.ACTIVE,
    })
    status: KodyRulesStatus;
}

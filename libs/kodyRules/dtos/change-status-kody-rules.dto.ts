import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { IsArray, IsEnum, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangeStatusKodyRulesDTO {
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

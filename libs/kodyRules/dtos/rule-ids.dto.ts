import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class RuleIdsDto {
    @IsArray()
    @IsString({ each: true })
    @ApiProperty({
        type: String,
        isArray: true,
        example: ['rule_123', 'rule_456'],
    })
    ruleIds: string[];
}

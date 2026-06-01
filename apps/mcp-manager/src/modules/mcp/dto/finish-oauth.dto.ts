import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class FinishOAuthDto {
    @ApiProperty({ example: 'auth_code_123' })
    @IsString()
    code: string;

    @ApiProperty({ example: 'state_abc' })
    @IsString()
    state: string;

    @ApiProperty({ example: 'int_456' })
    @IsString()
    integrationId: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export { ErrorResponseDto } from './error-response.dto';

export class StringRecordDto {
    @ApiProperty({ example: 'Authorization' })
    @IsString()
    key: string;

    @ApiProperty({ example: 'Bearer <token>' })
    @IsString()
    value: string;
}

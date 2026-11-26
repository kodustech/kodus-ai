import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** More than any organization has members. */
const MAX_MEMBERS = 5000;

export class SetConnectionAccessDto {
    @ApiProperty({
        type: [String],
        description:
            'Every member who reads the connection; an empty list revokes all.',
    })
    @IsArray()
    @ArrayMaxSize(MAX_MEMBERS)
    @IsUUID('4', { each: true })
    userIds: string[];
}

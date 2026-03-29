import { IsEnum, IsOptional } from 'class-validator';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAnotherUserDto {
    @IsOptional()
    @IsEnum(STATUS)
    @ApiPropertyOptional({
        enum: STATUS,
        enumName: 'STATUS',
        example: STATUS.ACTIVE,
    })
    status?: STATUS;

    @IsOptional()
    @IsEnum(Role)
    @ApiPropertyOptional({ enum: Role, enumName: 'Role', example: Role.OWNER })
    role?: Role;
}

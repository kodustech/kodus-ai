import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class TeamQueryDto {
    @IsString()
    readonly teamId: string;
}

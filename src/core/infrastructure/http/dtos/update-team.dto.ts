import { IsString } from 'class-validator';

export class UpdateTeamDto {
    @IsString()
    teamName: string;

    @IsString()
    teamId: string;
}

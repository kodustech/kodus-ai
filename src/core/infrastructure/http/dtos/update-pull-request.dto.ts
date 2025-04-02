import { IsString } from 'class-validator';

export class updatePullRequestDto {
    @IsString()
    public organizationId: string;
}

import { IsString, MinLength } from 'class-validator';

export class CreateConversationDto {
    @IsString()
    @MinLength(3)
    public prompt: string;

    @IsString()
    public teamId: string;
}

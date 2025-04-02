import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateConversationTitleDto {
    @IsString()
    @IsNotEmpty({ message: 'Title should not be empty' })
    public title: string;
}

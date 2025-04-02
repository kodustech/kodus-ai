import { ISession } from '../../automation/interfaces/session.interface';
import { SenderType } from '../enum/SenderType';

export interface IConversation {
    uuid: string;
    title: string;
    type: SenderType;
    session?: ISession | Partial<ISession>;
    createdAt?: Date;
    updatedAt?: Date;
}

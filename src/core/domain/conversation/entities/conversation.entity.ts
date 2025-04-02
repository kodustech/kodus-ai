import { Entity } from '@/shared/domain/interfaces/entity';
import { IConversation } from '../interfaces/conversation.interface';
import { SenderType } from '../enum/SenderType';
import { ISession } from '../../automation/interfaces/session.interface';

export class ConversationEntity implements Entity<IConversation> {
    private _uuid: string;
    private _title: string;
    private _session: Partial<ISession>;
    private _type: SenderType;
    private _createdAt?: Date;
    private _updatedAt?: Date;

    private constructor(conversation: IConversation | Partial<IConversation>) {
        this._uuid = conversation.uuid;
        this._title = conversation.title;
        this._session = conversation.session;
        this._type = conversation.type;
        this._createdAt = conversation.createdAt;
        this._updatedAt = conversation.updatedAt;
    }

    public static create(
        conversation: IConversation | Partial<IConversation>,
    ): ConversationEntity {
        return new ConversationEntity(conversation);
    }

    public get type(): SenderType {
        return this._type;
    }

    public get uuid(): string {
        return this._uuid;
    }

    public get title(): string {
        return this._title;
    }

    public get session(): Partial<ISession> {
        return this._session;
    }

    public get createdAt(): Date | undefined {
        return this._createdAt;
    }

    public get updatedAt(): Date | undefined {
        return this._updatedAt;
    }

    public toObject(): IConversation {
        return {
            uuid: this._uuid,
            title: this._title,
            type: this._type,
            session: this._session,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }

    public toJson(): Partial<IConversation> {
        return {
            uuid: this._uuid,
            title: this._title,
            type: this._type,
            session: this._session,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }
}

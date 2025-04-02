import { IMemory, IMemoryMessage } from '../interfaces/memory.interface';

export class MemoryEntity implements IMemory {
    private _uuid: string;
    private _messages: IMemoryMessage[];

    constructor(memory: IMemory | Partial<IMemory>) {
        this._uuid = memory.uuid;
        this._messages = memory.messages;
    }

    static create(memory: IMemory | Partial<IMemory>): MemoryEntity {
        return new MemoryEntity(memory);
    }

    public get uuid(): string {
        return this.uuid;
    }

    public get messages(): IMemoryMessage[] {
        return this.messages;
    }
}

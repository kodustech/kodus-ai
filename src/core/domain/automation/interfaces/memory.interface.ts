export interface IMemoryMessage {
    type: string;
    data: { content: string };
    additional_kwargs: any;
}

export interface IMemory {
    uuid: string;
    messages: IMemoryMessage[];
}

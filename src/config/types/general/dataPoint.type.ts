export type PayloadItem = {
    narrativeEntityExtraction: any;
    questionNarrative: any;
};

export type DictionaryTransformResult = {
    payload: PayloadItem[];
    metaData: string[];
};

// Importe o módulo que você deseja mockar
import * as documentModule from '@/shared/utils/langchainCommon/document';
import * as jiraTransforms from '@/shared/utils/transforms/jira';
import * as jsonTransforms from '@/shared/utils/transforms/json';
import * as numberTransforms from '@/shared/utils/transforms/numbers';

export const mockGetOpenAI = (invokeMockImplementation) => {
    const openAIMock = {
        invoke: jest.fn().mockImplementation(invokeMockImplementation),
    };
    jest.spyOn(documentModule, 'getOpenAI').mockReturnValue(openAIMock);
    return openAIMock;
};

export const mockConvertToMarkdown = (markdownContent) => {
    jest.spyOn(jiraTransforms, 'convertToMarkdown').mockReturnValue(
        markdownContent,
    );
};

export const mockTryParseJSONObject = (parsedObject) => {
    jest.spyOn(jsonTransforms, 'tryParseJSONObject').mockImplementation(
        () => parsedObject,
    );
};

export const mockExtractNumberFromString = (returnValue) => {
    jest.spyOn(numberTransforms, 'extractNumberFromString').mockReturnValue(
        returnValue,
    );
};

export const restoreMocks = () => {
    jest.restoreAllMocks();
};

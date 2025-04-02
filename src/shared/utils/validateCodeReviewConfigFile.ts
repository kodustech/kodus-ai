import { KodusConfigFile } from '@/config/types/general/codeReview.type';
import * as codereviewConfigSchema from '@/shared/schemas/codereview.json';
import Ajv, { ErrorObject } from 'ajv';

import * as yaml from 'js-yaml';
import * as fs from 'node:fs';

interface IValidateKodusConfigFileReturn {
    isValidConfigFile: boolean;
    validationErrors?: ErrorObject<string, Record<string, any>, unknown>[];
    errorMessages?: string;
    isDeprecated?: boolean;
}

export default function validateKodusConfigFile(
    configFile: any,
): IValidateKodusConfigFileReturn {
    if (!configFile) {
        return {
            isValidConfigFile: false,
            errorMessages: 'Configuration file is null or undefined',
            isDeprecated: false,
            validationErrors: [],
        };
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(codereviewConfigSchema);

    let isDeprecated = false;

    const currentVersion = '1.2';

    const fileVersion = configFile.version
        ? configFile.version
        : currentVersion;

    // Backward compatibility handling
    if (fileVersion !== currentVersion) {
        isDeprecated = true;
        // // Handle version-specific updates
        // if (fileVersion === '0.9') {
        //     // Example: Migrate from version 0.9 to 1.0
        //     // Set default values for new properties
        //     configFile.newProperty = 'defaultValue'; // Example of adding a new property
        //     // Map old property names to new ones if necessary
        //     // configFile.newPropertyName = configFile.oldPropertyName;
        //     // delete configFile.oldPropertyName; // Remove old property if no longer needed
        // }
        // // Add more version checks as needed

        if (fileVersion === '1.0') {
            delete configFile.automaticPRMergingActive;
            configFile.pullRequestApprovalActive = false;
            configFile.isRequestChanges = false;
        }

        if (fileVersion === '1.1') {
            configFile.isRequestChanges = false;
        }
    }

    // Validate the configuration file
    if (validate(configFile)) {
        return { isValidConfigFile: true, validationErrors: [], isDeprecated };
    } else {
        const errorMessages = formatValidationErrors(validate.errors || []);
        return {
            isValidConfigFile: false,
            validationErrors: validate.errors,
            errorMessages: errorMessages,
            isDeprecated,
        };
    }
}

export function isParameterValidInConfigFile(
    parameterKey: string,
    errors: ErrorObject<string, Record<string, any>, unknown>[],
): boolean {
    const invalidParams = getInvalidParameterKeys(errors);
    return !invalidParams.includes(parameterKey);
}

export function getDefaultKodusConfigFile(): Omit<KodusConfigFile, 'version'> {
    const kodusConfigYMLfile = yaml.load(
        fs.readFileSync('default-kodus-config.yml', 'utf8'),
    ) as KodusConfigFile;

    const { version, ...kodusDefaultConfigFile } = kodusConfigYMLfile;

    return kodusDefaultConfigFile;
}

function formatValidationErrors(errors: ErrorObject[]): string {
    return errors
        .map((error) => {
            const { keyword, instancePath, schemaPath, params, message } =
                error;

            // Construct a detailed error message
            let errorMessage = `Error: ${message || 'Validation error'}`;
            errorMessage += `\n  Keyword: ${keyword}`;
            errorMessage += `\n  Instance Path: ${instancePath}`;
            errorMessage += `\n  Schema Path: ${schemaPath}`;

            // Include additional parameters if available
            if (params) {
                errorMessage += `\n  Params: ${JSON.stringify(params)}`;
            }

            return errorMessage;
        })
        .join('\n\n');
}

function getInvalidParameterKeys(
    errors: ErrorObject<string, Record<string, any>, unknown>[],
) {
    const invalidParams = new Set<string>(); // Use a Set to avoid duplicates

    if (errors) {
        errors.forEach((error) => {
            if (error.keyword === 'required') {
                // For 'required' errors, add the missing property name
                invalidParams.add(error.params.missingProperty);
            } else if (error.keyword === 'additionalProperties') {
                // For 'additionalProperties' errors, add the additional property name
                invalidParams.add(error.params.additionalProperty);
            } else if (
                error.keyword === 'maximum' ||
                error.keyword === 'exclusiveMaximum'
            ) {
                // For 'maximum' or 'exclusiveMaximum' errors, add the property name
                const lastPathPart = getLastPathPart(error.instancePath);
                if (lastPathPart) {
                    invalidParams.add(lastPathPart); // Add the last part if it exists
                }
            } else {
                // For other errors, extract the property name from instancePath
                const lastPathPart = getLastPathPart(error.instancePath);
                if (lastPathPart) {
                    invalidParams.add(lastPathPart); // Add the last part if it exists
                }
            }
        });
    }

    return Array.from(invalidParams); // Convert Set back to Array
}

function getLastPathPart(instancePath: string): string | null {
    const pathParts = instancePath.split('/').filter(Boolean);
    return pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
}

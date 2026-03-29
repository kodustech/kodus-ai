module.exports = function transformer(file, api) {
    const j = api.jscodeshift;
    const root = j(file.source);

    const loggerName = 'logger';

    // Helper: Create an object property { key: value }
    const buildProperty = (key, value) => {
        return j.objectProperty(j.identifier(key), value);
    };

    // Helper: Walk up the tree to find the function name
    const getFunctionName = (path) => {
        let current = path;
        while (current) {
            const node = current.node;

            // 1. Standard function: function myFunc() {}
            if (node.type === 'FunctionDeclaration' && node.id) {
                return node.id.name;
            }

            // 2. Class Method: class X { myMethod() {} }
            if (
                node.type === 'MethodDefinition' ||
                node.type === 'ClassMethod'
            ) {
                return node.key.name;
            }

            // 3. Arrow Function / Expression assigned to variable: const myFunc = () => {}
            if (
                node.type === 'VariableDeclarator' &&
                node.id.type === 'Identifier'
            ) {
                // Check if the init is actually a function
                if (
                    ['ArrowFunctionExpression', 'FunctionExpression'].includes(
                        node.init.type,
                    )
                ) {
                    return node.id.name;
                }
            }

            // 4. Object Method: const x = { myMethod() {} }
            if (
                node.type === 'Property' &&
                (node.method || node.value.type === 'FunctionExpression')
            ) {
                return node.key.name;
            }

            current = current.parent;
        }
        return 'AnonymousFunction'; // Fallback
    };

    // Find ALL calls to .info, .warn, .error
    root.find(j.CallExpression, {
        callee: {
            type: 'MemberExpression',
            property: {
                name: (name) =>
                    ['info', 'warn', 'error', 'debug'].includes(name),
            },
        },
    }).replaceWith((path) => {
        const { callee, arguments: args } = path.node;

        // --- Determine if this is a target call (this.logger OR logger) ---
        const objectNode = callee.object;
        let isClassContext = false;
        let isFunctionContext = false;

        // Check for "this.logger"
        if (
            objectNode.type === 'MemberExpression' &&
            objectNode.object.type === 'ThisExpression' &&
            objectNode.property.name === loggerName
        ) {
            isClassContext = true;
        }

        // Check for "logger" (standalone identifier)
        if (
            objectNode.type === 'Identifier' &&
            objectNode.name === loggerName
        ) {
            isFunctionContext = true;
        }

        // If it's neither, skip (e.g. console.error, otherLib.error)
        if (!isClassContext && !isFunctionContext) {
            return path.node;
        }

        // --- Prepare New Method Name ---
        const methodName = callee.property.name;
        const newMethodName = methodName === 'info' ? 'log' : methodName;

        // Check if already migrated
        if (args.length === 1 && args[0].type === 'ObjectExpression') {
            return path.node;
        }

        // --- Build Properties ---
        const properties = [];

        // 1. Message
        if (args[0]) properties.push(buildProperty('message', args[0]));

        // 2. Context
        if (isClassContext) {
            // use runtime class name: this.constructor.name
            properties.push(
                buildProperty(
                    'context',
                    j.memberExpression(
                        j.memberExpression(
                            j.thisExpression(),
                            j.identifier('constructor'),
                        ),
                        j.identifier('name'),
                    ),
                ),
            );
        } else {
            // use compile-time function name string: 'myFunction'
            const funcName = getFunctionName(path);
            properties.push(buildProperty('context', j.literal(funcName)));
        }

        // 3. Error and Metadata (Argument Handling)
        let errorNode = null;
        let metadataNode = null;

        if (args.length === 3) {
            // logger.error(msg, error, meta)
            errorNode = args[1];
            metadataNode = args[2];
        } else if (args.length === 2) {
            const secondArg = args[1];
            if (secondArg.type === 'ObjectExpression') {
                // Unpack { error, ...meta }
                const extractedProps = [];
                secondArg.properties.forEach((prop) => {
                    if (prop.key.name === 'error') {
                        errorNode = prop.value;
                    } else {
                        extractedProps.push(prop);
                    }
                });
                if (extractedProps.length > 0)
                    metadataNode = j.objectExpression(extractedProps);
            } else {
                // Assume variable is error
                errorNode = secondArg;
            }
        }

        if (errorNode) properties.push(buildProperty('error', errorNode));
        if (metadataNode)
            properties.push(buildProperty('metadata', metadataNode));

        // --- Return New Call ---
        // Construct the callee based on how we found it (this.logger vs logger)
        let newCallee;
        if (isClassContext) {
            newCallee = j.memberExpression(
                j.memberExpression(
                    j.thisExpression(),
                    j.identifier(loggerName),
                ),
                j.identifier(newMethodName),
            );
        } else {
            newCallee = j.memberExpression(
                j.identifier(loggerName),
                j.identifier(newMethodName),
            );
        }

        return j.callExpression(newCallee, [j.objectExpression(properties)]);
    });

    return root.toSource();
};

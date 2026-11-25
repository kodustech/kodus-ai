const path = require('path');

const TRY_ROOT = path.resolve(__dirname, 'apps', 'try');
const LIBS_ROOT = path.resolve(__dirname, 'libs');
const TRY_SRC = path.resolve(TRY_ROOT, 'src');

/**
 * Custom Jest resolver that handles ESM-style .js imports to .ts files
 * This is needed because local TS sources (the shared `@libs/*` modules) use
 * .js extensions in imports (ESM style) but we want Jest to resolve them to the
 * corresponding .ts files
 */
module.exports = (request, options) => {
    // apps/try defines `@/* -> ./src/*` in its own tsconfig, while the root
    // jest.config.ts maps `@/* -> <rootDir>/libs/*`. Re-route `@/` imports from
    // apps/try files back to apps/try/src so component specs resolve the real app.
    if (
        options.basedir &&
        (options.basedir === TRY_ROOT ||
            options.basedir.startsWith(TRY_ROOT + path.sep)) &&
        (request === LIBS_ROOT || request.startsWith(LIBS_ROOT + path.sep))
    ) {
        request = TRY_SRC + request.slice(LIBS_ROOT.length);
    }

    // Handle .js to .ts resolution for local TS packages
    if (request.endsWith('.js') && !request.includes('node_modules')) {
        const tsRequest = request.replace(/\.js$/, '.ts');
        try {
            return options.defaultResolver(tsRequest, options);
        } catch {
            // If .ts doesn't exist, fall back to original request
        }
    }

    return options.defaultResolver(request, options);
};

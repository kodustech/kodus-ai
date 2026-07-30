/**
 * Custom Jest resolver that handles ESM-style .js imports to .ts files
 * This is needed because the local TS packages (e.g. kodus-common) use .js
 * extensions in imports (ESM style) but we want Jest to resolve them to the
 * corresponding .ts files
 */
module.exports = (request, options) => {
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

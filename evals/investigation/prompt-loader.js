module.exports = function promptLoader(context) {
    return JSON.stringify(context.vars || {});
};

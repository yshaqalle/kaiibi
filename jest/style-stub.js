// Stands in for a `.css` import under Jest.
//
// `constants/theme.ts` imports `@/global.css` so the web build emits the font
// custom properties. Jest has no CSS loader, so any test that reaches the
// theme — directly or through a module that reads a colour token — died on a
// SyntaxError at the first `:` in the stylesheet.
//
// Styling is never what these tests assert, so an empty module is the whole
// fix. See moduleNameMapper in jest.config.js.
module.exports = {};

// Image assets are required through the `@/` alias, which jest-expo's asset
// transformer does not see -- it only handles relative paths. Any component
// with an icon was therefore untestable. The stub stands in for the resolved
// asset id, which no test asserts on. See jest/style-stub.js for the same
// problem with CSS.
module.exports = 1;

export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/generated/**/*.test.js"],
  transform: {},
  verbose: false,

  // Only mock external deps we need for the demo
  moduleNameMapper: {
    "^axios$": "<rootDir>/tests/__mocks__/externalMock.cjs"
  }
};
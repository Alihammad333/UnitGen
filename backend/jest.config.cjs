module.exports = {
  testEnvironment: "node",

  // We keep generated tests as ESM-like runtime tests,
  // but transpile benchmark package source files to something Jest can execute.
  transform: {
    "^.+benchmark_packages[\\\\/].+\\.js$": require.resolve("babel-jest"),
  },

  transformIgnorePatterns: [
    "/node_modules/",
  ],

  testMatch: [
    "**/tests/generated/**/*.test.js",
  ],

  moduleFileExtensions: ["js", "json"],

  verbose: false,
};
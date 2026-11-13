/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // The cross-framework tests load the Laravel and Spring Boot parsers, whose
  // module-level tree-sitter Parser intermittently fails when Jest reuses one
  // worker process across test files (see packages/laravel-parser/jest.config.js).
  maxWorkers: 50,
  extensionsToTreatAsEsm: [".ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/fixtures/"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true,
      diagnostics: { ignoreCodes: [151002, 1343] },
    }],
  },
}

/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // These tests load the Laravel / NestJS parsers, whose module-level tree-sitter
  // Parser intermittently fails when Jest reuses one worker process across test
  // files (see packages/laravel-parser/jest.config.js). One process per file.
  maxWorkers: 50,
  extensionsToTreatAsEsm: [".ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true,
      diagnostics: { ignoreCodes: [151002] },
    }],
  },
}

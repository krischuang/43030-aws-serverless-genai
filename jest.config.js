module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, noUnusedParameters: false } }],
  },
  collectCoverageFrom: ['src/**/*.ts', 'lib/**/*.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
  cacheDirectory: '<rootDir>/.jest-cache',
};

module.exports = {
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.{js,jsx}', '<rootDir>/src/**/*.{spec,test}.{js,jsx}'],
  testEnvironment: 'jsdom',
  setupFiles: ['whatwg-fetch'],
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.js'],
  transform: { '^.+\\.[cm]?[jt]sx?$': ['babel-jest', {
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], ['@babel/preset-react', { runtime: 'automatic' }]],
  }] },
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/config/jest/styleMock.cjs',
    '\\.(svg|png|jpe?g|gif|webp|ico|woff2?)$': '<rootDir>/config/jest/fileMock.cjs',
  },
  collectCoverageFrom: ['src/**/*.{js,jsx}'],
  resetMocks: true,
};

/**
 * The handlers emit structured logs on every path, which would otherwise bury
 * the Jest report. Console output is silenced globally; the tests that assert
 * on log content install their own spies.
 */

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

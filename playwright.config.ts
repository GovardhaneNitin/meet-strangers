import { defineConfig, devices } from '@playwright/test';

const PORT = 8090;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Allows running against a preinstalled Chromium (e.g. in sandboxes).
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run build && node packages/server/dist/index.js',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // NODE_ENV is deliberately not set: it would also apply to `vite build`
    // and produce a development React bundle instead of the production one.
    env: {
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      MAX_CONNECTIONS_PER_IP: '20',
      MAX_CONNECTION_ATTEMPTS_PER_MINUTE: '200',
    },
  },
});

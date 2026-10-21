import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WebSocket } from 'ws';

type Frame = { type: string; matchId?: string };

// Each stranger gets an isolated browser context; close them all between
// tests so nobody from a previous test is still waiting in the queue.
const contexts: BrowserContext[] = [];
// Console errors (including CSP violations) fail the test.
const consoleErrors: string[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  expect(consoleErrors.splice(0)).toEqual([]);
});

/** Signaling messages each page sent and received, for protocol-level assertions. */
const frames = new Map<Page, { sent: Frame[]; received: Frame[] }>();

async function openStranger(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const log = { sent: [] as Frame[], received: [] as Frame[] };
  frames.set(page, log);
  page.on('websocket', (socket) => {
    const parse = (payload: string | Buffer) => JSON.parse(String(payload)) as Frame;
    socket.on('framesent', ({ payload }) => log.sent.push(parse(payload)));
    socket.on('framereceived', ({ payload }) => log.received.push(parse(payload)));
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /online/i })).toBeVisible();
  return page;
}

async function start(page: Page, mode: 'Video' | 'Voice only' = 'Video') {
  await page.getByText(mode, { exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Start chatting' }).click();
}

async function expectConnected(page: Page) {
  await expect(page.getByPlaceholder('Type a message…')).toBeEnabled({ timeout: 30_000 });
}

test('two strangers connect by video, chat, and one skips', async ({ browser }) => {
  const alice = await openStranger(browser);
  const bob = await openStranger(browser);

  await start(alice);
  await expect(alice.getByText('Looking for someone to talk to…')).toBeVisible();
  await start(bob);

  await expectConnected(alice);
  await expectConnected(bob);

  // Real media is flowing: the remote <video> has decoded frames.
  const remoteVideoWidth = (page: Page) =>
    page.locator('.room__remote video').evaluate((v: HTMLVideoElement) => v.videoWidth);
  await expect.poll(() => remoteVideoWidth(alice), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => remoteVideoWidth(bob), { timeout: 15_000 }).toBeGreaterThan(0);

  // Peer-to-peer text chat; markup is rendered as text, never as HTML.
  const message = '<img src=x onerror="window.pwned=1"> hello';
  await alice.getByPlaceholder('Type a message…').fill(message);
  await alice.getByRole('button', { name: 'Send message' }).click();
  await expect(bob.locator('.chat-message--stranger')).toHaveText(`Stranger${message}`);
  expect(await bob.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

  // Bob skips: Alice is told the stranger left.
  await bob.getByRole('button', { name: /^Next/ }).click();
  await expect(alice.getByText('Stranger has disconnected', { exact: true })).toBeVisible();
  await expect(bob.getByText('Looking for someone to talk to…')).toBeVisible();

  // Stop returns to the landing page and releases the camera.
  await alice.getByRole('button', { name: 'Stop' }).click();
  await expect(alice.getByRole('button', { name: 'Start chatting' })).toBeVisible();
});

test('voice-only users are matched with each other', async ({ browser }) => {
  const a = await openStranger(browser);
  const b = await openStranger(browser);
  await start(a, 'Voice only');
  await start(b, 'Voice only');
  await expectConnected(a);
  await expectConnected(b);
  await expect(a.getByRole('button', { name: 'Turn camera off' })).toHaveCount(0);
});

test('reporting a stranger ends the chat and finds someone new', async ({ browser }) => {
  const a = await openStranger(browser);
  const b = await openStranger(browser);
  await start(a);
  await start(b);
  await expectConnected(a);

  await a.getByRole('button', { name: 'Report stranger' }).click();
  await a.getByLabel('Harassment, hate or threats').check();
  await a.getByRole('button', { name: 'Report and skip' }).click();

  await expect(a.getByText('Your report was sent')).toBeVisible();
  await expect(b.getByText('Stranger has disconnected', { exact: true })).toBeVisible();
});

test('sends strict security headers', async ({ request }) => {
  const response = await request.get('/');
  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toContain('camera=(self)');
});

test('a report targets the stranger it was opened for, even after moving on', async ({
  browser,
  baseURL,
}) => {
  // Regression: the report used to target whoever was on screen when the
  // dialog was submitted. If the call failed while the dialog was open, the
  // app moved on and the next, innocent stranger was reported and skipped.
  test.setTimeout(90_000);

  // A stranger who joins but never answers the WebRTC handshake, so the
  // call fails and the app moves on automatically (after ~25 s).
  const silent = new WebSocket(`${baseURL!.replace(/^http/, 'ws')}/ws`, { origin: baseURL });
  await new Promise((resolve) => silent.once('open', resolve));
  silent.send(JSON.stringify({ type: 'join', mode: 'video', interests: [], acceptedTerms: true }));

  try {
    const alice = await openStranger(browser);
    await start(alice);
    await expect(alice.getByText('Connecting to stranger…')).toBeVisible();
    const silentMatchId = frames.get(alice)!.received.find((f) => f.type === 'matched')!.matchId;

    await alice.getByRole('button', { name: 'Report stranger' }).click();
    await alice.getByLabel('Harassment, hate or threats').check();

    const carol = await openStranger(browser);
    await start(carol);
    await expectConnected(carol); // alice moved on and is now talking to carol
    await expect(alice.getByRole('dialog')).toBeVisible();

    await alice.getByRole('button', { name: 'Report and skip' }).click();
    await expect(alice.getByText('Thanks. Your report was sent.', { exact: true })).toBeVisible();

    const reports = frames.get(alice)!.sent.filter((f) => f.type === 'report');
    expect(reports.map((f) => f.matchId)).toEqual([silentMatchId]);
    // Carol was neither reported nor skipped.
    await alice.waitForTimeout(1_000);
    await expect(carol.getByText('Stranger has disconnected', { exact: true })).toHaveCount(0);
    await expectConnected(alice);
  } finally {
    silent.close();
  }
});

test('interests in any script are accepted and invalid ones explained', async ({ browser }) => {
  // Regression: Hindi, Tamil, Thai etc. were silently discarded.
  const page = await openStranger(browser);
  const input = page.getByLabel(/Interests/);

  for (const word of ['संगीत', 'ラーメン']) {
    await input.fill(word);
    await input.press('Enter');
    await expect(page.locator('.tag', { hasText: word })).toBeVisible();
  }

  await input.fill('a+b');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(/letters, numbers, spaces and dashes/);
  await expect(input).toHaveValue('a+b'); // kept so it can be corrected
  await input.fill('ab');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // An invalid interest left in the box is not silently dropped on start.
  await input.fill('a+b');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await expect(page.getByRole('alert')).toHaveText(/letters, numbers, spaces and dashes/);
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
});

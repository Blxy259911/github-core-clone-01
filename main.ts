// Entry point: the harness lifecycle. The server itself lives in app.ts; this file only
// connects it to the trial env: bind a port, announce it, then wait until the env says
// the trial is over. Nothing here is scored except that it must not exit early and
// must not bind the env's own port.
//
//   env origin  <- MAKEFUN_ENV_URL (http://store:8080 inside a trial container)
//   no env url  -> exit 1 immediately, there is nothing to register with
//   listen(0)   -> the kernel picks a free port; 8080 belongs to the env
//   POST /register {port} -> the env dials this process from then on; 409 means
//                            another entry registered first, and we just carry on
//   GET /done   -> poll until {"done": true}; never exit before that
//   then close the server and exit 0

import { createApp } from "./app.ts";

const ENV = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (ENV === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is unset, so there is no env to talk to\n");
  process.exit(1);
}

// One HTTP round trip may take this long before it is dropped and retried.
const CALL_TIMEOUT_MS = 30_000;
// Backoff between retries: start here, double each time, never pass the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

function backoff(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** step);
}

// Tell the env which port this process bound. Accepts 200 (registered) and 409
// (a first register already won); 400/405 are contract errors and end the run;
// anything else, including a refused connection while the env starts, is retried.
async function announce(port: number): Promise<void> {
  for (let attempt = 0; true; attempt++) {
    try {
      const res = await fetch(`${ENV}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) { return; }
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register failed with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("register failed with HTTP ")) throw err;
    }
    await pause(backoff(attempt));
  }
}

// Ask GET /done until the env answers {"done": true}. A refused connection, a
// timeout, or a non-OK status just means not done yet: wait and ask again.
async function awaitDone(): Promise<void> {
  for (let attempt = 0; true; attempt++) {
    try {
      const res = await fetch(`${ENV}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done: unknown };
        if (body.done === true) { return; }
      }
    } catch {
      // Not answering yet: keep polling.
    }
    await pause(backoff(attempt));
  }
}

async function boot(): Promise<void> {
  const httpServer = createApp();
  await new Promise<void>((resolve, reject): void => {
    httpServer.once("error", reject);
    httpServer.listen(0, () => resolve());
  });
  const bound = httpServer.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write("[forge] registered; waiting for the env to say done\n");

  await awaitDone();
  httpServer.close();
  process.stdout.write("[forge] done\n");
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

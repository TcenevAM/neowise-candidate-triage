import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

let child;
let base;

before(async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base);
      await response.text();
      if (response.ok) return;
    } catch {}
    if (child.exitCode !== null) throw new Error("Server exited before startup");
    await delay(20);
  }
  throw new Error("Server did not start");
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

async function post(body) {
  const response = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

test("invalid input returns 400, including malformed JSON and non-object bodies", async () => {
  for (const body of [
    "", "{", "null", "[]", "42", '"hello"', "{}",
    '{"text":null}', '{"text":false}', '{"text":123}',
    '{"text":[]}', '{"text":{}}', '{"text":""}',
    JSON.stringify({ text: " \t\n\u00a0 " }),
  ]) {
    assert.deepEqual(await post(body), {
      status: 400, body: { status: "invalid_input" },
    }, `body: ${JSON.stringify(body)}`);
  }
});

test("normal requests return only the validated topic and nonblank draft", async () => {
  for (const [text, topic] of [
    ["Когда доставка?", "delivery"],
    ["Какая стоимость?", "pricing"],
    ["Здравствуйте", "other"],
  ]) {
    const response = await post(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: "ready", topic,
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  }
});

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`${marker} falls back to manual review without a draft`, async () => {
    assert.deepEqual(await post(JSON.stringify({ text: marker })), {
      status: 200,
      body: { status: "manual_review", topic: null, draft: null },
    });
  });
}

test("model timeout falls back before the mock's 1200 ms wait finishes", async () => {
  const start = performance.now();
  assert.deepEqual(await post(JSON.stringify({ text: "[timeout]" })), {
    status: 200,
    body: { status: "manual_review", topic: null, draft: null },
  });
  assert.ok(performance.now() - start < 1000, "Model deadline was not enforced");
  assert.equal((await post(JSON.stringify({ text: "Доставка" }))).body.status, "ready");
});

test("page is served and unknown routes keep returning 404", async () => {
  const page = await fetch(base);
  assert.match(await page.text(), /Входящие заявки/);
  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { status: "not_found" });
});

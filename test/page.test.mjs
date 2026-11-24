import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Execute the page's actual script with a small DOM stand-in and controlled fetch.
// Deliberately ignore aborts in fetch: cancellation alone must not prevent races.
function page() {
  const selectors = ["form", "#message", "#result", "#status", "#topic", "#draft"];
  const elements = Object.fromEntries(selectors.map((selector) => [selector, {
    value: "", textContent: "", hidden: selector === "#result",
    listeners: {}, attributes: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
  }]));
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  runInNewContext(script, {
    document: { querySelector: (selector) => elements[selector] },
    AbortController,
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject });
      });
    },
  });
  return {
    elements, requests, timers,
    submit(text) {
      elements["#message"].value = text;
      return elements.form.listeners.submit({ preventDefault() {} });
    },
    input(text) {
      elements["#message"].value = text;
      elements["#message"].listeners.input();
    },
  };
}

function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
function ready(draft = "Свежий ответ") {
  return reply({ status: "ready", topic: "delivery", draft });
}

test("blank input is rejected locally without sending a request", async () => {
  const p = page();
  await p.submit(" \n\t ");
  assert.equal(p.requests.length, 0);
  assert.match(p.elements["#status"].textContent, /Введи текст/);
});

for (const failure of ["manual_review", "network", "invalid_json", "unknown_topic", "blank_draft", "http_500", "null"]) {
  test(`${failure} clears a previous draft and asks for manual review`, async () => {
    const p = page();
    const first = p.submit("Доставка");
    p.requests[0].resolve(ready("Предыдущий ответ"));
    await first;
    assert.equal(p.elements["#draft"].value, "Предыдущий ответ");

    const second = p.submit("Новая заявка");
    assert.equal(p.elements["#draft"].value, "");
    const request = p.requests[1];
    if (failure === "network") request.reject(new Error("Offline"));
    else if (failure === "invalid_json") request.resolve({ ok: true, async json() { throw new Error("Bad JSON"); } });
    else if (failure === "unknown_topic") request.resolve(reply({ status: "ready", topic: "refund", draft: "Ответ" }));
    else if (failure === "blank_draft") request.resolve(reply({ status: "ready", topic: "delivery", draft: "  " }));
    else if (failure === "http_500") request.resolve(reply({ status: "server_error" }, 500));
    else if (failure === "null") request.resolve(reply(null));
    else request.resolve(reply({ status: "manual_review", topic: null, draft: null }));
    await second;
    assert.equal(p.elements["#draft"].value, "");
    assert.equal(p.elements["#topic"].textContent, "");
    assert.equal(p.elements["#result"].hidden, true);
    assert.match(p.elements["#status"].textContent, /Нужен ручной разбор/);
    assert.equal(p.elements.form.attributes["aria-busy"], "false");
  });
}

test("a late response cannot replace the newest result even when abort is ignored", async () => {
  const p = page();
  const first = p.submit("Первая заявка");
  const second = p.submit("Вторая заявка");
  assert.equal(p.requests[0].options.signal.aborted, true);
  p.requests[1].resolve(ready("Свежий ответ"));
  await second;
  p.requests[0].resolve(ready("Устаревший ответ"));
  await first;
  assert.equal(p.elements["#draft"].value, "Свежий ответ");
  assert.equal(p.elements["#result"].hidden, false);
});

test("an old error cannot stop loading or overwrite a later success", async () => {
  const p = page();
  const first = p.submit("Первая заявка");
  const second = p.submit("Вторая заявка");
  p.requests[0].reject(new Error("Old failure"));
  await first;
  assert.equal(p.elements.form.attributes["aria-busy"], "true");
  assert.equal(p.timers.size, 1);
  p.requests[1].resolve(ready());
  await second;
  assert.equal(p.elements["#draft"].value, "Свежий ответ");
  assert.equal(p.timers.size, 0);
});

test("editing the input invalidates an in-flight request", async () => {
  const p = page();
  const pending = p.submit("Первая заявка");
  p.input("Изменённая заявка");
  p.requests[0].resolve(ready("Ответ на старый текст"));
  await pending;
  assert.equal(p.elements["#draft"].value, "");
  assert.equal(p.elements["#status"].textContent, "");
  assert.equal(p.elements["#result"].hidden, true);
});

test("the browser deadline asks for manual review when fetch aborts", async () => {
  const p = page();
  const pending = p.submit("Доставка");
  p.timers.values().next().value();
  assert.equal(p.requests[0].options.signal.aborted, true);
  p.requests[0].reject(new DOMException("Aborted", "AbortError"));
  await pending;
  assert.match(p.elements["#status"].textContent, /Нужен ручной разбор/);
  assert.equal(p.elements["#draft"].value, "");
});

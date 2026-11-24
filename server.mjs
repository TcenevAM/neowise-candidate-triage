import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (typeof input?.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timer;
  try {
    const raw = await Promise.race([
      classify(input.text, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Model deadline exceeded"));
        }, 300);
      }),
    ]);
    const result = JSON.parse(raw);
    if (!topics.has(result?.topic) ||
        typeof result?.draft !== "string" || !result.draft.trim()) {
      return json(response, 200, manualReview);
    }
    return json(response, 200, {
      status: "ready", topic: result.topic, draft: result.draft.trim(),
    });
  } catch {
    return json(response, 200, manualReview);
  } finally {
    clearTimeout(timer);
  }
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");

const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const port = Number(process.env.VOCAB_TEST_PORT || 8765);
const fixture = readFileSync(resolve(__dirname, "fixture.html"));
const popupFixture = readFileSync(resolve(__dirname, "..", "popup.html"), "utf8")
  .replace("<script src=\"shared.js\"></script>", "<script src=\"/popup-chrome-mock.js\"></script>\n    <script src=\"/shared.js\"></script>")
  .replace("<script src=\"popup.js\"></script>", "<script src=\"/popup.js\"></script>");
const assets = new Map([
  ["/shared.js", ["application/javascript; charset=utf-8", readFileSync(resolve(__dirname, "..", "shared.js"))]],
  ["/content.js", ["application/javascript; charset=utf-8", readFileSync(resolve(__dirname, "..", "content.js"))]],
  ["/content.css", ["text/css; charset=utf-8", readFileSync(resolve(__dirname, "..", "content.css"))]],
  ["/popup.css", ["text/css; charset=utf-8", readFileSync(resolve(__dirname, "..", "popup.css"))]],
  ["/popup.js", ["application/javascript; charset=utf-8", readFileSync(resolve(__dirname, "..", "popup.js"))]],
  ["/popup-chrome-mock.js", ["application/javascript; charset=utf-8", readFileSync(resolve(__dirname, "popup-chrome-mock.js"))]]
]);

createServer((request, response) => {
  const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
  const headers = { "Cache-Control": "no-store" };
  if (requestPath === "/" || requestPath === "/fixture.html") {
    response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  if (requestPath === "/popup-fixture.html") {
    response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    response.end(popupFixture);
    return;
  }
  if (assets.has(requestPath)) {
    const [contentType, body] = assets.get(requestPath);
    response.writeHead(200, { ...headers, "Content-Type": contentType });
    response.end(body);
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}).listen(port, "127.0.0.1", () => {
  console.log(`Fixture server listening on http://127.0.0.1:${port}/fixture.html`);
});

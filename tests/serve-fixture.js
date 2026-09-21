const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const port = Number(process.env.VOCAB_TEST_PORT || 8765);
const fixture = readFileSync(resolve(__dirname, "fixture.html"));

createServer((request, response) => {
  if (request.url === "/" || request.url === "/fixture.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}).listen(port, "127.0.0.1", () => {
  console.log(`Fixture server listening on http://127.0.0.1:${port}/fixture.html`);
});

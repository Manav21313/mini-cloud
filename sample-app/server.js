const http = require("node:http");

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Hello from MiniCloud!\n");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MiniCloud sample app listening on port ${port}`);
});

function shutDown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutDown("SIGTERM"));
process.on("SIGINT", () => shutDown("SIGINT"));

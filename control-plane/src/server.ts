import { createReadStream } from "node:fs";
import { createServer, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { DockerControl } from "./docker/control.js";

const control = new DockerControl();
const port = Number(process.env.CONTROL_PLANE_PORT ?? "8080");
const dashboardPath = resolve(process.cwd(), "public", "index.html");

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(dashboardPath).on("error", (error) => json(response, 500, { error: error.message })).pipe(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/deploy") return json(response, 200, await control.deploy());
    if (request.method === "POST" && url.pathname === "/stop") return json(response, 200, await control.stop());
    if (request.method === "POST" && url.pathname === "/restart") return json(response, 200, await control.restart());
    if (request.method === "GET" && url.pathname === "/status") return json(response, 200, await control.status());
    if (request.method === "GET" && url.pathname === "/logs") {
      const tail = url.searchParams.has("tail") ? Number(url.searchParams.get("tail")) : 100;
      return json(response, 200, { logs: await control.logs(tail) });
    }
    json(response, 404, { error: "Route not found" });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MiniCloud dashboard: http://localhost:${port}`);
});

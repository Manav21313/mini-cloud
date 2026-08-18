import { createReadStream } from "node:fs";
import { IncomingMessage, createServer, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Application, ApplicationRegistry, NewApplication, RegistryError } from "./applications/registry.js";
import { DockerControl } from "./docker/control.js";

const sampleApplication: Application = {
  id: "minicloud-sample",
  name: "MiniCloud Sample",
  image: process.env.MINICLOUD_IMAGE ?? "minicloud-sample",
  containerName: process.env.MINICLOUD_CONTAINER ?? "minicloud-sample",
  containerPort: 3000,
  hostPort: Number(process.env.MINICLOUD_PORT ?? "3000"),
  status: "unknown"
};

const registry = new ApplicationRegistry([sampleApplication]);
const port = Number(process.env.CONTROL_PLANE_PORT ?? "8080");
const dashboardPath = resolve(process.cwd(), "public", "index.html");

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function controlFor(application: Application): DockerControl {
  return new DockerControl({
    containerName: application.containerName,
    imageName: application.image,
    containerPort: application.containerPort,
    hostPort: application.hostPort
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new RegistryError("Request body is too large", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new RegistryError("Request body must be valid JSON", 400);
  }
}

function newApplication(body: Record<string, unknown>): NewApplication {
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    image: typeof body.image === "string" ? body.image.trim() : "",
    containerName: typeof body.containerName === "string" ? body.containerName.trim() : "",
    containerPort: Number(body.containerPort),
    hostPort: Number(body.hostPort)
  };
}

async function runAction(application: Application, action: string): Promise<unknown> {
  const control = controlFor(application);
  try {
    if (action === "logs") return { application, logs: await control.logs() };
    if (action === "status") {
      const status = await control.status();
      registry.setStatus(application.id, status.state);
      return { application, status };
    }
    if (action === "deploy" || action === "stop" || action === "restart") {
      const result = await control[action]();
      registry.setStatus(application.id, result.status.state);
      return { application, ...result };
    }
  } catch (error) {
    registry.setStatus(application.id, "error");
    throw error;
  }
  throw new RegistryError("Route not found", 404);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(dashboardPath).on("error", (error) => json(response, 500, { error: error.message })).pipe(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/apps") return json(response, 200, registry.list());
    if (request.method === "POST" && url.pathname === "/api/apps") {
      const application = registry.create(newApplication(await readJson(request)));
      return json(response, 201, application);
    }

    const appRoute = url.pathname.match(/^\/api\/apps\/([^/]+)(?:\/([^/]+))?$/);
    if (appRoute) {
      const application = registry.require(decodeURIComponent(appRoute[1]));
      const action = appRoute[2];
      if (request.method === "GET" && !action) return json(response, 200, application);
      if (request.method === "DELETE" && !action) {
        await controlFor(application).remove();
        registry.delete(application.id);
        return json(response, 200, { message: `${application.name} deleted.` });
      }
      if ((request.method === "POST" && ["deploy", "stop", "restart"].includes(action)) ||
          (request.method === "GET" && ["status", "logs"].includes(action))) {
        return json(response, 200, await runAction(application, action));
      }
    }

    // V0.1 compatibility routes continue to operate on the seeded sample application.
    const legacyAction = url.pathname.slice(1);
    if ((request.method === "POST" && ["deploy", "stop", "restart"].includes(legacyAction)) ||
        (request.method === "GET" && ["status", "logs"].includes(legacyAction))) {
      const application = registry.require(sampleApplication.id);
      const result = await runAction(application, legacyAction) as Record<string, unknown>;
      if (legacyAction === "logs") return json(response, 200, { logs: result.logs });
      if (legacyAction === "status") return json(response, 200, result.status);
      const { application: _application, ...legacyResult } = result;
      return json(response, 200, legacyResult);
    }

    json(response, 404, { error: "Route not found" });
  } catch (error) {
    const status = error instanceof RegistryError ? error.statusCode : 500;
    json(response, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MiniCloud dashboard: http://localhost:${port}`);
});

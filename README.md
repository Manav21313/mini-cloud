# MiniCloud

A local TypeScript control plane for managing Docker applications. The dashboard
supports registration, deployment, stop, restart, status, logs, deletion, and
opening applications. Each registration has its own container name and host port.

## Architecture

- `control-plane/src/server.ts`: Node HTTP server, dashboard, REST API, and seeded sample app.
- `control-plane/src/applications/registry.ts`: PostgreSQL application registry and validation.
- `control-plane/src/database/`: environment loading, pg pool, and migration runner.
- `control-plane/migrations/001_applications.sql`: applications table and constraints.
- `compose.yaml`: local PostgreSQL with the persistent `minicloud_postgres_data` volume.
- `control-plane/src/docker/control.ts`: container lifecycle and logs through Dockerode.
- `control-plane/src/cli.ts` and `index.ts`: single-container CLI.
- `control-plane/public/index.html`: dashboard; no separate frontend build.
- `sample-app/server.js` and `Dockerfile`: dependency-free Node HTTP sample, listening on container port 3000.

Registrations persist in PostgreSQL across control-plane and database-container
restarts. Docker is the source of truth for actual container state. Before serving
the dashboard, MiniCloud loads all registrations, inspects Docker, and saves the
observed status. Failed inspections are recorded as `unknown`, never assumed
stopped. The Status button refreshes a container's observed status on demand.
Docker containers remain until deleted. Deletion stops/removes the container and
unregisters the application. Images are built separately; deployment uses an
existing image.

## Run on macOS

Install Node.js 22 or newer and Docker Desktop. Start Docker
Desktop and wait until `docker info` succeeds. Run these commands from this repo:

```sh
cd /Users/manavc/Desktop/mini-cloud
open -a Docker
docker info
npm --prefix control-plane ci
cp .env.example .env
# Edit .env and set PGPASSWORD to your own password.
docker compose up -d --wait postgres
npm --prefix control-plane run migrate
docker build -t minicloud-sample ./sample-app
npm --prefix control-plane start
```

If `.env` already exists, keep it rather than copying over it. The current Mac
has an ignored `.env` with a generated local password. Compose reads the root
`.env`; the control plane loads the same file independent of its working directory.
Explicit environment variables take precedence.

The last command builds TypeScript and runs the dashboard at
<http://localhost:8080>. Keep that terminal running. For development instead:

```sh
npm --prefix control-plane run dev
```

In another terminal, deploy the seeded sample and open it:

```sh
curl --fail-with-body -X POST http://localhost:8080/api/apps/minicloud-sample/deploy
open http://localhost:8080
open http://localhost:3000
```

To register and deploy a second container on host port 3001:

```sh
SECOND_APP_ID=$(curl --fail-with-body -sS http://localhost:8080/api/apps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Second Sample","image":"minicloud-sample","containerName":"minicloud-sample-2","containerPort":3000,"hostPort":3001}' \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);if(!a.id)throw Error(a.error||"Registration failed");console.log(a.id)})')
curl --fail-with-body -X POST "http://localhost:8080/api/apps/$SECOND_APP_ID/deploy"
open http://localhost:3001
```

Alternatively use the dashboard's **Deploy New App** form with those values; it
registers and deploys in one flow. Names and host ports must be unique. After
deleting the second container, these registration commands can be used again.

## Docker connection

MiniCloud uses Dockerode's cross-platform defaults: Docker Desktop's
`~/.docker/run/docker.sock` on macOS when available, otherwise
`/var/run/docker.sock` on Unix, and the Windows named pipe only on Windows.
There is no hardcoded Windows socket in MiniCloud source.

Dockerode also honors `DOCKER_HOST` and its Docker TLS environment settings.
For an alternate local Unix socket, set `DOCKER_HOST=unix:///path/to/docker.sock`
before starting MiniCloud. Dockerode does not automatically read Docker CLI
contexts. With an alternate local Unix-socket context, use:

```sh
DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" npm --prefix control-plane start
```

Application browser URLs point to localhost, as this version manages local apps.
`CONTROL_PLANE_PORT` changes dashboard port (default 8080).
`MINICLOUD_IMAGE`, `MINICLOUD_CONTAINER`, and `MINICLOUD_PORT` configure the
sample seed on the first migration and configure the CLI (defaults:
minicloud-sample, minicloud-sample, 3000). Changing these values later does not
overwrite a saved registration. The sample is seeded once; deleting it is durable.
The CLI continues to manage Docker directly; the web server refreshes its status
on startup or through the Status button.

## CLI

From the repository root:

```sh
npm --prefix control-plane run control -- status
npm --prefix control-plane run control -- deploy
npm --prefix control-plane run control -- stop
npm --prefix control-plane run control -- restart
npm --prefix control-plane run control -- logs --tail 20
npm --prefix control-plane run control -- logs --follow
```

The web API handles registration and deletion; the CLI targets a single container.

## PostgreSQL persistence

`applications` stores `id`, `name`, `docker_image`, `container_name`,
`container_port`, `host_port`, `status`, and `created_at`. IDs remain text to
preserve the existing sample ID; newly registered apps use UUID strings.
The API keeps its existing camelCase fields (`image`, `containerName`, etc.)
and adds `createdAt`. All application values use parameterized SQL through `pg`.
Unique database constraints enforce container names and host ports, even for
concurrent registrations.

Registration commits its row before returning success. Deploy, stop, restart,
and status inspection save Docker's observed status. Deletion removes the Docker
container first, then deletes its row. Docker and PostgreSQL cannot share a
transaction: if a database write fails after a Docker action, the API returns an
error; startup or a later status inspection reconciles the saved state. Startup
never automatically deploys stopped applications.

The migration runner tracks applied SQL in `schema_migrations` and applies
migration 001 plus the sample seed in one transaction. Startup also runs this
idempotent setup, so the explicit `migrate` command is optional. If PostgreSQL
is unavailable, startup fails rather than silently using an in-memory registry.

Inspect the rows without putting a password in the command:

```sh
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name, container_name, host_port, status, created_at FROM applications ORDER BY created_at;"'
```

Stop/start PostgreSQL while keeping its volume:

```sh
docker compose stop postgres
docker compose up -d --wait postgres
```

`docker compose down` also preserves the named volume. `docker compose down -v`
deletes the database data. Database initialization credentials are set when the
volume is first created; editing `.env` alone does not change an existing
PostgreSQL password.

Run the persistence integration test with PostgreSQL running and the sample image
built:

```sh
npm --prefix control-plane run test:persistence
```

This test runs its own control plane on port 8082, registers Pineapple (port 3002)
and Banana (port 3003), exercises lifecycle and deletion, stops the control plane,
stops Banana directly through Docker, then restarts the control plane. It checks
that IDs, timestamps, and registrations survive and that startup repairs Banana's
stale saved status. It leaves Pineapple running and Banana stopped for dashboard
inspection. Use those container names and ports only for these sample test apps.

To repeat the dashboard restart check, open <http://localhost:8080>, confirm both
cards appear, press Ctrl+C in the control-plane terminal, run
`npm --prefix control-plane start` again, and reload the page. Pineapple should
show `running` and Banana `exited`. Check with:

```sh
docker inspect --format '{{.Name}} {{.State.Status}}' minicloud-pineapple minicloud-banana
```

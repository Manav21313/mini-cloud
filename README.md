# MiniCloud V0.4

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
- `control-plane/src/deployments/source.ts`: public GitHub validation, cloning, Docker builds, and failure cleanup.
- `control-plane/migrations/002_source_deployments.sql`: source deployment metadata.
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
pending migrations in one transaction; migration 001 also seeds the sample once. Startup also runs this
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

## Deploy from public GitHub (V0.4)

Git must be installed on the control-plane machine. On this Mac it is already
available. PostgreSQL and Docker must be running as described above. Keep the
existing root `.env`; no GitHub token or additional secret is needed.

On the dashboard, use **Deploy from GitHub** and enter:

- Application name: `GitHub Hello World`
- Repository URL: `https://github.com/crccheck/docker-hello-world`
- Branch: `master` (the form defaults to `main`; this repository uses `master`)
- Container port: `8000`
- Host port: `3005`

Click **Deploy from GitHub** and wait for the build to finish. Then click
**Open Application** or open <http://localhost:3005>.
This is a small existing public test repository; MiniCloud does not need to
create a repository or publish your code.

The equivalent API request is:

```sh
curl --fail-with-body -X POST http://localhost:8080/api/deploy/github \
  -H 'Content-Type: application/json' \
  -d '{"name":"GitHub Hello World","repositoryUrl":"https://github.com/crccheck/docker-hello-world","branch":"master","containerPort":8000,"hostPort":3005}'
open http://localhost:3005
```

Do not submit this again with the same name or port while it is registered; use
its existing container actions, delete it first, or choose another name and port.

The request flow is:

```text
GitHub form → POST /api/deploy/github
  → validate URL, branch, name, and ports
  → acquire registration lock and check database/Docker/host conflicts
  → verify the repository is public through unauthenticated GitHub API
  → create a unique temporary directory and shallow-clone the selected branch
  → require a regular root Dockerfile
  → build minicloud-source:<unique UUID> using the Docker API
  → create a new minicloud-source-<application-name> container and start it
  → verify it remains running briefly
  → insert application and source metadata into PostgreSQL and commit
  → remove temporary checkout
  → return HTTP 201 and refresh the existing application cards
```

No source scripts or Dockerfile commands run directly on the control-plane host.
Only Git cloning runs there with a fixed executable and argument list, no shell,
and disabled user Git configuration, credential helpers, hooks, and submodules.
Build instructions run in Docker. The checkout alone is the build context; Git
metadata is excluded and the repository's `.dockerignore` is applied.

The existing `docker_image` column stores the generated image name/tag, so there
is no redundant `image_name` column. Source registrations also store
`repository_url`, `branch`, `last_deployed_at`, and `build_status` (`succeeded`).
Image-only registrations have null source metadata. Failed builds are returned
as errors with recent Docker output rather than saved as broken registrations.

Application names are now checked case-insensitively during registration.
Container names and host ports remain unique. Source container names are derived
from the application name; different names that produce the same slug are
rejected. A shared PostgreSQL advisory lock prevents concurrent source/image
registrations from racing. Other existing application actions remain available
while a source build runs.

Clone, build, container-start, or database-save failure rolls back registration
and removes only the new attempt's container and tagged image. Temporary
checkouts are removed in a `finally` block. Existing containers are never reused
by source deployment. Cleanup failures are reported with the affected resource
IDs. Docker can retain shared build cache and pulled base images.

After success, the usual Deploy/Stop/Restart/Status/Logs/Delete/Open buttons work.
**Deploy** starts the saved image; it does not fetch updated GitHub code. To build
new source in this milestone, delete the registration and submit the GitHub form
again. Delete removes the container and database row; successful images are
retained, consistent with existing image-based deployments. To remove a specific
unused generated image, use `docker image rm <image-tag>`.

Run the source-deployment integration test:

```sh
npm --prefix control-plane run test:source
```

It submits the actual dashboard form handler to a live test control plane on
port 8083, clones/builds the public test repository, verifies localhost on port
3010, restarts the control plane, and checks the existing lifecycle actions and
PostgreSQL source metadata. Dashboard form/rendering and Open URL checks use a
minimal test DOM, not a real browser. Failure tests cover invalid URL/ports,
missing branch/Dockerfile, duplicate names/container names, occupied host ports,
concurrent registrations, and database-save failure. The Docker build failure
case clones the public repository then replaces its disposable test Dockerfile
with a deterministic failing RUN instruction, using a test-only dependency
injection. Production never allows that override. The test removes its apps,
containers, and generated image tags; it keeps existing registrations intact.

Remaining limits for this milestone:

- Public `https://github.com/owner/repository` URLs only; no credentials, redirects,
  SSH, GitHub Enterprise, private repositories, Git LFS, or submodule checkout.
- A regular `Dockerfile` at repository root, with that root as the build context;
  no selectable subdirectory, build arguments, build secrets, or Compose deployment.
- The Docker Engine API's default builder is used; BuildKit-only Dockerfile
  features are not supported by this path.
- Deployments are synchronous. One registration/build can run at a time; competing
  registration requests return 409 and can be retried after completion.
- Public GitHub API rate limits apply. Verification times out after 15 seconds,
  clone after 2 minutes, and build after 10 minutes.
- Startup checks container running state, not HTTP readiness or application health.
  The brief startup check catches immediate exits; later failures remain visible
  through Status and Logs. Docker remains the runtime source of truth.
- Docker and PostgreSQL do not share a transaction. Normal failures are compensated;
  abrupt machine/process crashes or ambiguous database commits may require manual
  cleanup of a generated Docker resource. No background recovery system is added.

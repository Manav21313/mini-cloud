# MiniCloud

A self-hosted cloud deployment platform that can deploy and manage Docker applications through a TypeScript control plane.

## Current features

- Deploy existing Docker images and manage multiple applications.
- Start (Deploy), stop, restart, and delete containers; inspect status and logs; open applications in the browser.
- Persist application registrations and deployment metadata in PostgreSQL.
- Deploy from public GitHub repositories using an existing root Dockerfile.
- Automatically detect supported Vite and basic Node.js projects without a Dockerfile, generating temporary build configuration.
- Use Docker-based application isolation and configurable host/container port mappings.

## Architecture

```text
Browser dashboard
    -> TypeScript control plane
        -> PostgreSQL for deployment metadata
        -> Docker for building/running containers
```

The dashboard is plain HTML, CSS, and JavaScript served by a Node HTTP server; there is no separate frontend build. PostgreSQL remembers registrations across restarts. Docker is the source of truth for runtime state: startup inspects registered containers and reconciles stored status. Startup does not automatically start stopped containers. Failed Docker inspections are recorded as `unknown`.

### Tech stack

TypeScript, Node.js, PostgreSQL (`pg` with parameterized SQL), Docker (Dockerode), and Git/GitHub.

### Important files

| Path | Purpose |
| --- | --- |
| `control-plane/public/index.html` | Dashboard and forms |
| `control-plane/src/server.ts` | HTTP server and application API |
| `control-plane/src/applications/registry.ts` | PostgreSQL registration, validation, and status updates |
| `control-plane/src/database/` | Environment loading, connection pool, and migration runner |
| `control-plane/migrations/` | Versioned SQL schema |
| `control-plane/src/docker/control.ts` | Docker container lifecycle and logs |
| `control-plane/src/deployments/source.ts` | Public GitHub cloning, builds, registration, and cleanup |
| `control-plane/src/deployments/projects.ts` | Project detection and temporary Dockerfile generation |
| `control-plane/tests/` | Detection tests and live integration tests |
| `compose.yaml` | PostgreSQL container and persistent volume |
| `sample-app/` | Small Node HTTP app and Dockerfile |

## Local setup

Install Node.js **22 or newer**, npm, Git, Docker Engine, and Docker Compose. On macOS, start Docker Desktop. Confirm the tools work:

```sh
node --version
npm --version
git --version
docker info
docker compose version
```

Clone this repository and run the following commands from its root:

```sh
npm --prefix control-plane ci
```

### Environment variables

If `.env` does not already exist, copy the template:

```sh
cp .env.example .env
```

Edit `.env` and set your own database password before starting PostgreSQL. Keep an existing `.env` rather than overwriting it. The example below contains placeholders only:

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=minicloud
PGUSER=minicloud
PGPASSWORD=replace-with-your-own-local-password
CONTROL_PLANE_PORT=8080
```

`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` are required by the control plane. `CONTROL_PLANE_PORT` defaults to 8080. Compose reads the root `.env`; the web control plane also loads it regardless of working directory. Explicit environment variables take precedence. Real environment files are ignored; `.env.example` is tracked.

Optional `MINICLOUD_IMAGE`, `MINICLOUD_CONTAINER`, and `MINICLOUD_PORT` configure the initial sample registration and the single-container CLI. Their defaults are `minicloud-sample`, `minicloud-sample`, and `3000`. Changes do not overwrite saved registrations.

### Start PostgreSQL and run migrations

```sh
docker compose up -d --wait postgres
npm --prefix control-plane run migrate
```

PostgreSQL is bound to loopback and stores data in the named `minicloud_postgres_data` Docker volume. The migration runner applies versioned SQL transactionally and records versions in `schema_migrations`. The first migration seeds the sample registration once. Server startup also runs pending migrations.

```sh
docker compose stop postgres
docker compose up -d --wait postgres
```

These commands preserve data. `docker compose down` preserves the volume too; **`docker compose down -v` deletes database data**. Initialization credentials apply when the volume is first created; editing `.env` alone does not change an existing database password.

### Build the sample app and start MiniCloud

```sh
docker build -t minicloud-sample ./sample-app
npm --prefix control-plane start
```

The start command compiles TypeScript and keeps the server running. Open <http://localhost:8080>. For development, use `npm --prefix control-plane run dev` instead. Stop the control plane with Ctrl+C; application containers remain independent of that process.

Deploy the seeded sample through the dashboard's **Deploy** button, or:

```sh
curl --fail-with-body -X POST http://localhost:8080/api/apps/minicloud-sample/deploy
```

Open <http://localhost:3000>. To deploy another container, use **Deploy New App** with name `Second Sample`, image `minicloud-sample`, container name `minicloud-sample-2`, container port `3000`, and host port `3001`. Then open <http://localhost:3001>. Application names, container names, and host ports must be unique.

### Docker connection

MiniCloud uses Dockerode's cross-platform connection defaults, including Docker Desktop's local socket on macOS. It also supports `DOCKER_HOST` and Docker TLS environment settings. It does not automatically select Docker CLI contexts. For an alternate local Unix-socket context:

```sh
DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" npm --prefix control-plane start
```

Browser URLs use localhost. Both the control plane and published application ports bind to loopback in this version.

## Deploy from public GitHub

Use **Deploy from GitHub** with an application name, public repository URL, branch (default `main`), container port, and host port.

Two example repositories:

| Application | Repository | Branch | Container port | Host port |
| --- | --- | --- | --- | --- |
| GitHub Hello World (existing Dockerfile) | https://github.com/crccheck/docker-hello-world | master | 8000 | 3005 |
| FocusFlow (automatic Vite build) | https://github.com/Manav21313/FocusFlow | main | 80 | 3006 |

These are public repository examples, not credentials or private endpoints. Repository contents and availability may change. After deployment, use **Open Application** or the selected localhost host port. If an example is already registered, use its existing actions or select a different name and unused port.

Equivalent FocusFlow request:

```sh
curl --fail-with-body -X POST http://localhost:8080/api/deploy/github \
  -H 'Content-Type: application/json' \
  -d '{"name":"FocusFlow","repositoryUrl":"https://github.com/Manav21313/FocusFlow","branch":"main","containerPort":80,"hostPort":3006}'
```

### Deployment flow

```text
Validate public URL, branch, name, and ports
    -> Check registration/container/host-port conflicts
    -> Verify public visibility through the unauthenticated GitHub API
    -> Shallow-clone into a unique system temporary directory
    -> Use the existing Dockerfile OR detect a supported npm project
    -> Build minicloud-source:<unique UUID> through Docker
    -> Create and start a uniquely named container with the selected port mapping
    -> Save the successful application and deployment metadata in PostgreSQL
    -> Remove the temporary checkout and refresh dashboard cards
```

An existing regular root Dockerfile always takes precedence and is unchanged. Without one:

- **Vite:** requires a Vite dependency or recognized React plugin, a build script invoking `vite build`, and root `index.html`. Node 22 installs dependencies (`npm ci` with an npm lockfile, otherwise `npm install`) and runs the build. nginx serves `dist/`, including SPA route fallback, on the supplied container port.
- **Node.js:** supports `npm start` using `node <existing JavaScript file>` (optionally `--enable-source-maps`), or npm's default root `server.js`. Node 22 installs production dependencies and runs `npm start` as a non-root user. The app must honor `PORT` and listen on a container-accessible interface; MiniCloud also sets `HOST=0.0.0.0`.

Generated Dockerfiles and nginx configuration exist only in the temporary checkout; nothing is committed or pushed to the source repository. Generated builds exclude local dependencies, Git metadata, environment files, npm configuration, logs, and prior build output. Existing Dockerfile builds retain the repository's own ignore rules, while Git metadata is excluded from the context.

Detection reads files as data. Git runs with a fixed argument list and disabled user configuration, credential helpers, and hooks. Repository installation scripts and builds run inside Docker, not directly on the control-plane host. Docker isolation does not make arbitrary untrusted code safe; use repositories you trust.

Unsupported or ambiguous projects fail clearly:

> MiniCloud could not automatically determine how to containerize this repository. Add a Dockerfile manually.

Clone/build/start/save failures return useful errors and attempt to remove the new container and image tag; temporary checkouts are removed afterward. Failed builds do not create normal application registrations. Docker may retain base images and build cache.

Successful source deployments store repository URL, branch, deployment timestamp, build status, and the generated image tag. The detected project type appears in the response/Output panel. Existing container actions continue working. **Deploy** starts the saved image; it does not fetch new source. To rebuild source, delete the registration and submit again. Delete removes the container and database record, but retains successful images.

## Tests and checks

Safe local checks (no live application/database changes):

```sh
npm --prefix control-plane run build
npm --prefix control-plane run test:projects
git diff --check
```

Detection tests use temporary local fixtures. They require the database environment variables to be configured, but do not connect to PostgreSQL or build Docker images.

Live integration tests require PostgreSQL and Docker; source tests also need GitHub access. Use a development database and available test ports:

```sh
npm --prefix control-plane run test:persistence
npm --prefix control-plane run test:source
npm --prefix control-plane run test:auto
```

- `test:persistence`: uses control-plane port 8082, sample ports 3002–3004, and leaves Pineapple running and Banana stopped. Requires the sample image.
- `test:source`: uses control-plane port 8083 and application ports 3010–3011; checks existing Dockerfile deployment, validation, cleanup, persistence, and lifecycle actions. Removes its disposable registrations/resources.
- `test:auto`: uses control-plane port 8084 and application ports 3006, 3015–3016; tests FocusFlow/Vite, a public Node backend, unsupported projects, build/install errors, cleanup, and restart persistence. Leaves FocusFlow registered at port 3006; reuses it on subsequent runs.

Integration tests submit the dashboard's actual JavaScript form handler using a minimal test DOM; they are not full browser tests. Do not run integration suites concurrently against the same registry.

## Current limitations

- Local, unauthenticated dashboard; no production access-control system.
- Public HTTPS GitHub repositories only; no tokens, private repositories, SSH, GitHub Enterprise, redirects, Git LFS, or submodule checkout.
- Root build context only. Automatic builds support npm, static Vite with default `dist/` output, and basic JavaScript Node backends. Monorepos, SSR, custom output directories, TypeScript backend compilation, and other frameworks need a Dockerfile.
- No application environment-variable management, build secrets, build arguments, Compose application deployment, or automatic redeployment. Applications such as FocusFlow still require their own service configuration for features that depend on Firebase/Spotify.
- Docker Engine's default API builder is used; BuildKit-only features are unsupported by this build path.
- Builds are synchronous; one registration/build runs at a time. Competing registration requests return 409. GitHub rate limits apply; public verification, clone, and build have timeouts.
- Runtime status is container state, not HTTP readiness or health monitoring. Status updates occur during actions, startup, and explicit status requests.
- Docker and PostgreSQL cannot share a transaction. Cleanup compensates for ordinary failures; abrupt process/machine crashes or ambiguous commits can require manual resource cleanup. Successful image tags and Docker build cache are retained.

## Future roadmap — NOT YET IMPLEMENTED

Possible future milestones include application environment-variable configuration, source redeployment, authentication/private repository access, background workers and scheduling, monitoring, and scaling/load balancing. Redis, autoscaling, and Kubernetes are not implemented. These are ideas, not current capabilities or delivery commitments.

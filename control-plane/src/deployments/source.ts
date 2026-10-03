import Docker, { Container } from "dockerode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ApplicationRegistry, NewApplication, RegistryError } from "../applications/registry.js";
import { prepareProject } from "./projects.js";
import { DockerControl } from "../docker/control.js";

const exec = promisify(execFile);

export interface SourceInput {
  name: string;
  repositoryUrl: string;
  branch: string;
  containerPort: number;
  hostPort: number;
}

export function sourceInput(body: Record<string, unknown>): SourceInput {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) throw new RegistryError("Application name is required and must be at most 100 characters", 400);
  const rawUrl = typeof body.repositoryUrl === "string" ? body.repositoryUrl.trim() : "";
  // A strict allowlist excludes credentials, SSH, local paths, query strings, redirects, and arbitrary hosts.
  const match = rawUrl.match(/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/?$/);
  if (!match) throw new RegistryError("Use a public repository URL like https://github.com/owner/repository (HTTPS only)", 400);
  const repository = match[2].replace(/\.git$/, "");
  if (!repository || repository === "." || repository === "..") throw new RegistryError("Invalid GitHub repository name", 400);
  if (body.branch !== undefined && typeof body.branch !== "string") throw new RegistryError("Branch must be a string", 400);
  const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
      branch.includes("..") || branch.includes("//") || branch.endsWith(".") ||
      branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new RegistryError("Invalid branch name", 400);
  }
  for (const value of [body.containerPort, body.hostPort]) {
    if (!(typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))) {
      throw new RegistryError("containerPort and hostPort must be integer port numbers", 400);
    }
  }
  const containerPort = Number(body.containerPort), hostPort = Number(body.hostPort);
  if (![containerPort, hostPort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new RegistryError("containerPort and hostPort must be integers from 1 to 65535", 400);
  }
  return { name, repositoryUrl: `https://github.com/${match[1]}/${repository}`, branch, containerPort, hostPort };
}

export function sourceContainerName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  if (!slug) throw new RegistryError("Application name must contain at least one letter or number", 400);
  return `minicloud-source-${slug}`;
}

export async function clonePublicRepository(input: SourceInput, directory: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${input.repositoryUrl.slice("https://github.com/".length)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "MiniCloud/0.4" },
      redirect: "error", signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new RegistryError("Could not verify the public GitHub repository. Check connectivity and the repository URL.", 502);
  }
  if (response.status === 403 || response.status === 429) throw new RegistryError("GitHub public API rate limit reached. Try again later.", 502);
  if (!response.ok) throw new RegistryError("Public GitHub repository not found. Private repositories and redirected URLs are unsupported.", 400);
  const metadata = await response.json() as { private?: boolean; visibility?: string };
  if (metadata.private !== false || metadata.visibility !== "public") throw new RegistryError("Only public GitHub repositories are supported", 400);

  const checkout = join(directory, "repository");
  const hooks = join(directory, "empty-hooks");
  await mkdir(hooks);
  try {
    // Fixed executable/argument list, no shell, hooks, credential helpers, filters, or user Git configuration.
    await exec("git", ["-c", "credential.helper=", "-c", `core.hooksPath=${hooks}`,
      "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false",
      "clone", "--depth", "1", "--single-branch", "--no-tags", "--no-recurse-submodules",
      `--template=${hooks}`, "--branch", input.branch, "--", `${input.repositoryUrl}.git`, checkout], {
      env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: devNull,
        GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      timeout: 120000, maxBuffer: 1024 * 1024
    });
  } catch (error) {
    const detail = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).slice(-2000) : message(error);
    throw new RegistryError(`Git clone failed. Check that branch '${input.branch}' exists. ${detail}`, 422);
  }
  return checkout;
}

async function checkHostPort(hostPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new RegistryError(`Host port ${hostPort} is already in use or unavailable`, 409)));
    probe.listen({ host: "127.0.0.1", port: hostPort, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function buildImage(docker: Docker, checkout: string, image: string, attempt: string): Promise<string> {
  let dockerfile;
  try { dockerfile = await lstat(join(checkout, "Dockerfile")); } catch { /* handled below */ }
  if (!dockerfile?.isFile()) throw new RegistryError("Repository must contain a regular Dockerfile at its root", 422);
  const ignorePath = join(checkout, ".dockerignore");
  const ignore = await lstat(ignorePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (ignore && !ignore.isFile()) throw new RegistryError(".dockerignore must be a regular file", 422);
  // Exclude Git metadata. Dockerode packages the checkout and applies its .dockerignore.
  const entries = (await readdir(checkout)).filter(entry => entry !== ".git");
  let output = "";
  try {
    const stream = await docker.buildImage({ context: checkout, src: entries }, {
      t: image, rm: true, forcerm: true,
      labels: { "minicloud.source": "github", "minicloud.deployment": attempt },
      abortSignal: AbortSignal.timeout(600000)
    });
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, error => error ? reject(error) : resolve(), event => {
        output = (output + (event.stream ?? event.error ?? "")).slice(-12000);
      });
    });
    await docker.getImage(image).inspect();
  } catch (error) {
    throw new RegistryError(`Docker build failed: ${message(error)}\n${output}`, 422);
  }
  return output;
}

export class SourceDeployer {
  constructor(
    private readonly registry: ApplicationRegistry,
    private readonly docker = new Docker(),
    private readonly clone = clonePublicRepository
  ) {}

  async deploy(body: Record<string, unknown>): Promise<unknown> {
    const input = sourceInput(body);
    const attempt = randomUUID();
    const image = `minicloud-source:${attempt}`;
    const application: NewApplication = { name: input.name, image, containerName: sourceContainerName(input.name),
      containerPort: input.containerPort, hostPort: input.hostPort };
    let directory: string | undefined;
    let container: Container | undefined;
    let committed = false;
    let buildAttempted = false;
    try {
      const result = await this.registry.withRegistration(application, async client => {
        const existing = await this.docker.listContainers({ all: true });
        if (existing.some(item => item.Names.includes(`/${application.containerName}`))) {
          throw new RegistryError(`Docker container '${application.containerName}' already exists`, 409);
        }
        if (existing.some(item => item.Ports.some(port => port.PublicPort === input.hostPort))) {
          throw new RegistryError(`Host port ${input.hostPort} is already used by Docker`, 409);
        }
        await checkHostPort(input.hostPort);
        directory = await mkdtemp(join(tmpdir(), "minicloud-build-"));
        const checkout = await this.clone(input, directory);
        const project = await prepareProject(checkout, input.containerPort);
        buildAttempted = true;
        const buildOutput = await buildImage(this.docker, checkout, image, attempt);
        // Recheck after a potentially lengthy build. Docker start is the final binding authority.
        await checkHostPort(input.hostPort);
        const control = new DockerControl({ ...application, imageName: image }, this.docker);
        const deployed = await control.deployNew(created => { container = created; });
        await new Promise(resolve => setTimeout(resolve, 500));
        const status = await control.status();
        if (!status.running) throw new RegistryError(`Container exited after startup.\n${await control.logs(30)}`, 422);
        const saved = await this.registry.insert(application, client, {
          repositoryUrl: input.repositoryUrl, branch: input.branch, status: status.state
        });
        return { application: saved, message: deployed.message, status, buildOutput, ...project };
      });
      committed = true;
      return result;
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (container) {
        try { await container.remove({ force: true }); } catch (cleanup) { cleanupErrors.push(`container ${container.id}: ${message(cleanup)}`); }
      }
      if (buildAttempted) try { await this.docker.getImage(image).remove(); } catch (cleanup) {
        if (!(typeof cleanup === "object" && cleanup !== null && "statusCode" in cleanup && cleanup.statusCode === 404)) cleanupErrors.push(`image ${image}: ${message(cleanup)}`);
      }
      if (cleanupErrors.length) throw new RegistryError(`${message(error)}\nCleanup needs attention: ${cleanupErrors.join("; ")}`, 500);
      if (!(error instanceof RegistryError) && /already allocated|address already in use|failed to bind host port|Conflict.*container name/i.test(message(error))) {
        throw new RegistryError(message(error), 409);
      }
      throw error;
    } finally {
      if (directory) {
        try { await rm(directory, { recursive: true, force: true }); } catch (error) {
          // A saved running app must not be reported as failed because temporary-file cleanup failed.
          console.error(`Temporary checkout cleanup failed (${directory}, committed=${committed}): ${message(error)}`);
        }
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

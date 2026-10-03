import { lstat, readFile, writeFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { RegistryError } from "../applications/registry.js";

export interface PreparedProject {
  projectType: "Existing Dockerfile" | "Vite" | "Node.js";
  detectionReason: string;
}

function unsupported(reason: string): never {
  throw new RegistryError(`MiniCloud could not automatically determine how to containerize this repository. Add a Dockerfile manually. ${reason}`, 422);
}

async function regularFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (info && !info.isFile()) unsupported(`${relative(join(path, ".."), path)} must be a regular file, not a directory or symbolic link.`);
  return Boolean(info);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function nodeEntry(checkout: string, script: unknown): Promise<boolean> {
  if (typeof script !== "string") return false;
  // Basic JavaScript entrypoints only; no TypeScript runners, dev servers, or shell pipelines.
  const match = script.trim().match(/^node\s+(?:--enable-source-maps\s+)?([A-Za-z0-9_./-]+\.(?:js|cjs|mjs))$/);
  if (!match || match[1].split("/").includes("..") || /^(?:\.\/)?(?:dist|build)\//.test(match[1])) return false;
  const path = join(checkout, match[1]);
  if (!await regularFile(path)) return false;
  // Reject entrypoints in directories symlinked outside the checkout.
  const actual = relative(await realpath(checkout), await realpath(path));
  return actual !== ".." && !actual.startsWith("../") && !isAbsolute(actual);
}

export async function prepareProject(checkout: string, containerPort: number): Promise<PreparedProject> {
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new RegistryError("Invalid container port", 400);
  if (await regularFile(join(checkout, "Dockerfile"))) {
    return { projectType: "Existing Dockerfile", detectionReason: "Using the repository's root Dockerfile unchanged." };
  }
  if (!await regularFile(join(checkout, "package.json"))) unsupported("No root package.json was found.");
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
    manifest = parsed as Record<string, unknown>;
  } catch { unsupported("package.json is not a valid JSON object."); }
  if (manifest.workspaces) unsupported("Workspaces and monorepos require an explicit Dockerfile.");
  if (manifest.packageManager && !(typeof manifest.packageManager === "string" && /^npm(?:@|$)/.test(manifest.packageManager))) {
    unsupported("Automatic builds currently support npm projects only.");
  }
  const locks: string[] = [];
  for (const name of ["npm-shrinkwrap.json", "package-lock.json"]) {
    if (await regularFile(join(checkout, name))) locks.push(name);
  }
  if (!locks.length) {
    for (const name of ["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]) {
      if (await lstat(join(checkout, name)).catch(() => undefined)) unsupported("A non-npm lockfile was found; use a Dockerfile for that package manager.");
    }
  }
  const scripts = object(manifest.scripts);
  const dependencies = { ...object(manifest.dependencies), ...object(manifest.devDependencies) };
  const build = typeof scripts.build === "string" ? scripts.build : "";
  const hasVite = "vite" in dependencies || "@vitejs/plugin-react" in dependencies || "@vitejs/plugin-react-swc" in dependencies;
  let project: PreparedProject;
  let nginxConfig: string | undefined;
  let dockerfile: string;
  const copyManifest = `COPY ${JSON.stringify(["package.json", ...locks, "./"])}\n`;
  const install = locks.length ? "npm ci" : "npm install";

  if (hasVite) {
    if (!/(?:^|[;&|]\s*)vite\s+build(?:\s|$)/.test(build) || !await regularFile(join(checkout, "index.html"))) {
      unsupported("Vite needs a build script invoking 'vite build' and a root index.html.");
    }
    const viteStart = scripts.start === undefined || (typeof scripts.start === "string" && /^vite(?:\s|$)/.test(scripts.start.trim()));
    if (!viteStart || await nodeEntry(checkout, scripts.start) || /--(?:ssr|watch|outDir|config)(?:\s|=|$)/.test(build) ||
        ["next", "@sveltejs/kit", "astro", "@angular/core"].some(name => name in dependencies)) {
      unsupported("SSR, custom build outputs, and combined frontend/backend projects require a Dockerfile.");
    }
    // Inspect configuration as text only; never import or evaluate repository code on the host.
    for (const extension of ["js", "ts", "mjs", "cjs", "mts", "cts"]) {
      const configPath = join(checkout, `vite.config.${extension}`);
      if (await regularFile(configPath)) {
        const config = await readFile(configPath, "utf8");
        if (/\bssr\s*:/.test(config) || (/\boutDir\s*:/.test(config) && !/\boutDir\s*:\s*['"](?:\.\/)?dist\/?['"]/.test(config))) {
          unsupported("Only static Vite builds with the default dist output are supported automatically.");
        }
      }
    }
    nginxConfig = `.minicloud-nginx-${randomUUID()}.conf`;
    await writeFile(join(checkout, nginxConfig), `server {
    listen ${containerPort};
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    location /assets/ { try_files $uri =404; }
    location / { try_files $uri $uri/ /index.html; }
}
`, { flag: "wx" });
    dockerfile = `FROM node:22-bookworm-slim AS build
WORKDIR /app
${copyManifest}RUN ${install} --include=dev --no-audit --no-fund
COPY . .
RUN npm run build && test -f dist/index.html

FROM nginx:stable-alpine
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY ${nginxConfig} /etc/nginx/conf.d/default.conf
EXPOSE ${containerPort}
CMD ["nginx", "-g", "daemon off;"]
`;
    project = { projectType: "Vite", detectionReason: `Vite dependency, production build script, and root index.html detected. Building with Node 22 and serving dist with nginx on port ${containerPort}.` };
  } else {
    if (build.trim()) unsupported("Node backends with a build script require an explicit Dockerfile; automatic Node builds support plain JavaScript only.");
    const explicitStart = await nodeEntry(checkout, scripts.start);
    const defaultStart = scripts.start === undefined && await regularFile(join(checkout, "server.js"));
    if (!explicitStart && !defaultStart) unsupported("A basic Node.js app needs 'start': 'node <existing-file.js>' or npm's default server.js entrypoint.");
    dockerfile = `FROM node:22-bookworm-slim
WORKDIR /app
${copyManifest}RUN ${install} --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV PORT=${containerPort}
ENV HOST=0.0.0.0
EXPOSE ${containerPort}
USER node
CMD ["npm", "start"]
`;
    project = { projectType: "Node.js", detectionReason: `Using ${explicitStart ? `npm start (${scripts.start})` : "npm start's default server.js entrypoint"} with production dependencies, Node 22, and PORT=${containerPort}.` };
  }

  // Temporary checkout only. Preserve existing ignore rules and add safe defaults plus
  // exceptions for generated files and manifests that the Docker build must receive.
  const ignorePath = join(checkout, ".dockerignore");
  const existingIgnore = await regularFile(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  const required = ["Dockerfile", "package.json", ...locks, ...(nginxConfig ? [nginxConfig] : [])];
  const ignores = [".git", "**/node_modules", "dist", "build", "coverage", "**/.env", "**/.env.*", "**/*.env", "**/*.env.*", "**/.npmrc", "**/*.log"];
  await writeFile(ignorePath, `${existingIgnore}\n# MiniCloud automatic build (temporary checkout only)\n${ignores.join("\n")}\n${required.map(name => `!${name}`).join("\n")}\n`);
  await writeFile(join(checkout, "Dockerfile"), dockerfile, { flag: "wx" });
  return project;
}

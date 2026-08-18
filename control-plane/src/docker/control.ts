import Docker, { Container } from "dockerode";
import { PassThrough, Writable } from "node:stream";

export interface ActionResult {
  message: string;
  status: ContainerStatus;
}

export interface ContainerStatus {
  name: string;
  state: string;
  running: boolean;
  image: string;
  startedAt: string | null;
  url: string | null;
  error: string | null;
}

export interface DockerControlOptions {
  containerName: string;
  imageName: string;
  containerPort: number;
  hostPort: number;
}

export class DockerControl {
  private readonly docker: Docker;

  private readonly options: DockerControlOptions;

  constructor(
    options: Partial<DockerControlOptions> = {},
    docker = new Docker()
  ) {
    this.options = {
      containerName: options.containerName ?? process.env.MINICLOUD_CONTAINER ?? "minicloud-sample",
      imageName: options.imageName ?? process.env.MINICLOUD_IMAGE ?? "minicloud-sample",
      containerPort: options.containerPort ?? 3000,
      hostPort: options.hostPort ?? Number(process.env.MINICLOUD_PORT ?? "3000")
    };
    this.docker = docker;
  }

  async deploy(): Promise<ActionResult> {
    const container = (await this.findContainer()) ?? (await this.createContainer());
    const details = await container.inspect();

    if (details.State.Running) {
      return { message: `${this.options.containerName} is already running.`, status: this.toStatus(details) };
    }

    await container.start();
    return {
      message: `${this.options.containerName} started at http://localhost:${this.options.hostPort}`,
      status: await this.status()
    };
  }

  async stop(): Promise<ActionResult> {
    const container = await this.findContainer();
    if (!container) {
      return { message: `${this.options.containerName} does not exist.`, status: this.missingStatus() };
    }

    const details = await container.inspect();
    if (!details.State.Running) {
      return { message: `${this.options.containerName} is already stopped.`, status: this.toStatus(details) };
    }

    await container.stop({ t: 10 });
    return { message: `${this.options.containerName} stopped.`, status: await this.status() };
  }

  async restart(): Promise<ActionResult> {
    const container = await this.findContainer();
    if (!container) {
      const result = await this.deploy();
      return { ...result, message: `${this.options.containerName} did not exist; it was created and started.` };
    }

    const details = await container.inspect();
    if (details.State.Running) await container.restart({ t: 10 });
    else await container.start();

    return {
      message: `${this.options.containerName} restarted at http://localhost:${this.options.hostPort}`,
      status: await this.status()
    };
  }

  async status(): Promise<ContainerStatus> {
    const container = await this.findContainer();
    if (!container) return this.missingStatus();
    return this.toStatus(await container.inspect());
  }

  async logs(tail = 100): Promise<string> {
    this.validateTail(tail);
    const container = await this.findContainer();
    if (!container) return `${this.options.containerName} does not exist.\n`;

    const output = await container.logs({ stdout: true, stderr: true, timestamps: true, tail, follow: false });
    if (typeof output === "string") return output;
    return this.demuxBuffer(output);
  }

  async followLogs(tail = 100): Promise<void> {
    this.validateTail(tail);
    const container = await this.findContainer();
    if (!container) {
      process.stdout.write(`${this.options.containerName} does not exist.\n`);
      return;
    }
    const stream = await container.logs({ stdout: true, stderr: true, timestamps: true, tail, follow: true });
    container.modem.demuxStream(stream, process.stdout, process.stderr);
  }

  async remove(): Promise<void> {
    const container = await this.findContainer();
    if (!container) return;
    const details = await container.inspect();
    if (details.State.Running) await container.stop({ t: 10 });
    await container.remove();
  }

  private async findContainer(): Promise<Container | undefined> {
    const container = this.docker.getContainer(this.options.containerName);
    try {
      await container.inspect();
      return container;
    } catch (error) {
      if (isDockerError(error, 404)) return undefined;
      throw error;
    }
  }

  private createContainer(): Promise<Container> {
    return this.docker.createContainer({
      name: this.options.containerName,
      Image: this.options.imageName,
      ExposedPorts: { [`${this.options.containerPort}/tcp`]: {} },
      HostConfig: {
        PortBindings: {
          [`${this.options.containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(this.options.hostPort) }]
        }
      }
    });
  }

  private toStatus(details: Docker.ContainerInspectInfo): ContainerStatus {
    return {
      name: this.options.containerName,
      state: details.State.Status,
      running: details.State.Running,
      image: details.Config.Image,
      startedAt: details.State.StartedAt || null,
      url: details.State.Running ? `http://localhost:${this.options.hostPort}` : null,
      error: details.State.Error || null
    };
  }

  private missingStatus(): ContainerStatus {
    return { name: this.options.containerName, state: "not created", running: false, image: this.options.imageName, startedAt: null, url: null, error: null };
  }

  private validateTail(tail: number): void {
    if (!Number.isInteger(tail) || tail < 0) throw new Error("tail must be a non-negative integer");
  }

  private demuxBuffer(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = "";
      const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
      output.on("error", reject);
      const input = new PassThrough();
      this.docker.modem.demuxStream(input, output, output);
      input.on("end", () => resolve(text));
      input.on("error", reject);
      input.end(buffer);
    });
  }
}

function isDockerError(error: unknown, statusCode: number): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === statusCode;
}

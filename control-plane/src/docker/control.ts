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

export class DockerControl {
  private readonly docker: Docker;

  constructor(
    private readonly containerName = process.env.MINICLOUD_CONTAINER ?? "minicloud-sample",
    private readonly imageName = process.env.MINICLOUD_IMAGE ?? "minicloud-sample",
    private readonly hostPort = process.env.MINICLOUD_PORT ?? "3000",
    docker = new Docker()
  ) {
    this.docker = docker;
  }

  async deploy(): Promise<ActionResult> {
    const container = (await this.findContainer()) ?? (await this.createContainer());
    const details = await container.inspect();

    if (details.State.Running) {
      return { message: `${this.containerName} is already running.`, status: this.toStatus(details) };
    }

    await container.start();
    return {
      message: `${this.containerName} started at http://localhost:${this.hostPort}`,
      status: await this.status()
    };
  }

  async stop(): Promise<ActionResult> {
    const container = await this.findContainer();
    if (!container) {
      return { message: `${this.containerName} does not exist.`, status: this.missingStatus() };
    }

    const details = await container.inspect();
    if (!details.State.Running) {
      return { message: `${this.containerName} is already stopped.`, status: this.toStatus(details) };
    }

    await container.stop({ t: 10 });
    return { message: `${this.containerName} stopped.`, status: await this.status() };
  }

  async restart(): Promise<ActionResult> {
    const container = await this.findContainer();
    if (!container) {
      const result = await this.deploy();
      return { ...result, message: `${this.containerName} did not exist; it was created and started.` };
    }

    const details = await container.inspect();
    if (details.State.Running) await container.restart({ t: 10 });
    else await container.start();

    return {
      message: `${this.containerName} restarted at http://localhost:${this.hostPort}`,
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
    if (!container) return `${this.containerName} does not exist.\n`;

    const output = await container.logs({ stdout: true, stderr: true, timestamps: true, tail, follow: false });
    if (typeof output === "string") return output;
    return this.demuxBuffer(output);
  }

  async followLogs(tail = 100): Promise<void> {
    this.validateTail(tail);
    const container = await this.findContainer();
    if (!container) {
      process.stdout.write(`${this.containerName} does not exist.\n`);
      return;
    }
    const stream = await container.logs({ stdout: true, stderr: true, timestamps: true, tail, follow: true });
    container.modem.demuxStream(stream, process.stdout, process.stderr);
  }

  private async findContainer(): Promise<Container | undefined> {
    const container = this.docker.getContainer(this.containerName);
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
      name: this.containerName,
      Image: this.imageName,
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: { PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: this.hostPort }] } }
    });
  }

  private toStatus(details: Docker.ContainerInspectInfo): ContainerStatus {
    return {
      name: this.containerName,
      state: details.State.Status,
      running: details.State.Running,
      image: details.Config.Image,
      startedAt: details.State.StartedAt || null,
      url: details.State.Running ? `http://localhost:${this.hostPort}` : null,
      error: details.State.Error || null
    };
  }

  private missingStatus(): ContainerStatus {
    return { name: this.containerName, state: "not created", running: false, image: this.imageName, startedAt: null, url: null, error: null };
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

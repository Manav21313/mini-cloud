import { randomUUID } from "node:crypto";

export interface Application {
  id: string;
  name: string;
  image: string;
  containerName: string;
  containerPort: number;
  hostPort: number;
  status: string;
}

export type NewApplication = Omit<Application, "id" | "status">;

export class ApplicationRegistry {
  private readonly applications = new Map<string, Application>();

  constructor(initial: Application[] = []) {
    initial.forEach((application) => this.applications.set(application.id, application));
  }

  list(): Application[] {
    return [...this.applications.values()];
  }

  get(id: string): Application | undefined {
    return this.applications.get(id);
  }

  create(input: NewApplication): Application {
    this.validate(input);
    const application: Application = { id: randomUUID(), ...input, status: "not created" };
    this.applications.set(application.id, application);
    return application;
  }

  setStatus(id: string, status: string): Application {
    const application = this.require(id);
    application.status = status;
    return application;
  }

  delete(id: string): boolean {
    return this.applications.delete(id);
  }

  require(id: string): Application {
    const application = this.get(id);
    if (!application) throw new RegistryError("Application not found", 404);
    return application;
  }

  private validate(input: NewApplication): void {
    if (!input.name?.trim() || !input.image?.trim() || !input.containerName?.trim()) {
      throw new RegistryError("name, image, and containerName are required", 400);
    }
    if (!isPort(input.containerPort) || !isPort(input.hostPort)) {
      throw new RegistryError("containerPort and hostPort must be integers from 1 to 65535", 400);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.containerName)) {
      throw new RegistryError("containerName contains invalid characters", 400);
    }
    if (this.list().some((app) => app.containerName === input.containerName)) {
      throw new RegistryError("containerName is already registered", 409);
    }
    if (this.list().some((app) => app.hostPort === input.hostPort)) {
      throw new RegistryError("hostPort is already registered", 409);
    }
  }
}

export class RegistryError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

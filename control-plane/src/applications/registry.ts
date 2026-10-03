import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

export interface Application {
  id: string;
  name: string;
  image: string;
  containerName: string;
  containerPort: number;
  hostPort: number;
  status: string;
  createdAt: string;
}

export type NewApplication = Omit<Application, "id" | "status" | "createdAt">;

export class ApplicationRegistry {
  async list(): Promise<Application[]> {
    const result = await pool.query(`SELECT ${columns} FROM applications ORDER BY created_at, id`);
    return result.rows.map(toApplication);
  }

  async create(input: NewApplication): Promise<Application> {
    this.validate(input);
    try {
      const result = await pool.query(`INSERT INTO applications
        (id, name, docker_image, container_name, container_port, host_port, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${columns}`,
        [randomUUID(), input.name, input.image, input.containerName, input.containerPort, input.hostPort, "not created"]);
      return toApplication(result.rows[0]);
    } catch (error) {
      // Database uniqueness constraints also protect concurrent registrations.
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new RegistryError("containerName or hostPort is already registered", 409);
      }
      throw error;
    }
  }

  async setStatus(id: string, status: string): Promise<Application> {
    const result = await pool.query(`UPDATE applications SET status = $2 WHERE id = $1 RETURNING ${columns}`, [id, status]);
    if (!result.rows[0]) throw new RegistryError("Application not found", 404);
    return toApplication(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    await pool.query("DELETE FROM applications WHERE id = $1", [id]);
  }

  async require(id: string): Promise<Application> {
    const result = await pool.query(`SELECT ${columns} FROM applications WHERE id = $1`, [id]);
    if (!result.rows[0]) throw new RegistryError("Application not found", 404);
    return toApplication(result.rows[0]);
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

const columns = `id, name, docker_image AS image, container_name AS "containerName",
  container_port AS "containerPort", host_port AS "hostPort", status, created_at AS "createdAt"`;

function toApplication(row: Omit<Application, "createdAt"> & { createdAt: Date }): Application {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

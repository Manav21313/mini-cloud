import { randomUUID } from "node:crypto";
import { PoolClient } from "pg";
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
  repositoryUrl: string | null;
  branch: string | null;
  lastDeployedAt: string | null;
  buildStatus: string | null;
}

export type NewApplication = Omit<Application, "id" | "status" | "createdAt" | "repositoryUrl" | "branch" | "lastDeployedAt" | "buildStatus">;

export class ApplicationRegistry {
  async list(): Promise<Application[]> {
    const result = await pool.query(`SELECT ${columns} FROM applications ORDER BY created_at, id`);
    return result.rows.map(toApplication);
  }

  async create(input: NewApplication): Promise<Application> {
    return this.withRegistration(input, (client) => this.insert(input, client));
  }

  async withRegistration<T>(input: NewApplication, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.validate(input);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One registration/build at a time; fail fast rather than hold requests in a queue.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(738104) AS acquired");
      if (!lock.rows[0].acquired) throw new RegistryError("Another registration or source deployment is in progress. Try again when it finishes.", 409);
      const conflict = await client.query(`SELECT name, container_name, host_port FROM applications
        WHERE lower(name) = lower($1) OR container_name = $2 OR host_port = $3`,
        [input.name, input.containerName, input.hostPort]);
      if (conflict.rowCount) throw new RegistryError("Application name, containerName, or hostPort is already registered", 409);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new RegistryError("containerName or hostPort is already registered", 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async insert(input: NewApplication, client: PoolClient, source?: {
    repositoryUrl: string; branch: string; status: string;
  }): Promise<Application> {
    const result = await client.query(`INSERT INTO applications
      (id, name, docker_image, container_name, container_port, host_port, status,
       repository_url, branch, last_deployed_at, build_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${columns}`,
      [randomUUID(), input.name, input.image, input.containerName, input.containerPort, input.hostPort,
       source?.status ?? "not created", source?.repositoryUrl ?? null, source?.branch ?? null,
       source ? new Date() : null, source ? "succeeded" : null]);
    return toApplication(result.rows[0]);
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
  container_port AS "containerPort", host_port AS "hostPort", status, created_at AS "createdAt",
  repository_url AS "repositoryUrl", branch, last_deployed_at AS "lastDeployedAt", build_status AS "buildStatus"`;

function toApplication(row: Omit<Application, "createdAt" | "lastDeployedAt"> & { createdAt: Date; lastDeployedAt: Date | null }): Application {
  return { ...row, createdAt: row.createdAt.toISOString(), lastDeployedAt: row.lastDeployedAt?.toISOString() ?? null };
}

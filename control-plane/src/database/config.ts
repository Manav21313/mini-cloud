import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

// Locate the root .env from both src/ (tsx) and dist/ (node).
try {
  loadEnvFile(resolve(__dirname, "..", "..", "..", ".env"));
} catch (error) {
  if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
}

export const sampleApplication = {
  id: "minicloud-sample",
  name: "MiniCloud Sample",
  image: process.env.MINICLOUD_IMAGE ?? "minicloud-sample",
  containerName: process.env.MINICLOUD_CONTAINER ?? "minicloud-sample",
  containerPort: 3000,
  hostPort: Number(process.env.MINICLOUD_PORT ?? "3000"),
  status: "unknown"
};

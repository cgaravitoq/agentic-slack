import { describe, expect, test } from "bun:test";
import app from "../src";

describe("GET /health", () => {
  test("reports that the Worker is healthy", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

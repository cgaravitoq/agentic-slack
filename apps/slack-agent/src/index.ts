import { Hono } from "hono";

const app = new Hono();

app.get("/health", (context) => context.json({ status: "ok" }));

export default app;

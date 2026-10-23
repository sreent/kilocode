import { Hono } from "hono"
import type { Env } from "./context"

export const admin = new Hono<Env>()

admin.get("/admin", (c) => c.text("admin console"))

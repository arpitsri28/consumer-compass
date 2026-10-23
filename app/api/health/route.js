import { createHealthHandler } from "../../lib/server/health.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createHealthHandler();

import { createHealthHandler } from "../../lib/server/health.js";
import { withRequestLogging } from "../../lib/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(createHealthHandler(), "/api/health");

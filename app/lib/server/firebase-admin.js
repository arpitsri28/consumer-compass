import "server-only";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { HttpError } from "./errors.js";
import { setRequestUser } from "./logger.js";

const APP_NAME = "consumer-compass-server";

export function readServiceAccount(env = process.env) {
  try {
    const account = env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : {
          project_id: env.FIREBASE_ADMIN_PROJECT_ID,
          client_email: env.FIREBASE_ADMIN_CLIENT_EMAIL,
          private_key: env.FIREBASE_ADMIN_PRIVATE_KEY,
        };
    if (![account.project_id, account.client_email, account.private_key]
      .every((value) => typeof value === "string" && value.trim())) throw new Error();
    return {
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key.replace(/\\n/g, "\n"),
    };
  } catch {
    throw new HttpError(503, "CONFIGURATION_ERROR", "Authentication service is not configured correctly.");
  }
}

function getAdminAuth() {
  try {
    let app = getApps().find((candidate) => candidate.name === APP_NAME);
    if (!app) {
      const account = readServiceAccount();
      app = initializeApp({ credential: cert(account), projectId: account.projectId }, APP_NAME);
    }
    return getAuth(app);
  } catch {
    throw new HttpError(503, "CONFIGURATION_ERROR", "Authentication service is not configured correctly.");
  }
}

const invalidTokenCodes = new Set([
  "auth/argument-error", "auth/invalid-argument", "auth/invalid-id-token",
  "auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found",
]);

export async function verifyRequestUser(request, authFactory = getAdminAuth) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") || "");
  if (!match) {
    throw new HttpError(401, "UNAUTHORIZED", "A Firebase Bearer token is required.");
  }
  const auth = authFactory();
  try {
    const decoded = await auth.verifyIdToken(match[1], true);
    setRequestUser(decoded.uid);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch (error) {
    if (invalidTokenCodes.has(error.code)) {
      throw new HttpError(401, "UNAUTHORIZED", "Your session is invalid or expired. Please sign in again.");
    }
    throw new HttpError(503, "AUTH_UNAVAILABLE", "Authentication service is temporarily unavailable.");
  }
}

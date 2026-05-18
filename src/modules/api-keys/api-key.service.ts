import crypto from "crypto";
import prisma from "../../db/client.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

/**
 * Create an API key bound to a specific workspace. The workspace is taken from
 * the caller's own key (via `callerWorkspaceId`) — there is no UI / API path
 * to create a key for another workspace from outside that workspace, by design.
 *
 * Bootstrap path is the one exception: it passes `default` workspace's id when
 * no keys exist yet so the very first admin key can be minted.
 */
export async function generateKey(
  name: string,
  scope: string = "delivery",
  workspaceId: string,
) {
  const validScopes = ["delivery", "manage", "admin"];
  if (!validScopes.includes(scope)) scope = "delivery";

  const rawKey = "scms_" + crypto.randomBytes(16).toString("hex");
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.substring(0, 13);

  const apiKey = await prisma.apiKey.create({
    data: { name, keyHash, keyPrefix, scope, workspaceId },
  });

  return {
    id: apiKey.id,
    name: apiKey.name,
    scope: apiKey.scope,
    key: rawKey,
    keyPrefix: apiKey.keyPrefix,
    workspaceId: apiKey.workspaceId,
    createdAt: apiKey.createdAt,
  };
}

/**
 * List API keys VISIBLE to the caller. Workspace isolation: each call only
 * returns keys belonging to `callerWorkspaceId`. Cross-workspace key visibility
 * is impossible by design — workspace is treated as a user-level isolation
 * boundary.
 */
export async function listKeys(callerWorkspaceId: string) {
  return prisma.apiKey.findMany({
    where: { workspaceId: callerWorkspaceId },
    select: { id: true, name: true, keyPrefix: true, scope: true, workspaceId: true, revokedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Revoke a key. Caller can only revoke keys in their own workspace.
 * Cross-workspace deletes return 404 (we don't even acknowledge the existence
 * of keys in other workspaces).
 */
export async function revokeKey(callerWorkspaceId: string, id: string) {
  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key || key.workspaceId !== callerWorkspaceId) {
    throw new NotFoundError("ApiKey");
  }
  return prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

export function isRequired(): boolean {
  return process.env.DELIVERY_API_KEY_REQUIRED !== "false";
}

/**
 * Bootstrap the very first admin key when zero keys exist. Pins the key to
 * the `default` workspace so we have a valid workspace_id (NOT NULL column).
 * Operators can create more keys for other workspaces after bootstrap.
 */
export async function bootstrapKey() {
  const count = await prisma.apiKey.count();
  if (count > 0) return null;
  const defaultWs = await prisma.workspace.findUnique({ where: { slug: "default" } });
  if (!defaultWs) throw new BusinessError("Cannot bootstrap: 'default' workspace is missing — run migrations");
  return generateKey("Admin (bootstrap)", "admin", defaultWs.id);
}

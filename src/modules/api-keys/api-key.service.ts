import crypto from "crypto";
import prisma from "../../db/client.js";

export async function generateKey(name: string, scope: string = "delivery") {
  const validScopes = ["delivery", "manage", "admin"];
  if (!validScopes.includes(scope)) scope = "delivery";

  const rawKey = "scms_" + crypto.randomBytes(16).toString("hex");
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.substring(0, 13);

  const apiKey = await prisma.apiKey.create({
    data: { name, keyHash, keyPrefix, scope },
  });

  return {
    id: apiKey.id,
    name: apiKey.name,
    scope: apiKey.scope,
    key: rawKey,
    keyPrefix: apiKey.keyPrefix,
    createdAt: apiKey.createdAt,
  };
}

export async function listKeys() {
  return prisma.apiKey.findMany({
    select: { id: true, name: true, keyPrefix: true, scope: true, revokedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeKey(id: string) {
  return prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

export function isRequired(): boolean {
  return process.env.DELIVERY_API_KEY_REQUIRED !== "false";
}

export async function bootstrapKey() {
  const count = await prisma.apiKey.count();
  if (count > 0) return null;
  return generateKey("Admin (bootstrap)", "admin");
}

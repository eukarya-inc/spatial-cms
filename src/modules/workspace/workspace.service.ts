import prisma from "../../db/client.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

export async function listWorkspaces() {
  return prisma.workspace.findMany({ orderBy: [{ slug: "asc" }] });
}

export async function getWorkspaceBySlug(slug: string) {
  const ws = await prisma.workspace.findUnique({ where: { slug } });
  if (!ws) throw new NotFoundError(`Workspace '${slug}'`);
  return ws;
}

export async function createWorkspace(data: { slug: string; name: string; description?: string }) {
  const existing = await prisma.workspace.findUnique({ where: { slug: data.slug } });
  if (existing) throw new BusinessError(`Workspace '${data.slug}' already exists`);
  return prisma.workspace.create({ data });
}

export async function deleteWorkspace(slug: string) {
  if (slug === "default") throw new BusinessError("Cannot delete the default workspace");
  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { _count: { select: { models: true, datasets: true } } },
  });
  if (!ws) throw new NotFoundError(`Workspace '${slug}'`);
  if (ws._count.models > 0 || ws._count.datasets > 0) {
    throw new BusinessError(
      `Workspace '${slug}' is not empty (${ws._count.models} models, ${ws._count.datasets} datasets). Delete its contents first.`,
    );
  }
  await prisma.workspace.delete({ where: { id: ws.id } });
}

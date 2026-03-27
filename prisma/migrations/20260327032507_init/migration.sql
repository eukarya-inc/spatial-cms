-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('human', 'machine', 'import_');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('draft', 'ready', 'published');

-- CreateEnum
CREATE TYPE "PublicationType" AS ENUM ('publish', 'rollback');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateTable
CREATE TABLE "entity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "geometry" geometry(Geometry, 4326),
    "status" "EntityStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "entity_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID,
    "proposed_change" JSONB NOT NULL,
    "source" "ProposalSource" NOT NULL DEFAULT 'human',
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_definition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "entity_types" JSONB NOT NULL,
    "filter_rule" JSONB,
    "projection_rule" JSONB,
    "primary_geometry_rule" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dataset_definition_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dataset_snapshot_id" UUID NOT NULL,
    "type" "PublicationType" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_release_state" (
    "dataset_definition_id" UUID NOT NULL,
    "active_snapshot_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "active_release_state_pkey" PRIMARY KEY ("dataset_definition_id")
);

-- CreateIndex
CREATE INDEX "entity_type_idx" ON "entity"("type");

-- CreateIndex
CREATE INDEX "entity_status_idx" ON "entity"("status");

-- CreateIndex
CREATE INDEX "entity_version_entity_id_idx" ON "entity_version"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_version_entity_id_version_number_key" ON "entity_version"("entity_id", "version_number");

-- CreateIndex
CREATE INDEX "proposal_entity_id_idx" ON "proposal"("entity_id");

-- CreateIndex
CREATE INDEX "proposal_status_idx" ON "proposal"("status");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_definition_name_key" ON "dataset_definition"("name");

-- CreateIndex
CREATE INDEX "dataset_snapshot_dataset_definition_id_idx" ON "dataset_snapshot"("dataset_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_snapshot_dataset_definition_id_version_key" ON "dataset_snapshot"("dataset_definition_id", "version");

-- CreateIndex
CREATE INDEX "publication_dataset_snapshot_id_idx" ON "publication"("dataset_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "active_release_state_active_snapshot_id_key" ON "active_release_state"("active_snapshot_id");

-- AddForeignKey
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_snapshot" ADD CONSTRAINT "dataset_snapshot_dataset_definition_id_fkey" FOREIGN KEY ("dataset_definition_id") REFERENCES "dataset_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication" ADD CONSTRAINT "publication_dataset_snapshot_id_fkey" FOREIGN KEY ("dataset_snapshot_id") REFERENCES "dataset_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_release_state" ADD CONSTRAINT "active_release_state_dataset_definition_id_fkey" FOREIGN KEY ("dataset_definition_id") REFERENCES "dataset_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_release_state" ADD CONSTRAINT "active_release_state_active_snapshot_id_fkey" FOREIGN KEY ("active_snapshot_id") REFERENCES "dataset_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

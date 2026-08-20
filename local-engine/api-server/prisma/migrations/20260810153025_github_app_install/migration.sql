/*
  Warnings:

  - You are about to drop the column `webhookId` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `webhookSecret` on the `Project` table. All the data in the column will be lost.

*/

-- DropIndex
DROP INDEX "Project_repoFullName_idx";

-- AlterTable
ALTER TABLE "Project" DROP COLUMN "webhookId",
DROP COLUMN "webhookSecret",
ADD COLUMN     "installationId" INTEGER,
ADD COLUMN     "repositoryId" INTEGER;

-- CreateTable
CREATE TABLE "GithubInstallation" (
    "id" UUID NOT NULL,
    "installationId" INTEGER NOT NULL,
    "accountLogin" VARCHAR(255) NOT NULL,
    "accountType" VARCHAR(20) NOT NULL,
    "userId" UUID NOT NULL,
    "suspendedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallation_installationId_key" ON "GithubInstallation"("installationId");

-- CreateIndex
CREATE INDEX "GithubInstallation_userId_idx" ON "GithubInstallation"("userId");

-- CreateIndex
CREATE INDEX "Project_installationId_repositoryId_idx" ON "Project"("installationId", "repositoryId");

-- AddForeignKey
ALTER TABLE "GithubInstallation" ADD CONSTRAINT "GithubInstallation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GithubInstallation"("installationId") ON DELETE SET NULL ON UPDATE CASCADE;

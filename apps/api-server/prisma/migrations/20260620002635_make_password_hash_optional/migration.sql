/*
  Warnings:

  - You are about to drop the column `ts_message` on the `DeploymentLog` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

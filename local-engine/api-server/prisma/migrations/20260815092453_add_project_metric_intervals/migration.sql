-- CreateTable
CREATE TABLE "ProjectMetricInterval" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "intervalStart" TIMESTAMPTZ NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "visitorCount" INTEGER NOT NULL DEFAULT 0,
    "status2xx" INTEGER NOT NULL DEFAULT 0,
    "status3xx" INTEGER NOT NULL DEFAULT 0,
    "status4xx" INTEGER NOT NULL DEFAULT 0,
    "status5xx" INTEGER NOT NULL DEFAULT 0,
    "bytesTransferred" BIGINT NOT NULL DEFAULT 0,
    "responseTimeSumMs" BIGINT NOT NULL DEFAULT 0,
    "responseTimeMaxMs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ProjectMetricInterval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMetricInterval_projectId_intervalStart_idx" ON "ProjectMetricInterval"("projectId", "intervalStart" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMetricInterval_projectId_intervalStart_key" ON "ProjectMetricInterval"("projectId", "intervalStart");

-- AddForeignKey
ALTER TABLE "ProjectMetricInterval" ADD CONSTRAINT "ProjectMetricInterval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

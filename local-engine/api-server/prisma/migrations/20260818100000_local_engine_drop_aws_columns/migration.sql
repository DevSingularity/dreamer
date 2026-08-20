-- Local Engine has no AWS in it — this renames the Deployment columns
-- inherited from the cloud schema off their AWS-flavored names, and
-- drops four columns the cloud schema itself already marked UNUSED
-- (ecsServiceArn, ecsTaskDefArn, albTargetGroupArn, albListenerRuleArn —
-- leftovers from an earlier ECS-Service/ALB design, superseded before
-- local-engine was ever forked from it).

ALTER TABLE "Deployment" RENAME COLUMN "ecsTaskArn" TO "buildContainerId";
ALTER TABLE "Deployment" RENAME COLUMN "ecrImageUri" TO "imageUri";
ALTER TABLE "Deployment" RENAME COLUMN "lambdaFunctionArn" TO "appContainerId";
ALTER TABLE "Deployment" RENAME COLUMN "lambdaFunctionName" TO "appContainerName";
ALTER TABLE "Deployment" RENAME COLUMN "lambdaFunctionUrl" TO "appUrl";
ALTER TABLE "Deployment" RENAME COLUMN "s3Prefix" TO "outputPrefix";

ALTER TABLE "Deployment" DROP COLUMN "ecsServiceArn";
ALTER TABLE "Deployment" DROP COLUMN "ecsTaskDefArn";
ALTER TABLE "Deployment" DROP COLUMN "albTargetGroupArn";
ALTER TABLE "Deployment" DROP COLUMN "albListenerRuleArn";

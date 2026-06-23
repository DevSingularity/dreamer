import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import {
  createDeploymentHandler,
  getDeploymentHandler,
  getDeploymentLogsHandler,
  listDeploymentsHandler,
} from './deployment.controller';
import {
  createDeploymentSchema,
  deploymentIdParamSchema,
  listDeploymentLogsSchema,
  listDeploymentsQuerySchema,
} from './deployment.types';

/**
 * Mounted by project.routes.ts at /api/projects/:projectId/deployments.
 * `mergeParams: true` is required for req.params.projectId — captured by
 * the PARENT router's `:projectId` segment — to be visible inside this
 * router's own handlers. Without it, Express only exposes the params this
 * router captures itself.
 */
export const projectDeploymentsRouter = Router({ mergeParams: true });
projectDeploymentsRouter.post('/', validate(createDeploymentSchema), createDeploymentHandler);
projectDeploymentsRouter.get('/', validate(listDeploymentsQuerySchema), listDeploymentsHandler);

/** Mounted directly at /api/deployments — deployment IDs are globally unique UUIDs, no projectId needed in the path. */
export const deploymentsRouter = Router();
deploymentsRouter.get('/:deploymentId', validate(deploymentIdParamSchema), getDeploymentHandler);
deploymentsRouter.get('/:deploymentId/logs', validate(listDeploymentLogsSchema), getDeploymentLogsHandler);

import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { listBranchesSchema, listRepoDirectorySchema, listReposSchema, searchPublicReposSchema } from './github-repo.types';
import {
  listBranchesHandler,
  listInstallationsHandler,
  listRepoDirectoryHandler,
  listReposHandler,
  searchPublicReposHandler,
} from './github-repo.controller';

/** Mounted at /api/github in app.ts. requireAuth applied at the mount point. */
export const githubRepoRouter = Router();

// NEW — which GitHub accounts/orgs the caller has installed the App on.
githubRepoRouter.get('/installations', listInstallationsHandler);
githubRepoRouter.get('/repos', validate(listReposSchema), listReposHandler);
// Any public repo, independent of installation — see searchPublicReposHandler.
githubRepoRouter.get('/public-repos', validate(searchPublicReposSchema), searchPublicReposHandler);
githubRepoRouter.get('/repo-contents', validate(listRepoDirectorySchema), listRepoDirectoryHandler);
// Shared by the wizard's branch picker and the project-settings Git panel.
githubRepoRouter.get('/branches', validate(listBranchesSchema), listBranchesHandler);

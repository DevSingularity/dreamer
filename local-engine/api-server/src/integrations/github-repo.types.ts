import { z } from 'zod';

// installationId is required when browsing repos WITHIN one installation
// (the picker list itself), but optional everywhere else — repo-contents
// and branches also need to work for a repo found via public search, which
// has no installation behind it at all. See github-repo.controller.ts's
// resolveOptionalOAuthToken for the fallback when it's omitted.
const installationIdField = z.coerce.number().int().positive();

export const listReposSchema = z.object({
  query: z.object({
    installationId: installationIdField,
  }),
});

export type ListReposQuery = z.infer<typeof listReposSchema>['query'];

// NEW — search ANY public GitHub repo by name, independent of any
// installation. See github-repo.service.ts's searchPublicRepos doc comment.
export const searchPublicReposSchema = z.object({
  query: z.object({
    query: z.string().min(1).max(200).trim(),
  }),
});

export type SearchPublicReposQuery = z.infer<typeof searchPublicReposSchema>['query'];

export const listRepoDirectorySchema = z.object({
  query: z.object({
    installationId: installationIdField.optional(),
    repoFullName: z.string().min(1).max(512),
    branch: z.string().min(1).max(255).trim(),
    // Defaults to the repo root — matches the wizard's first call, before
    // the user has expanded any folder.
    path: z.string().max(1024).trim().default(''),
  }),
});

export type ListRepoDirectoryQuery = z.infer<typeof listRepoDirectorySchema>['query'];

// NEW — branch listing, shared by the wizard's branch picker and the
// project-settings "Production Branch" dropdown.
export const listBranchesSchema = z.object({
  query: z.object({
    installationId: installationIdField.optional(),
    repoFullName: z.string().min(1).max(512),
    // The picker needs to know which branch to flag as "default" in the
    // returned list — mirrors how listRepoDirectorySchema takes `branch` as
    // the ref to query, just for a different purpose here.
    defaultBranch: z.string().min(1).max(255).trim(),
  }),
});

export type ListBranchesQuery = z.infer<typeof listBranchesSchema>['query'];

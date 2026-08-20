import { z } from 'zod';
import type { FrameworkPresetId } from './framework-presets';

export const detectBuildConfigSchema = z.object({
  body: z.object({
    // Optional — omitted for a repo picked via public search (no
    // installation behind it). See build-config.controller.ts's
    // resolveDetectionAccessToken for the fallback when it's absent.
    installationId: z.number().int().positive().optional(),
    repoFullName: z.string().min(1).max(512),
    branch: z.string().min(1).max(255).trim(),
    // Empty string means "repo root" — distinct from undefined so the
    // wizard can always send a value once the root-directory step has
    // been completed, rather than needing an extra "is this the root?"
    // branch on the client.
    rootDirectory: z.string().max(255).trim().default(''),
  }),
});

export type DetectBuildConfigInput = z.infer<typeof detectBuildConfigSchema>['body'];

export interface DetectedBuildConfig {
  framework: {
    id: FrameworkPresetId;
    label: string;
    deploymentType: 'STATIC' | 'DYNAMIC';
    requiresUnsupportedRuntime: boolean;
  };
  /** What signal the detector actually matched on — null when nothing matched and the `static` fallback was used. */
  matchedOn: string | null;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
}

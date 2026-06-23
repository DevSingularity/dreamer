// Mirrors src/generated/prisma/enums.ts's DeploymentStatus on the API —
// keep in sync if the schema's enum ever changes.
export type DeploymentStatus =
  | "QUEUED"
  | "BUILDING"
  | "UPLOADING"
  | "STARTING"
  | "RUNNING"
  | "SLEEPING"
  | "WAKING"
  | "STOPPED"
  | "FAILED"
  | "CANCELLED"
  | "ERROR";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "SYSTEM";

// Mirrors PublicProject from the API's src/projects/project.types.ts.
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repoUrl: string;
  repoFullName: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  activeDeploymentId: string | null;
  lastDeployedAt: string | null; // dates cross JSON as ISO strings, not Date instances
  createdAt: string;
}

// Mirrors LatestDeploymentSummary from project.types.ts.
export interface LatestDeploymentSummary {
  id: string;
  slug: string;
  status: DeploymentStatus;
  url: string | null;
  branch: string;
  commitMessage: string | null;
  createdAt: string;
}

// Mirrors ProjectWithLatestDeployment from project.types.ts.
export interface ProjectWithLatestDeployment extends Project {
  deploymentCount: number;
  latestDeployment: LatestDeploymentSummary | null;
}

// Mirrors PublicDeployment from the API's src/deployments/deployment.types.ts.
export interface Deployment {
  id: string;
  projectId: string;
  slug: string;
  status: DeploymentStatus;
  type: "STATIC" | "DYNAMIC" | null;
  framework: string | null;
  branch: string;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  url: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorStep: string | null;
  buildDurationMs: number | null;
  triggeredBy: string;
  queuedAt: string;
  buildStartedAt: string | null;
  buildFinishedAt: string | null;
  deployedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

// Mirrors PublicStateTransition.
export interface StateTransition {
  id: string;
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus;
  reason: string | null;
  createdAt: string;
}

export interface DeploymentDetail extends Deployment {
  stateTransitions: StateTransition[];
}

// Mirrors PublicLogLine. id is a string here too — the API already
// converts the Postgres bigint before it ever reaches JSON; see the comment
// on PublicLogLine in the backend's deployment.types.ts for why that
// conversion has to happen server-side, not here.
export interface LogLine {
  id: string;
  level: LogLevel;
  message: string;
  sequence: number;
  source: string | null;
  timestamp: string;
}

export const ACTIVE_STATUSES: DeploymentStatus[] = ["QUEUED", "BUILDING", "UPLOADING", "STARTING"];
export const TERMINAL_STATUSES: DeploymentStatus[] = ["RUNNING", "STOPPED", "FAILED", "CANCELLED"];

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, GitBranch, Rocket } from "lucide-react";
import { createDeployment } from "../../lib/dashboard-api";
import { formatRelativeTime } from "../../lib/format";
import type { ProjectWithLatestDeployment } from "../../lib/dashboard-types";
import { StatusBadge } from "./StatusBadge";

export function ProjectCard({ project }: { project: ProjectWithLatestDeployment }) {
  const router = useRouter();
  const [deploying, setDeploying] = useState(false);
  const { latestDeployment } = project;

  // The card's own "Deploy" button — same endpoint the project overview
  // page's "Redeploy" button calls (createDeployment with no branch
  // override, defaulting server-side to the project's defaultBranch). One
  // action, reused everywhere it's offered, rather than a special
  // "quick-deploy" variant with its own behavior to keep in sync.
  async function handleQuickDeploy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDeploying(true);
    try {
      const deployment = await createDeployment(project.id);
      router.push(`/project/${project.id}/deployments/${deployment.id}`);
    } catch {
      setDeploying(false);
    }
  }

  return (
    <div
      onClick={() => router.push(`/project/${project.id}`)}
      className="block bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 hover:border-zinc-700 transition-colors group cursor-pointer"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-zinc-100 group-hover:text-white">{project.name}</h3>
          <p className="text-xs text-zinc-500 font-mono">{project.slug}</p>
        </div>
        {latestDeployment ? (
          <StatusBadge status={latestDeployment.status} />
        ) : (
          <span className="text-xs text-zinc-500">No deploys yet</span>
        )}
      </div>

      {latestDeployment?.url && (
        <a
          href={latestDeployment.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 mb-3 truncate"
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{latestDeployment.url.replace(/^https?:\/\//, "")}</span>
        </a>
      )}

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <GitBranch className="w-3.5 h-3.5" />
          {project.defaultBranch}
        </div>
        <div className="flex items-center gap-3">
          <span>{project.deploymentCount} deploys</span>
          {latestDeployment && <span>{formatRelativeTime(latestDeployment.createdAt)}</span>}
        </div>
      </div>

      <button
        onClick={handleQuickDeploy}
        disabled={deploying}
        className="w-full mt-4 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm font-medium text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors disabled:opacity-50"
      >
        <Rocket className="w-3.5 h-3.5" />
        {deploying ? "Queuing..." : "Deploy"}
      </button>
    </div>
  );
}

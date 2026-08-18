"use client";

import { useEffect, useState } from "react";
import { GitBranch, GitFork, Lock, Search, ChevronDown } from "lucide-react";
import { listGithubInstallations, listGithubRepos, GITHUB_APP_INSTALL_URL, describeApiError, getErrorRequestId } from "@/lib/dashboard-api";
import type { GithubInstallation, GithubRepoSummary } from "@/lib/dashboard-types";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PublicRepoSearch } from "./PublicRepoSearch";

/** Renders "6h ago" / "Jun 21" — recent activity gets a relative time, older
 * activity gets a short absolute date, since "3 months ago" is less useful
 * than just seeing the date at that point. */
function formatRepoUpdatedAt(iso: string): string {
  const date = new Date(iso);
  const hoursAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60);

  if (hoursAgo < 24) {
    const hours = Math.max(1, Math.round(hoursAgo));
    return `${hours}h ago`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function RepoRow({ repo, onSelect }: { repo: GithubRepoSummary; onSelect: (repo: GithubRepoSummary) => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5 hover:bg-zinc-900/40 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <GitBranch className="w-4 h-4 text-zinc-500 shrink-0" />
        <span className="text-sm font-medium text-zinc-100 truncate">{repo.fullName}</span>
        {repo.isPrivate && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
        <span className="text-xs text-zinc-500 shrink-0">· {formatRepoUpdatedAt(repo.updatedAt)}</span>
      </div>
      <Button variant="secondary" onClick={() => onSelect(repo)} className="shrink-0">
        Import
      </Button>
    </div>
  );
}

/**
 * Shown above the repo list whenever the caller has more than one
 * installation (personal account + any orgs they administer) — picking one
 * re-fetches the repo list scoped to just that installation, since the App
 * can see a different repo set per account/org it's installed on.
 */
function InstallationPicker({
  installations,
  selected,
  onChange,
}: {
  installations: GithubInstallation[];
  selected: GithubInstallation;
  onChange: (installation: GithubInstallation) => void;
}) {
  if (installations.length < 2) return null;

  return (
    <div className="relative mb-3">
      <GitFork className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
      <select
        value={selected.installationId}
        onChange={(e) => {
          const next = installations.find((i) => i.installationId === Number(e.target.value));
          if (next) onChange(next);
        }}
        className="w-full pl-9 pr-8 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm appearance-none focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
      >
        {installations.map((i) => (
          <option key={i.installationId} value={i.installationId}>
            {i.accountLogin} ({i.accountType === "Organization" ? "org" : "personal"})
            {i.suspended ? " — suspended" : ""}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
    </div>
  );
}

/**
 * No installations connected yet — the entry point into the GitHub App
 * install flow. Deliberately NOT ConnectGithubPrompt (that component links a
 * GitHub IDENTITY to the current account, a separate feature used on the
 * Account Settings page) — repo access is granted by installing the GitHub
 * App, a real top-level browser navigation to GitHub's own install screen.
 */
function ConnectGithubApp({ onSelect }: { onSelect: (repo: GithubRepoSummary) => void }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-2">Import Git Repository</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Connect the Dreamer GitHub App to import a repository. You&apos;ll pick which repos to grant access to on
        GitHub&apos;s own install screen.
      </p>
      <a href={GITHUB_APP_INSTALL_URL}>
        <Button variant="primary" className="inline-flex items-center gap-2">
          <GitFork className="w-4 h-4" />
          Connect GitHub
        </Button>
      </a>
      <PublicRepoSearch onSelect={onSelect} />
    </div>
  );
}

export function RepoPicker({ onSelect }: { onSelect: (repo: GithubRepoSummary) => void }) {
  const [installations, setInstallations] = useState<GithubInstallation[] | null>(null);
  const [selectedInstallation, setSelectedInstallation] = useState<GithubInstallation | null>(null);
  const [repoState, setRepoState] = useState<{ installationId: number; repos: GithubRepoSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listGithubInstallations()
      .then((list) => {
        setInstallations(list);
        const usable = list.find((i) => !i.suspended) ?? list[0];
        if (usable) setSelectedInstallation(usable);
      })
      .catch((err) => {
        setError(describeApiError(err, "Failed to load GitHub installations"));
        setErrorRequestId(getErrorRequestId(err));
      });
  }, []);

  useEffect(() => {
    if (!selectedInstallation) return;
    const installationId = selectedInstallation.installationId;
    listGithubRepos(installationId)
      .then((repos) => setRepoState({ installationId, repos }))
      .catch((err) => {
        setError(describeApiError(err, "Failed to load repositories"));
        setErrorRequestId(getErrorRequestId(err));
      });
  }, [selectedInstallation]);

  // Re-fetch when the tab regains focus. Needed specifically for the
  // "Grant access to more repos" link below: when the GitHub App is
  // ALREADY installed on an account, GitHub shows its "Configure" screen
  // instead of running a fresh install, and does NOT redirect back through
  // our callback afterward (a documented GitHub limitation, not something
  // this app can control — see buildGithubInstallUrl's comment in
  // github.service.ts). The user just switches back to this tab once
  // they're done, so this is the only way the picker learns anything
  // changed.
  useEffect(() => {
    function handleFocus() {
      if (!selectedInstallation) return;
      listGithubRepos(selectedInstallation.installationId)
        .then((repos) => setRepoState({ installationId: selectedInstallation.installationId, repos }))
        .catch(() => {
          // Silent: this is a background refresh, and the mount-time
          // effect above already surfaces a real fetch failure.
        });
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [selectedInstallation]);

  const repos =
    repoState && repoState.installationId === selectedInstallation?.installationId ? repoState.repos : null;
  const filtered = repos?.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())) ?? null;

  if (installations && installations.length === 0) {
    return <ConnectGithubApp onSelect={onSelect} />;
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-5">Import Git Repository</h1>

      {error ? (
        <>
          <Alert variant="error" requestId={errorRequestId}>
            {error}
          </Alert>
          <PublicRepoSearch onSelect={onSelect} />
        </>
      ) : !installations || !selectedInstallation ? (
        <div className="border border-zinc-800 rounded-xl divide-y divide-zinc-800 overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-14 bg-zinc-950/40 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <InstallationPicker
            installations={installations}
            selected={selectedInstallation}
            onChange={setSelectedInstallation}
          />

          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
            />
          </div>

          <div className="border border-zinc-800 rounded-xl divide-y divide-zinc-800 overflow-hidden">
            {!repos &&
              [...Array(4)].map((_, i) => <div key={i} className="h-14 bg-zinc-950/40 animate-pulse" />)}

            {filtered?.length === 0 && (
              <p className="text-sm text-zinc-500 px-4 py-6 text-center">No repositories match &quot;{query}&quot;</p>
            )}

            {filtered?.map((repo) => <RepoRow key={repo.repositoryId} repo={repo} onSelect={onSelect} />)}
          </div>

          {/* target="_blank": if the App is already installed on this account,
              GitHub shows a "Configure" screen and never redirects back to us
              (see the focus-refetch effect above) — opening in a new tab means
              the user doesn't lose their place in the wizard while doing that. */}
          <a
            href={GITHUB_APP_INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block mt-4 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Don&apos;t see a repository? Grant access to more repos on GitHub →
          </a>
          <PublicRepoSearch onSelect={onSelect} />
        </>
      )}
    </div>
  );
}

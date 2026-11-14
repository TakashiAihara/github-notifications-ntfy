#!/usr/bin/env bun
// Polls the GitHub notifications inbox once and forwards new threads to one ntfy topic.
// Run it from a timer (every 60s). It uses only the REST API: a 304 does not count
// against the rate limit, and X-Poll-Interval is honoured through state.nextPollAt.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Thread = {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string };
};

type State = {
  lastModified?: string;
  nextPollAt?: number;
  seen: Record<string, string>;
  lastError?: string;
};

export type Config = {
  githubToken: string;
  githubApi: string;
  ntfyUrl: string;
  ntfyToken?: string;
  reasons: Set<string> | null;
  stateFile: string;
};

const DEFAULT_REASONS = "mention,team_mention,review_requested,ci_activity";

export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const reasons = (env.REASONS ?? DEFAULT_REASONS).trim();
  return {
    githubToken: need("GITHUB_NOTIFICATIONS_TOKEN"),
    githubApi: (env.GITHUB_API ?? "https://api.github.com").replace(/\/$/, ""),
    ntfyUrl: need("NTFY_URL"),
    ntfyToken: env.NTFY_TOKEN?.trim() || undefined,
    reasons: reasons === "all" ? null : new Set(reasons.split(",").map((s) => s.trim()).filter(Boolean)),
    stateFile: env.STATE_FILE ?? "/var/lib/github-notifications-ntfy/state.json",
  };
}

function readState(path: string): State | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function writeState(path: string, s: State) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path);
}

// https://api.github.com/repos/o/r/pulls/1 -> https://github.com/o/r/pull/1
export function htmlUrl(t: Thread): string {
  const m = t.subject.url?.match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/(.+)$/);
  if (!m) return t.subject.type === "CheckSuite" ? `https://github.com/${t.repository.full_name}/actions` : "https://github.com/notifications";
  const kind = { pulls: "pull", issues: "issues", commits: "commit", releases: "releases" }[m[2]];
  // shortcut: release URLs carry a numeric id, not a tag; they land on the releases list page.
  return kind === "releases" ? `https://github.com/${m[1]}/releases` : `https://github.com/${m[1]}/${kind}/${m[3]}`;
}

async function ntfy(cfg: Config, title: string, body: string, click?: string) {
  // HTTP headers are ASCII-only; ntfy decodes RFC 2047 so non-ASCII titles survive.
  const headers: Record<string, string> = { Title: `=?UTF-8?B?${Buffer.from(title).toString("base64")}?=` };
  if (click) headers.Click = click;
  if (cfg.ntfyToken) headers.Authorization = `Bearer ${cfg.ntfyToken}`;
  const res = await fetch(cfg.ntfyUrl, { method: "POST", body, headers, redirect: "manual" });
  if (!res.ok) throw new Error(`ntfy POST ${res.status}`);
}

export async function run(cfg: Config, now = Date.now()): Promise<string> {
  const prev = readState(cfg.stateFile);
  const state: State = prev ?? { seen: {} };
  if (state.nextPollAt && now < state.nextPollAt) return "skip: poll interval";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;

  let res: Response;
  try {
    // shortcut: only the newest 50 unread threads are read; more than 50 new in one minute would drop the rest.
    res = await fetch(`${cfg.githubApi}/notifications?per_page=50`, { headers, redirect: "manual" });
  } catch (e) {
    return fail(cfg, state, `GitHub unreachable: ${(e as Error).message}`);
  }
  const interval = Number(res.headers.get("x-poll-interval") ?? "60");
  state.nextPollAt = now + (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000;

  if (res.status === 304) {
    state.lastError = undefined;
    writeState(cfg.stateFile, state);
    return "not modified";
  }
  if (!res.ok) return fail(cfg, state, `GitHub ${res.status}`);

  const threads = (await res.json()) as Thread[];
  state.lastModified = res.headers.get("last-modified") ?? state.lastModified;
  state.lastError = undefined;

  // First run: remember what is already there instead of replaying the whole inbox.
  if (!prev) {
    state.seen = Object.fromEntries(threads.map((t) => [t.id, t.updated_at]));
    writeState(cfg.stateFile, state);
    return `baseline: ${threads.length}`;
  }

  const seen: Record<string, string> = {};
  let sent = 0;
  let error: string | undefined;
  for (const t of threads) {
    const wanted = state.seen[t.id] !== t.updated_at && (!cfg.reasons || cfg.reasons.has(t.reason));
    if (wanted) {
      try {
        await ntfy(cfg, `${t.repository.full_name}: ${t.subject.title}`, `${t.reason} / ${t.subject.type}`, htmlUrl(t));
        sent++;
      } catch (e) {
        // Left out of seen, so the next run sends it again.
        error = (e as Error).message;
        continue;
      }
    }
    seen[t.id] = t.updated_at;
  }
  state.seen = seen;
  if (error) {
    // Re-poll without If-Modified-Since so the unsent threads come back.
    state.lastModified = undefined;
    writeState(cfg.stateFile, state);
    throw new Error(`sent ${sent}, then ${error}`);
  }
  writeState(cfg.stateFile, state);
  return `sent ${sent}`;
}

async function fail(cfg: Config, state: State, msg: string): Promise<never> {
  // Notify once per distinct error so an expired token does not page every minute.
  if (state.lastError !== msg) {
    state.lastError = msg;
    await ntfy(cfg, "github-notifications-ntfy failed", msg).catch(() => {});
  }
  writeState(cfg.stateFile, state);
  throw new Error(msg);
}

if (import.meta.main) {
  try {
    console.log(await run(loadConfig(process.env)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

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
  baselined?: boolean;
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
// Each request must finish well inside the unit's TimeoutStartSec=50 so failures reach fail().
const TIMEOUT_MS = 10_000;
const POLL_SLACK_MS = 5_000;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const reasons = opt(env, "REASONS") ?? DEFAULT_REASONS;
  return {
    githubToken: need("GITHUB_NOTIFICATIONS_TOKEN"),
    githubApi: (opt(env, "GITHUB_API") ?? "https://api.github.com").replace(/\/$/, ""),
    ntfyUrl: need("NTFY_URL"),
    ntfyToken: env.NTFY_TOKEN?.trim() || undefined,
    reasons: reasons === "all" ? null : new Set(reasons.split(",").map((s) => s.trim()).filter(Boolean)),
    stateFile: opt(env, "STATE_FILE") ?? "/var/lib/github-notifications-ntfy/state.json",
  };
}

// An env file line like `REASONS=` means unset, not empty.
function opt(env: Record<string, string | undefined>, k: string): string | undefined {
  return env[k]?.trim() || undefined;
}

// A missing or unreadable state starts over with a fresh baseline, which sends nothing.
function readState(path: string): State | null {
  let s: unknown;
  try {
    s = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error(`state ignored: ${(e as Error).message}`);
    return null;
  }
  const ok = !!s && typeof s === "object" && !!(s as State).seen && typeof (s as State).seen === "object";
  if (!ok) console.error("state ignored: unexpected shape");
  return ok ? (s as State) : null;
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
  const res = await fetch(cfg.ntfyUrl, { method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ntfy POST ${res.status}`);
}

export async function run(cfg: Config, now = Date.now()): Promise<string> {
  const state: State = readState(cfg.stateFile) ?? { seen: {} };
  // The timer fires about 60s after the previous start, a little before start + 60s; allow for that.
  if (state.nextPollAt && now < state.nextPollAt - POLL_SLACK_MS) return "skip: poll interval";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-notifications-ntfy",
  };
  if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;

  let res: Response;
  try {
    res = await fetch(`${cfg.githubApi}/notifications?per_page=100`, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
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

  const lastModified = res.headers.get("last-modified");
  let threads: Thread[];
  try {
    threads = await readAllPages(res, headers);
  } catch (e) {
    return fail(cfg, state, (e as Error).message);
  }
  state.lastModified = lastModified ?? state.lastModified;
  state.lastError = undefined;

  // First success: remember what is already there instead of replaying the whole inbox.
  if (!state.baselined) {
    state.baselined = true;
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

// Follows Link rel="next" so every unread thread is compared, not just the first page.
async function readAllPages(first: Response, headers: Record<string, string>): Promise<Thread[]> {
  const out: Thread[] = [];
  let res = first;
  for (let page = 1; ; page++) {
    out.push(...((await res.json()) as Thread[]));
    const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (!next) return out;
    // Unread threads over 50 pages (5000) mean something is wrong; stop rather than loop.
    if (page >= 50) throw new Error("more than 50 pages of unread notifications");
    const { "If-Modified-Since": _, ...plain } = headers;
    res = await fetch(next, { headers: plain, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub ${res.status} on page ${page + 1}`);
  }
}

async function fail(cfg: Config, state: State, msg: string): Promise<never> {
  // Notify once per distinct error so an expired token does not page every minute;
  // a failed notification is retried on the next run.
  if (state.lastError !== msg) {
    try {
      await ntfy(cfg, "github-notifications-ntfy failed", msg);
      state.lastError = msg;
    } catch {}
  }
  writeState(cfg.stateFile, state);
  throw new Error(msg);
}

// OAuth device flow (no client secret, no callback server). The token goes to stdout only.
export async function login(
  clientId: string,
  web = "https://github.com",
  sleep = (ms: number) => Bun.sleep(ms),
  say = (s: string) => console.error(s),
): Promise<string> {
  const post = async (path: string, body: Record<string, string>) => {
    const res = await fetch(`${web}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return (await res.json()) as Record<string, string | number>;
  };

  const code = await post("/login/device/code", { client_id: clientId, scope: "notifications" });
  if (code.error) throw new Error(`device code: ${code.error}`);
  say(`Open ${code.verification_uri} and enter ${code.user_code}`);

  let interval = Number(code.interval) || 5;
  const deadline = Date.now() + (Number(code.expires_in) || 900) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() >= deadline) break;
    const r = await post("/login/oauth/access_token", {
      client_id: clientId,
      device_code: String(code.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (r.access_token) return String(r.access_token);
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") {
      interval = Number(r.interval) || interval + 5;
      continue;
    }
    throw new Error(`login: ${r.error}`);
  }
  throw new Error("login: device code expired");
}

if (import.meta.main) {
  try {
    const cmd = process.argv[2];
    if (cmd === "login") {
      const id = opt(process.env, "GITHUB_OAUTH_CLIENT_ID");
      if (!id) throw new Error("GITHUB_OAUTH_CLIENT_ID is not set");
      console.log(await login(id, (opt(process.env, "GITHUB_WEB") ?? "https://github.com").replace(/\/$/, "")));
      process.exit(0);
    }
    if (cmd !== undefined) throw new Error(`unknown command: ${cmd} (only "login", or no argument to poll)`);
    console.log(await run(loadConfig(process.env)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

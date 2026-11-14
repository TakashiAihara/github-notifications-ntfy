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
  // Lower bound for the next query; unset until the first successful poll.
  since?: string;
  // ETag of the last 200; GitHub answers 304 to If-None-Match (it ignores If-Modified-Since here).
  etag?: string;
  nextPollAt?: number;
  // Threads already handled inside the overlap window, keyed by id with their updated_at.
  seen: Record<string, string>;
  // Last error already announced on ntfy, so a repeating error is announced once.
  lastError?: string;
  // Set while the last poll ended in an error; a run skipped by X-Poll-Interval then fails too.
  failing?: string;
};

export type Config = {
  githubToken: string;
  githubApi: string;
  ntfyUrl: string;
  ntfyToken?: string;
  reasons: Set<string> | null;
  stateFile: string;
  pagingBudgetMs: number;
};

const DEFAULT_REASONS = "mention,team_mention,review_requested,ci_activity";
// From the "About notification reasons" table in the GitHub REST docs.
const KNOWN_REASONS = new Set([
  "agent_session_finished", "approval_requested", "assign", "author", "ci_activity", "comment", "invitation", "manual",
  "member_feature_requested", "mention", "review_requested", "security_advisory_credit",
  "security_alert", "state_change", "subscribed", "team_mention",
]);

// A typo would silently forward nothing, so unknown reasons are refused.
function parseReasons(s: string): Set<string> | null {
  if (s.toLowerCase() === "all") return null;
  const set = new Set(s.split(",").map((r) => r.trim()).filter(Boolean));
  const unknown = [...set].filter((r) => !KNOWN_REASONS.has(r));
  if (unknown.length) throw new Error(`unknown REASONS: ${unknown.join(", ")}`);
  if (!set.size) throw new Error("REASONS lists no reason");
  return set;
}
// A single hung request then fails inside the run and reaches fail(). A whole run can still
// outlast the unit's TimeoutStartSec; sends are checkpointed so a killed run does not resend.
const TIMEOUT_MS = 10_000;
const POLL_SLACK_MS = 5_000;
// Each query reaches back this far before the previous start, so an update landing
// while that query ran is not missed; `seen` drops the repeats.
const OVERLAP_MS = 120_000;
// GitHub caps per_page at 50 for this endpoint (it answers 50 for per_page=100).
const PER_PAGE = 50;
const MAX_PAGES = 100;
// Paging stops after this long, so the run ends well inside the unit's TimeoutStartSec=50.
const PAGING_BUDGET_MS = 25_000;

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
    reasons: parseReasons(reasons),
    stateFile: opt(env, "STATE_FILE") ?? "/var/lib/github-notifications-ntfy/state.json",
    pagingBudgetMs: PAGING_BUDGET_MS,
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
  if (!res.ok) throw new NtfyError(res.status);
}

class NtfyError extends Error {
  constructor(readonly status: number) {
    super(`ntfy POST ${status}`);
  }
  // Only errors about the message itself (malformed, too large, headers too long). Auth and
  // routing errors (401/403/404) hit every message, so they count as an outage.
  get permanent(): boolean {
    return [400, 413, 414, 431].includes(this.status);
  }
}

export async function run(cfg: Config, now = Date.now()): Promise<string> {
  const state: State = readState(cfg.stateFile) ?? { seen: {} };
  // The timer fires about 60s after the previous start, a little before start + 60s; allow for that.
  if (state.nextPollAt && now < state.nextPollAt - POLL_SLACK_MS) {
    // Exit non-zero while the last poll's error stands, so the unit stays visibly failed.
    if (state.failing) throw new Error(`skip: poll interval (last error: ${state.failing})`);
    return "skip: poll interval";
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-notifications-ntfy",
  };
  if (state.etag) headers["If-None-Match"] = state.etag;

  let res: Response;
  try {
    const since = encodeURIComponent(state.since ?? iso(now));
    res = await fetch(`${cfg.githubApi}/notifications?per_page=${PER_PAGE}&since=${since}`, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return fail(cfg, state, `GitHub unreachable: ${(e as Error).message}`);
  }
  const interval = Number(res.headers.get("x-poll-interval") ?? "60");
  state.nextPollAt = now + (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000;

  const nextSince = iso(now - OVERLAP_MS);
  const keep = (seen: Record<string, string>) => Object.fromEntries(Object.entries(seen).filter(([, u]) => u >= nextSince));

  // Nothing changed: leave since alone, so an update the cached answer hid is still in range next time.
  if (res.status === 304) {
    state.lastError = undefined;
    state.failing = undefined;
    writeState(cfg.stateFile, state);
    return "not modified";
  }
  if (!res.ok) return fail(cfg, state, `GitHub ${res.status}`);

  const etag = res.headers.get("etag") ?? undefined;
  let threads: Thread[];
  let truncated: boolean;
  try {
    ({ threads, truncated } = await readAllPages(res, headers, cfg.githubApi, Date.now() + cfg.pagingBudgetMs));
  } catch (e) {
    return fail(cfg, state, (e as Error).message);
  }
  state.lastError = undefined;

  // First success: start from now instead of replaying the inbox.
  if (!state.since) {
    // Threads here were updated during this very query; leaving them unseen sends them next run.
    state.since = nextSince;
    state.seen = {};
    state.failing = undefined;
    writeState(cfg.stateFile, state);
    return `baseline: ${threads.length}`;
  }

  // Fail before sending anything if the state cannot be saved; otherwise every run resends.
  writeState(cfg.stateFile, state);

  const seen = { ...state.seen };
  let sent = 0;
  let error: string | undefined;
  for (const t of threads) {
    if (seen[t.id] === t.updated_at) continue;
    if (!cfg.reasons || cfg.reasons.has(t.reason)) {
      try {
        await ntfy(cfg, `${t.repository.full_name}: ${t.subject.title}`, `${t.reason} / ${t.subject.type}`, htmlUrl(t));
      } catch (e) {
        if (e instanceof NtfyError && e.permanent) {
          // Dropped rather than retried forever, which would freeze since.
          console.error(`dropped ${t.id} (${t.subject.title}): ${e.message}`);
          seen[t.id] = t.updated_at;
          continue;
        }
        // ntfy is down or slow: stop here; this and later threads are sent next run.
        error = (e as Error).message;
        break;
      }
      sent++;
      // Checkpoint each send: if the unit is killed mid-loop, the next run does not resend it.
      seen[t.id] = t.updated_at;
      state.seen = seen;
      writeState(cfg.stateFile, state);
      continue;
    }
    seen[t.id] = t.updated_at;
  }
  if (error) {
    // Keep since and the old ETag; the unsent threads come back next run.
    state.seen = seen;
    state.failing = error;
    writeState(cfg.stateFile, state);
    throw new Error(`sent ${sent}, then ${error}`);
  }
  if (truncated) {
    // Best effort: the newest updates went out; tell the user the older ones did not.
    await ntfy(cfg, "github-notifications-ntfy skipped updates", `too many threads were updated since the last poll to read in one run; only the newest ${threads.length} were sent`).catch(() => {});
  }
  // The ETag is saved only now: a run killed mid-loop must not let a 304 hide the unsent threads.
  state.etag = etag;
  state.failing = undefined;
  state.since = nextSince;
  state.seen = keep(seen);
  writeState(cfg.stateFile, state);
  return `sent ${sent}`;
}

// GitHub wants YYYY-MM-DDTHH:MM:SSZ, without milliseconds.
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Follows Link rel="next" so every updated thread is seen, not just the first page.
// Pages come newest first. Past MAX_PAGES or the time budget the older rest is left out
// (truncated), so a long outage cannot make every run fetch, time out, and start over.
async function readAllPages(first: Response, headers: Record<string, string>, api: string, deadline: number): Promise<{ threads: Thread[]; truncated: boolean }> {
  const out: Thread[] = [];
  let res = first;
  for (let page = 1; ; page++) {
    out.push(...((await res.json()) as Thread[]));
    const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (!next) return { threads: out, truncated: false };
    // The token goes with the request, so only follow links back to the configured API.
    if (new URL(next).origin !== new URL(api).origin) throw new Error(`refusing next page on another host: ${new URL(next).origin}`);
    if (page >= MAX_PAGES || Date.now() >= deadline) return { threads: out, truncated: true };
    const { "If-None-Match": _, ...plain } = headers;
    res = await fetch(next, { headers: plain, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub ${res.status} on page ${page + 1}`);
  }
}

async function fail(cfg: Config, state: State, msg: string): Promise<never> {
  // Notify once per distinct error so an expired token does not page every minute;
  // a failed notification is retried on the next run.
  state.failing = msg;
  if (state.lastError !== msg) {
    try {
      await ntfy(cfg, "github-notifications-ntfy failed", msg);
      state.lastError = msg;
    } catch {}
  }
  try {
    writeState(cfg.stateFile, state);
  } catch (e) {
    console.error(`state not saved: ${(e as Error).message}`);
  }
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
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "github-notifications-ntfy" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return (await res.json()) as Record<string, string | number>;
  };

  const code = await post("/login/device/code", { client_id: clientId, scope: "notifications" });
  if (code.error) throw new Error(`device code: ${code.error}`);
  if (!code.device_code || !code.user_code || !code.verification_uri) throw new Error("device code: incomplete response");
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
    throw new Error(`login: ${r.error}${r.error_description ? ` (${r.error_description})` : ""}`);
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
    } else if (cmd !== undefined) {
      throw new Error(`unknown command: ${cmd} (only "login", or no argument to poll)`);
    } else {
      console.log(await run(loadConfig(process.env)));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

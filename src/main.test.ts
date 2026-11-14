import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlUrl, loadConfig, run } from "./main";

type Sent = { title: string; body: string; click: string | null; auth: string | null };

let ghStatus = 200;
let ghBody: unknown[] = [];
let ghPollInterval = "60";
let ghSeenIms: (string | null)[] = [];
let ntfyFailOnce = 0;
let ntfyCalls = 0;
let sent: Sent[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/notifications") {
      ghSeenIms.push(req.headers.get("if-modified-since"));
      const h = { "x-poll-interval": ghPollInterval, "last-modified": "Sat, 14 Nov 2026 08:00:00 GMT" };
      if (ghStatus !== 200) return new Response(null, { status: ghStatus, headers: h });
      return Response.json(ghBody, { headers: h });
    }
    if (url.pathname === "/topic") {
      if (++ntfyCalls === ntfyFailOnce) return new Response("no", { status: 500 });
      const raw = req.headers.get("title") ?? "";
      const title = Buffer.from(raw.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString();
      sent.push({ title, body: await req.text(), click: req.headers.get("click"), auth: req.headers.get("authorization") });
      return new Response("ok");
    }
    return new Response("nf", { status: 404 });
  },
});
afterAll(() => server.stop(true));

let dir: string;
const cfg = () =>
  loadConfig({
    GITHUB_NOTIFICATIONS_TOKEN: "gh-test",
    GITHUB_API: `http://127.0.0.1:${server.port}`,
    NTFY_URL: `http://127.0.0.1:${server.port}/topic`,
    NTFY_TOKEN: "ntfy-test",
    STATE_FILE: join(dir, "state.json"),
  });

const thread = (id: string, reason: string, updated: string, title = `t${id}`) => ({
  id,
  reason,
  updated_at: updated,
  subject: { title, url: `https://api.github.com/repos/o/r/pulls/${id}`, type: "PullRequest" },
  repository: { full_name: "o/r" },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gnn-"));
  ghStatus = 200;
  ghBody = [];
  ghPollInterval = "60";
  ghSeenIms = [];
  ntfyFailOnce = 0;
  ntfyCalls = 0;
  sent = [];
});

test("first run records the inbox without sending", async () => {
  ghBody = [thread("1", "mention", "a")];
  expect(await run(cfg(), 0)).toBe("baseline: 1");
  expect(sent).toHaveLength(0);
});

test("sends only new or updated threads with a wanted reason", async () => {
  ghBody = [thread("1", "mention", "a"), thread("2", "subscribed", "a")];
  await run(cfg(), 0);
  ghBody = [thread("1", "mention", "b", "日本語のタイトル"), thread("2", "subscribed", "b"), thread("3", "review_requested", "a"), thread("4", "mention", "a")];

  expect(await run(cfg(), 61_000)).toBe("sent 3");
  expect(sent.map((s) => s.title)).toEqual(["o/r: 日本語のタイトル", "o/r: t3", "o/r: t4"]);
  expect(sent[0]).toMatchObject({ body: "mention / PullRequest", click: "https://github.com/o/r/pull/1", auth: "Bearer ntfy-test" });
  sent = [];
  expect(await run(cfg(), 122_000)).toBe("sent 0");
});

test("REASONS=all sends every reason", async () => {
  ghBody = [];
  const c = { ...cfg(), reasons: null };
  await run(c, 0);
  ghBody = [thread("9", "subscribed", "a")];
  expect(await run(c, 61_000)).toBe("sent 1");
});

test("304 sends nothing and replays If-Modified-Since", async () => {
  await run(cfg(), 0);
  ghStatus = 304;
  expect(await run(cfg(), 61_000)).toBe("not modified");
  expect(ghSeenIms).toEqual([null, "Sat, 14 Nov 2026 08:00:00 GMT"]);
});

test("a 304 after an error re-arms the error notification", async () => {
  await run(cfg(), 0);
  ghStatus = 401;
  await expect(run(cfg(), 61_000)).rejects.toThrow("GitHub 401");
  ghStatus = 304;
  await run(cfg(), 122_000);
  ghStatus = 401;
  await expect(run(cfg(), 183_000)).rejects.toThrow("GitHub 401");
  expect(sent.map((s) => s.body)).toEqual(["GitHub 401", "GitHub 401"]);
});

test("honours X-Poll-Interval before calling GitHub again", async () => {
  ghPollInterval = "120";
  await run(cfg(), 0);
  expect(await run(cfg(), 119_000)).toBe("skip: poll interval");
  expect(ghSeenIms).toHaveLength(1);
  expect(await run(cfg(), 120_000)).toBe("sent 0");
});

test("an ntfy failure keeps the unsent threads for the next run", async () => {
  await run(cfg(), 0);
  ghBody = [thread("1", "mention", "a"), thread("2", "mention", "a"), thread("3", "mention", "a")];
  ntfyFailOnce = 2;
  await expect(run(cfg(), 61_000)).rejects.toThrow("sent 2, then ntfy POST 500");
  expect(await run(cfg(), 122_000)).toBe("sent 1");
  expect(sent.map((s) => s.title)).toEqual(["o/r: t1", "o/r: t3", "o/r: t2"]);
  expect(ghSeenIms[2]).toBeNull();
});

test("a GitHub error notifies once per distinct error and fails", async () => {
  await run(cfg(), 0);
  ghStatus = 401;
  await expect(run(cfg(), 61_000)).rejects.toThrow("GitHub 401");
  await expect(run(cfg(), 122_000)).rejects.toThrow("GitHub 401");
  expect(sent.map((s) => s.body)).toEqual(["GitHub 401"]);
  expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).lastError).toBe("GitHub 401");
});

test("missing token is refused", () => {
  expect(() => loadConfig({ NTFY_URL: "x" })).toThrow("GITHUB_NOTIFICATIONS_TOKEN is not set");
});

test("htmlUrl maps API URLs to pages", () => {
  const t = (url: string | null, type = "Issue") => ({ ...thread("1", "mention", "a"), subject: { title: "x", url, type } });
  expect(htmlUrl(t("https://api.github.com/repos/o/r/issues/5"))).toBe("https://github.com/o/r/issues/5");
  expect(htmlUrl(t("https://api.github.com/repos/o/r/commits/abc"))).toBe("https://github.com/o/r/commit/abc");
  expect(htmlUrl(t(null, "CheckSuite"))).toBe("https://github.com/o/r/actions");
  expect(htmlUrl(t(null, "Discussion"))).toBe("https://github.com/notifications");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

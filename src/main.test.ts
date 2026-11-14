import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlUrl, loadConfig, login, run } from "./main";

type Sent = { title: string; body: string; click: string | null; auth: string | null };
type GhReq = { path: string; since: string | null; page: string | null; inm: string | null; auth: string | null; ua: string | null };

const T0 = Date.parse("2026-11-14T00:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const ETAG = 'W/"abc"';

let ghStatus = 200;
let ghEtag: string | null = ETAG;
let ghNextHost: string | null = null;
let ghThreads: ReturnType<typeof thread>[] = [];
let ghPerPage = 100;
let ghEndless = false;
let ghPollInterval = "60";
let ghReqs: GhReq[] = [];
let deviceReplies: Record<string, unknown>[] = [];
let deviceExpires = 900;
let deviceCodeError: string | undefined;
let deviceIncomplete = false;
let deviceBodies: Record<string, string>[] = [];
let ntfyFailOnce = 0;
let ntfyCalls = 0;
let sent: Sent[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/notifications") {
      const since = url.searchParams.get("since");
      const page = url.searchParams.get("page");
      ghReqs.push({ path: url.pathname, since, page, inm: req.headers.get("if-none-match"), auth: req.headers.get("authorization"), ua: req.headers.get("user-agent") });
      const h: Record<string, string> = { "x-poll-interval": ghPollInterval };
      if (ghEtag) h.etag = ghEtag;
      if (ghStatus !== 200) return new Response(null, { status: ghStatus, headers: h });
      const all = ghThreads.filter((t) => !since || t.updated_at > since);
      const n = Number(page ?? "1");
      if (ghEndless || all.length > n * ghPerPage) h.link = `<${ghNextHost ?? `http://127.0.0.1:${server.port}`}/notifications?since=${since}&page=${n + 1}>; rel="next"`;
      return Response.json(all.slice((n - 1) * ghPerPage, n * ghPerPage), { headers: h });
    }
    if (url.pathname === "/login/device/code") {
      deviceBodies.push(await req.json());
      if (deviceCodeError) return Response.json({ error: deviceCodeError });
      if (deviceIncomplete) return Response.json({ interval: 5 });
      return Response.json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: deviceExpires, interval: 5 });
    }
    if (url.pathname === "/login/oauth/access_token") {
      deviceBodies.push(await req.json());
      return Response.json(deviceReplies.shift() ?? { error: "access_denied" });
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
const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
// Runs at T0 + sec.
const poll = (sec: number, c = cfg()) => run(c, T0 + sec * 1000);

function thread(id: string, reason: string, updatedSec: number, title = `t${id}`) {
  return {
    id,
    reason,
    updated_at: at(updatedSec),
    subject: { title, url: `https://api.github.com/repos/o/r/pulls/${id}`, type: "PullRequest" },
    repository: { full_name: "o/r" },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gnn-"));
  ghStatus = 200;
  ghEtag = ETAG;
  ghNextHost = null;
  ghThreads = [];
  ghPerPage = 100;
  ghEndless = false;
  ghPollInterval = "60";
  ghReqs = [];
  deviceReplies = [];
  deviceExpires = 900;
  deviceCodeError = undefined;
  deviceIncomplete = false;
  deviceBodies = [];
  ntfyFailOnce = 0;
  ntfyCalls = 0;
  sent = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("an update landing during the first query is sent on the next run", async () => {
  ghThreads = [thread("1", "mention", 5)];
  expect(await poll(0)).toBe("baseline: 1");
  expect(sent).toHaveLength(0);
  expect(await poll(61)).toBe("sent 1");
});

test("first run starts from now and sends nothing", async () => {
  ghThreads = [thread("old", "mention", -3600)];
  expect(await poll(0)).toBe("baseline: 0");
  expect(ghReqs[0].since).toBe(at(0));
  expect(state().since).toBe(at(-120));
  expect(sent).toHaveLength(0);
});

test("sends threads updated since the last poll, once, with a wanted reason", async () => {
  await poll(0);
  ghThreads = [thread("old", "mention", -3600), thread("1", "mention", 30, "日本語のタイトル"), thread("2", "subscribed", 30), thread("3", "review_requested", 40)];
  expect(await poll(61)).toBe("sent 2");
  expect(ghReqs[1].since).toBe(at(-120));
  expect(sent.map((s) => s.title)).toEqual(["o/r: 日本語のタイトル", "o/r: t3"]);
  expect(sent[0]).toMatchObject({ body: "mention / PullRequest", click: "https://github.com/o/r/pull/1", auth: "Bearer ntfy-test" });
  expect(state().since).toBe(at(-59));

  // Still inside the overlap window: the same updates are not sent again.
  sent = [];
  expect(await poll(122)).toBe("sent 0");

  // A newer update of the same thread is sent.
  ghThreads.push({ ...thread("1", "mention", 150, "again") });
  expect(await poll(183)).toBe("sent 1");
  expect(sent.map((s) => s.title)).toEqual(["o/r: again"]);
});

test("forgets seen threads that fall behind the window", async () => {
  await poll(0);
  ghThreads = [thread("1", "mention", 30)];
  await poll(61);
  ghThreads = [];
  await poll(400);
  expect(state().seen).toEqual({});
});

test("REASONS=all sends every reason", async () => {
  const c = { ...cfg(), reasons: null };
  await poll(0, c);
  ghThreads = [thread("9", "subscribed", 30)];
  expect(await poll(61, c)).toBe("sent 1");
});

test("304 replays the ETag and leaves since and seen alone", async () => {
  await poll(0);
  ghThreads = [thread("1", "mention", 30)];
  await poll(61);
  ghStatus = 304;
  expect(await poll(400)).toBe("not modified");
  expect(ghReqs.map((r) => r.inm)).toEqual([null, null, ETAG]);
  expect(state().since).toBe(at(-59));
  expect(state().seen).toEqual({ "1": at(30) });
});

test("a 200 without an ETag stops sending If-None-Match", async () => {
  await poll(0);
  ghEtag = null;
  await poll(61);
  ghEtag = ETAG;
  await poll(122);
  await poll(183);
  expect(ghReqs.map((r) => r.inm)).toEqual([null, null, null, ETAG]);
});

test("304 before any success does not count as a baseline", async () => {
  ghStatus = 304;
  await poll(0);
  expect(state().since).toBeUndefined();
});

test("honours X-Poll-Interval before calling GitHub again", async () => {
  ghPollInterval = "120";
  await poll(0);
  expect(await poll(114)).toBe("skip: poll interval");
  expect(ghReqs).toHaveLength(1);
  expect(await poll(116)).toBe("sent 0");
});

test("a timer firing slightly early still polls", async () => {
  await poll(0);
  expect(await poll(59)).toBe("sent 0");
});

test("sends the token and a User-Agent", async () => {
  await poll(0);
  expect(ghReqs[0]).toMatchObject({ auth: "Bearer gh-test", ua: "github-notifications-ntfy" });
});

test("an ntfy failure keeps since and resends only the unsent threads", async () => {
  await poll(0);
  ghThreads = [thread("1", "mention", 30), thread("2", "mention", 31), thread("3", "mention", 32)];
  ntfyFailOnce = 2;
  await expect(poll(61)).rejects.toThrow("sent 2, then ntfy POST 500");
  expect(state().since).toBe(at(-120));
  expect(await poll(122)).toBe("sent 1");
  expect(sent.map((s) => s.title)).toEqual(["o/r: t1", "o/r: t3", "o/r: t2"]);
  expect(ghReqs[2].inm).toBeNull();
});

test("a send survives the run being killed afterwards, and the ETag waits for the end", async () => {
  ghEtag = null;
  await poll(0);
  ghEtag = ETAG;
  ghThreads = [thread("1", "mention", 30), thread("2", "mention", 31)];
  ntfyFailOnce = 2;
  await expect(poll(61)).rejects.toThrow();
  expect(state().seen).toEqual({ "1": at(30) });
  expect(state().etag).toBeUndefined();
});

test("the ETag is saved after a run that sent everything", async () => {
  await poll(0);
  ghThreads = [thread("1", "mention", 30)];
  await poll(61);
  expect(state().etag).toBe(ETAG);
});

test("the baseline run does not save an ETag", async () => {
  await poll(0);
  expect(state().etag).toBeUndefined();
});

test("reads every page, without If-Modified-Since after the first", async () => {
  ghPerPage = 1;
  await poll(0);
  ghThreads = [thread("1", "mention", 30), thread("2", "mention", 31)];
  expect(await poll(61)).toBe("sent 2");
  expect(ghReqs.slice(1).map((r) => [r.page, r.inm, r.auth])).toEqual([
    [null, null, "Bearer gh-test"],
    ["2", null, "Bearer gh-test"],
  ]);
});

test("pages after the first never carry the ETag", async () => {
  await poll(0);
  ghThreads = [thread("1", "mention", 30)];
  await poll(61);
  ghPerPage = 1;
  ghThreads.push(thread("2", "mention", 70), thread("3", "mention", 71));
  expect(await poll(122)).toBe("sent 2");
  expect(ghReqs.slice(2).map((r) => [r.page, r.inm])).toEqual([
    [null, ETAG],
    ["2", null],
    ["3", null],
  ]);
});

test("refuses a next-page link to another host", async () => {
  ghPerPage = 1;
  await poll(0);
  ghNextHost = "http://127.0.0.2:1";
  ghThreads = [thread("1", "mention", 30), thread("2", "mention", 31)];
  await expect(poll(61)).rejects.toThrow("refusing next page on another host: http://127.0.0.2:1");
  expect(ghReqs).toHaveLength(2);
});

test("stops after 50 pages instead of following next forever", async () => {
  ghEndless = true;
  await expect(poll(0)).rejects.toThrow("more than 50 pages of updated notifications");
  expect(ghReqs).toHaveLength(50);
});

test("a GitHub error notifies once per distinct error and fails", async () => {
  await poll(0);
  ghStatus = 401;
  await expect(poll(61)).rejects.toThrow("GitHub 401");
  await expect(poll(122)).rejects.toThrow("GitHub 401");
  expect(sent.map((s) => s.body)).toEqual(["GitHub 401"]);
  expect(state().lastError).toBe("GitHub 401");
});

test("a 304 after an error re-arms the error notification", async () => {
  await poll(0);
  ghStatus = 401;
  await expect(poll(61)).rejects.toThrow("GitHub 401");
  ghStatus = 304;
  await poll(122);
  ghStatus = 401;
  await expect(poll(183)).rejects.toThrow("GitHub 401");
  expect(sent.map((s) => s.body)).toEqual(["GitHub 401", "GitHub 401"]);
});

test("an error alert that fails to send is retried next run", async () => {
  await poll(0);
  ghStatus = 401;
  ntfyFailOnce = 1;
  await expect(poll(61)).rejects.toThrow("GitHub 401");
  await expect(poll(122)).rejects.toThrow("GitHub 401");
  expect(sent.map((s) => s.body)).toEqual(["GitHub 401"]);
});

test("a failed first run still baselines on the next success", async () => {
  ghStatus = 500;
  await expect(poll(0)).rejects.toThrow("GitHub 500");
  ghStatus = 200;
  ghThreads = [thread("1", "mention", 30)];
  expect(await poll(61)).toBe("baseline: 0");
  expect(state().since).toBe(at(-59));
  expect(sent.map((s) => s.body)).toEqual(["GitHub 500"]);
});

test("an unreadable state file starts a new baseline", async () => {
  writeFileSync(join(dir, "state.json"), "[]");
  expect(await poll(0)).toBe("baseline: 0");
  expect(state().since).toBe(at(-120));
});

test("REASONS accepts any case of all and refuses unknown reasons", () => {
  const base = { GITHUB_NOTIFICATIONS_TOKEN: "t", NTFY_URL: "u" };
  expect(loadConfig({ ...base, REASONS: "All" }).reasons).toBeNull();
  expect([...(loadConfig({ ...base, REASONS: "state_change, comment" }).reasons ?? [])]).toEqual(["state_change", "comment"]);
  expect(() => loadConfig({ ...base, REASONS: "mention,review-requested" })).toThrow("unknown REASONS: review-requested");
  expect(() => loadConfig({ ...base, REASONS: "," })).toThrow("REASONS lists no reason");
});

test("empty env values fall back to defaults", () => {
  const c = loadConfig({ GITHUB_NOTIFICATIONS_TOKEN: "t", NTFY_URL: "u", REASONS: " ", STATE_FILE: "", GITHUB_API: "", NTFY_TOKEN: "" });
  expect([...(c.reasons ?? [])]).toEqual(["mention", "team_mention", "review_requested", "ci_activity"]);
  expect(c.stateFile).toBe("/var/lib/github-notifications-ntfy/state.json");
  expect(c.githubApi).toBe("https://api.github.com");
  expect(c.ntfyToken).toBeUndefined();
});

test("without NTFY_TOKEN no Authorization header goes to ntfy", async () => {
  const c = { ...cfg(), ntfyToken: undefined };
  await poll(0, c);
  ghThreads = [thread("1", "mention", 30)];
  await poll(61, c);
  expect(sent[0].auth).toBeNull();
});

test("missing token is refused", () => {
  expect(() => loadConfig({ NTFY_URL: "x" })).toThrow("GITHUB_NOTIFICATIONS_TOKEN is not set");
});

test("login polls through pending and slow_down and returns the token", async () => {
  deviceReplies = [{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "gho_x" }];
  const waits: number[] = [];
  const said: string[] = [];
  const tok = await login("cid", `http://127.0.0.1:${server.port}`, async (ms) => void waits.push(ms), (s) => void said.push(s));
  expect(tok).toBe("gho_x");
  expect(waits).toEqual([5000, 5000, 10000]);
  expect(said).toEqual(["Open https://github.com/login/device and enter ABCD-1234"]);
  expect(deviceBodies[0]).toEqual({ client_id: "cid", scope: "notifications" });
  expect(deviceBodies[1]).toEqual({ client_id: "cid", device_code: "dc", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
});

test("login gives up when the device code expires", async () => {
  deviceExpires = 0.001;
  deviceReplies = [{ error: "authorization_pending" }];
  await expect(login("cid", `http://127.0.0.1:${server.port}`, () => Bun.sleep(5), () => {})).rejects.toThrow("login: device code expired");
});

test("login reports a refused device code request", async () => {
  deviceCodeError = "device_flow_disabled";
  await expect(login("cid", `http://127.0.0.1:${server.port}`, async () => {}, () => {})).rejects.toThrow("device code: device_flow_disabled");
});

test("login stops on access_denied", async () => {
  await expect(login("cid", `http://127.0.0.1:${server.port}`, async () => {}, () => {})).rejects.toThrow("login: access_denied");
});

test("login includes GitHub's error description", async () => {
  deviceReplies = [{ error: "incorrect_device_code", error_description: "bad code" }];
  await expect(login("cid", `http://127.0.0.1:${server.port}`, async () => {}, () => {})).rejects.toThrow("login: incorrect_device_code (bad code)");
});

test("login refuses an incomplete device code response", async () => {
  deviceCodeError = "";
  deviceIncomplete = true;
  await expect(login("cid", `http://127.0.0.1:${server.port}`, async () => {}, () => {})).rejects.toThrow("device code: incomplete response");
});

test("htmlUrl maps API URLs to pages", () => {
  const t = (url: string | null, type = "Issue") => ({ ...thread("1", "mention", 0), subject: { title: "x", url, type } });
  expect(htmlUrl(t("https://api.github.com/repos/o/r/issues/5"))).toBe("https://github.com/o/r/issues/5");
  expect(htmlUrl(t("https://api.github.com/repos/o/r/commits/abc"))).toBe("https://github.com/o/r/commit/abc");
  expect(htmlUrl(t(null, "CheckSuite"))).toBe("https://github.com/o/r/actions");
  expect(htmlUrl(t(null, "Discussion"))).toBe("https://github.com/notifications");
});

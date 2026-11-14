# github-notifications-ntfy

Forwards new GitHub notifications from your inbox to an [ntfy](https://ntfy.sh) topic.

It polls the REST endpoint `GET /notifications` once per run and is meant to be started by a timer about once a minute. It never uses GraphQL. Each request carries the previous `ETag` in `If-None-Match`, so an unchanged answer returns `304 Not Modified`, which GitHub does not count against the rate limit (GitHub ignores `If-Modified-Since` on this endpoint). The `X-Poll-Interval` header is honoured: a run that starts too early exits without calling GitHub.

## Behaviour

- Each poll asks only for threads updated since the previous poll (`since`, reaching back two minutes so nothing is missed between polls; repeats inside that window are dropped). The rest of the inbox is never read, however many unread threads it holds.
- The first successful run sends nothing; the next run picks up updates from two minutes before it.
- Later runs send one ntfy message per updated thread whose `reason` is in `REASONS`. The message title is `<owner/repo>: <subject title>`, the body is `<reason> / <subject type>`, and tapping it opens the pull request, issue or commit. State is saved after each message, so a run killed mid-way does not send the same thread twice.
- Notifications are not marked as read.
- If an ntfy POST fails, the threads not yet sent are sent again on the next run, and the run exits non-zero.
- If GitHub returns an error (for example an expired token), an ntfy message is sent when the error changes (not on every run while it repeats), and the run exits non-zero. If that message cannot be sent, it is tried again on the next run.
- Every page of updated threads is read (`Link: rel="next"`), up to 50 pages of 100.
- A missing or unreadable state file starts over with a new baseline.
- Each HTTP request gives up after 10 seconds.

## Configuration

Environment variables:

| Name | Required | Default |
|---|---|---|
| `GITHUB_NOTIFICATIONS_TOKEN` | yes | |
| `NTFY_URL` | yes (topic URL) | |
| `NTFY_TOKEN` | no | |
| `REASONS` | no (`all` sends every reason; unknown names are refused) | `mention,team_mention,review_requested,ci_activity` |
| `STATE_FILE` | no | `/var/lib/github-notifications-ntfy/state.json` |
| `GITHUB_API` | no | `https://api.github.com` |

Empty values (`REASONS=`) count as unset. `login` reads `GITHUB_OAUTH_CLIENT_ID` and, optionally, `GITHUB_WEB` (default `https://github.com`). Click links always point at github.com; GitHub Enterprise is not supported.

## Token

The Notifications API does not accept fine-grained personal access tokens or GitHub App tokens. Two kinds work:

- An OAuth app token (recommended). Register an OAuth app under Settings → Developer settings → OAuth Apps, tick "Enable Device Flow", and run the device flow once. Only the client ID is needed; there is no client secret and no callback server. The token is printed to stdout and the prompt to stderr, so redirect stdout straight into your secret store:

  ```bash
  GITHUB_OAUTH_CLIENT_ID=<client id> bun src/main.ts login > token.txt
  ```

  The token is requested with the `notifications` scope only and can be revoked from Settings → Applications → Authorized OAuth Apps.
- A classic personal access token with the `notifications` scope.

## Run with systemd

Requires [Bun](https://bun.sh). The unit expects `/usr/local/bin/bun`; edit `ExecStart` if bun lives elsewhere (the official installer puts it in `~/.bun/bin/bun`). The unit runs as a dynamic user with a read-only system.

```bash
git clone https://github.com/TakashiAihara/github-notifications-ntfy /opt/github-notifications-ntfy
install -m 600 /opt/github-notifications-ntfy/deploy/github-notifications-ntfy.env.example /etc/github-notifications-ntfy.env
install -m 644 /opt/github-notifications-ntfy/deploy/github-notifications-ntfy.service /opt/github-notifications-ntfy/deploy/github-notifications-ntfy.timer /etc/systemd/system/
```

Fill in `/etc/github-notifications-ntfy.env`, then:

```bash
systemctl daemon-reload && systemctl enable --now github-notifications-ntfy.timer
```

Check failures with `systemctl --failed` and `journalctl -u github-notifications-ntfy`.

## Development

```bash
bun install
bun run typecheck
bun test
```

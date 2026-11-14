# github-notifications-ntfy

Forwards new GitHub notifications from your inbox to an [ntfy](https://ntfy.sh) topic.

It polls the REST endpoint `GET /notifications` once per run and is meant to be started by a timer every minute. It never uses GraphQL. Each request carries `If-Modified-Since`, so an unchanged inbox returns `304 Not Modified`, which GitHub does not count against the rate limit. The `X-Poll-Interval` header is honoured: a run that starts too early exits without calling GitHub.

## Behaviour

- The first run records the threads already in the inbox and sends nothing.
- Later runs send one ntfy message per thread that is new or has a newer `updated_at`, if its `reason` is in `REASONS`. The message title is `<owner/repo>: <subject title>`, the body is `<reason> / <subject type>`, and tapping it opens the pull request, issue or commit.
- Notifications are not marked as read.
- If an ntfy POST fails, the threads not yet sent are sent again on the next run, and the run exits non-zero.
- If GitHub returns an error (for example an expired token), one ntfy message is sent per distinct error and the run exits non-zero.
- Only the newest 50 unread threads are read per run.

## Configuration

Environment variables:

| Name | Required | Default |
|---|---|---|
| `GITHUB_NOTIFICATIONS_TOKEN` | yes | |
| `NTFY_URL` | yes (topic URL) | |
| `NTFY_TOKEN` | no | |
| `REASONS` | no (`all` sends every reason) | `mention,team_mention,review_requested,ci_activity` |
| `STATE_FILE` | no | `/var/lib/github-notifications-ntfy/state.json` |
| `GITHUB_API` | no | `https://api.github.com` |

The Notifications API does not accept fine-grained personal access tokens or GitHub App tokens. Use a classic personal access token with the `notifications` scope.

## Run with systemd

Requires [Bun](https://bun.sh).

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

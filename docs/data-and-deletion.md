# Data and deletion

## What is stored

| Table | Personal data | Deleted |
| --- | --- | --- |
| `users` | Discord ID, username, display name, own nickname, avatar image, last login. No e-mail. Simulated players of test rooms ("Testspieler 1") are rows without any of it | No room membership left and last login older than `RETENTION_DAYS`; simulated players with their test room |
| `sessions` | Hash of the session token, expiry | Expire after 7 days, deleted at the next daily run; and with the user |
| `rooms` | Room name, who created it | `RETENTION_DAYS` after the last activity in the room |
| `room_members` | Who is in which room, as player or spectator, co-host | With the room or the user |
| `game_events` | Who rolled what and when, host actions | With the room |

Emoji reactions and guests of public rooms are never stored.
Discord tokens are dropped right after the login check. The browser never loads anything from Discord
except the login page; the app fetches and serves avatars itself.

## Automatic deletion

The app deletes at startup and then once a day (`RETENTION_DAYS`, default 90):

| What | When |
| --- | --- |
| Sessions | Expired ones (they stop working at expiry; logout deletes immediately) |
| Rooms, with members and events | `RETENTION_DAYS` after the last activity in the room |
| Simulated players | Together with their test room |
| Users | In no room any more, no valid session, and last login older than `RETENTION_DAYS` |

Each run logs only counts.

## Deleting one person by hand

There is no delete button. Do this when no game with the person is running.

```bash
docker compose exec postgres psql -U dice dice
```

```sql
-- 1. Find them: the Discord ID from the request, or by name.
SELECT id, discord_id, username, display_name, nickname, last_login_at
FROM users WHERE discord_id = '<discord-id>' OR username = '<username>';

-- 2. Delete. Sessions and room memberships go with the row (ON DELETE CASCADE);
--    rooms they created and events they caused stay, with the reference set to NULL.
DELETE FROM users WHERE id = '<id from step 1>';
```

3. Restart the app: `docker compose restart app`. Rooms live in its memory; the restart reloads them
   without the person, and their open connections end (their session is gone, so they cannot reconnect).

| Left behind | Personal? | To remove it too |
| --- | --- | --- |
| `rooms.created_by`, `game_events.actor_user_id` | No: `NULL` | Nothing to do |
| The user ID inside `game_events.payload` (turn order, rolls) | A random UUID that no longer points to anyone | Delete the rooms: `DELETE FROM rooms WHERE slug = '<slug>';` removes members and events of everyone in it |
| Logs on the server | Shortened IP address and user ID | Your log retention, below |
| Database backups | Everything above, as it was | Gone when the backup expires: deletion reaches backups only then (`PRIVACY_BACKUP_DAYS`) |

Deleting is not a ban: whoever logs in again gets a new row.

## Logs

Container, nginx and CrowdSec logs live outside the app. Limit how long the server keeps them, and keep
the privacy notice in line with what you set (`PRIVACY_LOG_DAYS`).

The app logs client addresses shortened: IPv4 to `/16` (`198.51.0.0`), IPv6 to `/48` (`2001:db8:abcd::`).
The full address stays in memory, for rate limits only. The privacy notice says logs hold only
shortened addresses: [nginx.example.conf](nginx.example.conf) does the same with its `dice_anon` log format.

| Source | Where to limit it |
| --- | --- |
| Container stdout | Docker `log-opts` (`max-size`, `max-file`), or journald `MaxRetentionSec=` with the `journald` log driver |
| nginx | logrotate: `daily` and `rotate <days>` |
| CrowdSec | `db_config.flush.max_age` in its `config.yaml` |

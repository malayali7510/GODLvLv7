# MALAYALI HERE key bot

This service hosts the protected page and runs the Telegram key bot. The bot owner can issue one-day, one-week, and one-month keys. A key activates on its first device and expires automatically.

## Before deployment

The Telegram token shared in chat should be revoked and replaced in BotFather before deployment. Store the replacement only as the host's `BOT_TOKEN` secret; never put it in the HTML, repository, or messages.

## Deploy on Railway

1. Upload this `malayali-here-key-server` folder to a new GitHub repository without any `.env` file.
2. Create a Railway project from that repository and add a persistent volume mounted at `/app/data`. The volume is required so generated keys survive restarts.
3. Add these Railway variables:
   - `BOT_TOKEN`: the replacement BotFather token.
   - `ADMIN_IDS`: leave blank for the first deployment.
4. Deploy. Open the bot in Telegram and send `/id`; it will reply with your numeric Telegram ID.
5. Add that number to `ADMIN_IDS` in Railway and redeploy.
6. Send `/keys` to the bot. You will see buttons for 1 day, 1 week, and 1 month. Tapping one sends a new key.

The protected website is the Railway service URL itself. Share that URL, not the standalone `index.html` file.

## Owner commands

- `/keys` — show duration buttons.
- `/id` — display a Telegram account ID.
- `/stats` — count generated and active keys.
- `/revoke MH-...` — revoke a key immediately.

## Security notes

- `ADMIN_IDS` is the permission control. Only IDs in it can generate or revoke keys.
- Each key is bound to the first browser/device that activates it.
- Do not use ephemeral hosting storage; attach the required `/app/data` volume.
- This is access control, not DRM: someone who can inspect a webpage may still copy publicly delivered code. Keep sensitive server-side information out of the webpage.

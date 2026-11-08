# Child Status App

## Deploy with shared data on Render and Supabase

The app stores shared records in PostgreSQL. Browser storage is only read once
to import existing records from that browser; new changes are written to the
shared database.

1. In Supabase, open **Project Settings → Database** (or **Connect**) and copy
   the PostgreSQL connection URI. Replace `[YOUR-PASSWORD]` with your database
   password. If it contains special characters, percent-encode them first.
2. In your Render web service, set `DATABASE_URL` to this URI. Keep it private.
   If Render cannot connect to the direct database host, use Supabase's
   **Session pooler** URI instead; the direct connection may not be reachable
   from hosts without IPv6 support.
3. Add these environment variables to the web service:
   - `PARENT_PIN`: a private code for the parent profile.
   - `CHILD_PIN`: a different private code for the child profile.
   - `SESSION_SECRET`: a random secret with at least 32 characters (for
     example, generate one with `openssl rand -hex 32`).
   - `NODE_ENV`: `production`.
4. Deploy the latest code. The app creates its database table on startup.
5. Open the Render site and sign in to the child profile on the device/browser
   that has the existing local data. Its old records are imported once. Other
   devices can then sign in with the same profile PINs to see the shared data.

Choose private PINs that are difficult to guess, and keep them and the session
secret private. Parent sessions can view shared records; only child sessions
can add, edit, or delete them. Keep the Supabase project and its backups when
changing or redeploying the Render web service; the data is not stored on the
web service's filesystem. Check Supabase's current free-tier limits and
inactivity rules.

## Install as an app

The site includes a web app manifest and service worker. Open the deployed site
over HTTPS, then use the browser's install or add-to-home-screen option. The app
shell is available offline after its first successful load; shared data and
other API features still require a network connection.

## Run locally

Set `DATABASE_URL`, `PARENT_PIN`, `CHILD_PIN`, and `SESSION_SECRET` in the
environment, then run:

```sh
npm install
npm start
```

# Child Status App

The browser app files are in `public/`, and the Node.js server is in `back/`.
The root `package.json` and `package-lock.json` are kept at the project root so
Render can install dependencies and start the service with `npm start`.

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
secret private. Parent sessions can view shared records, manage calendar
events/routines, and add comments to daily logs; only child sessions can
otherwise add, edit, or delete shared records. Keep the Supabase project and
its backups when changing or redeploying the Render web service; app data is
stored in Supabase, not on the web service's filesystem. Check Supabase's
current free-tier limits and inactivity rules.

## Install as an app

The site includes a web app manifest and service worker. Open the deployed site
over HTTPS, then use the browser's install or add-to-home-screen option. The app
shell is available offline after its first successful load; shared data and
other API features still require a network connection.

## Calendar colors and permissions

Both child and parent profiles can add, edit, and delete calendar events and
weekly routines. Events can use a selectable icon and color; synced Premier
League, La Liga, and F1 items use their own default icons and colors. Tasks can
also be assigned a color when created.

Parents can add a comment to each existing daily log. The child sees the
comment when opening today's log.

Calendar views have filters for weekly events, sports, and specific events.
Weekly routines can be assigned to any combination of weekdays.

Parents can import read-only events from Google Calendar without Google Cloud
or OAuth setup. In Google Calendar settings, copy the calendar's private iCal
address, paste it into the parent calendar's **Private iCal link** field, and
select **Save link**, then **Sync now**. The private link is stored in the
PostgreSQL database and never returned to the browser after saving. Keep it
secret; anyone with it may be able to read that calendar. Imported events are
visible to both profiles. Sync reads events from Google and never writes to the
Google Calendar.

## Run locally

Set `DATABASE_URL`, `PARENT_PIN`, `CHILD_PIN`, and `SESSION_SECRET` in the
environment, then run:

```sh
npm install
npm start
```

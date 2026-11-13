# Reach Timing

Chrome extension for x.com profiles you open yourself. It shows:

- their **local time** and how far it is from yours,
- whether **now is a good time to message** (and when the next window is, in your time),
- a **24-hour posting heatmap** and a timezone estimate from when they post,
- a **confidence badge** (self-reported location vs. posting pattern; flags conflicts),
- bio links and email, followers, whether DMs look open, whether they follow you,

and a **Save to Notion** button that writes all of it to your leads database (or updates the existing row for that handle).

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick this `extension` folder.
3. Click the extension icon (or the ⚙ in the panel) to open settings.

## Notion setup (once)

1. `notion.so/profile/integrations` → create an **internal integration** and copy its secret.
2. In Notion create a **database** (a table). Open it → **•••** → **Connections** → add your integration.
3. In the extension settings paste the token and the database link, press **Test connection**, then **Add missing columns**.

It fills these columns when they exist: Display name, Profile URL, Location, Resolved place, Timezone, UTC offset,
Their time (at save), Best window (my time), TZ confidence, Bio, Links, Followers, Last post, DMs open, Follows me,
Last checked. The title column gets `@handle`. Existing columns with similar names ("Time zone", "Website", …) are matched
automatically. **Status** is only set to `New` when a row is created, and **Notes** is never touched.

## How it works

- Reads only the profile page you are on (no extra requests to X). Posting hours come from the posts currently loaded, so
  scroll their profile to improve the estimate.
- The only data sent out for the timezone lookup is the location text, to Open-Meteo's geocoding API (cached 30 days).
- The Notion token lives in `chrome.storage.local` and is only sent to `api.notion.com`.

## Tests

```
node test/core.test.js
node test/background.test.js
```

`test/harness.html` is a mock X profile DOM for trying the panel without logging in to X.

## If X changes its markup

The selectors are `data-testid` hooks in `content.js` (`UserName`, `UserLocation`, `UserDescription`, `UserUrl`,
`sendDMFromProfile`, `article[data-testid="tweet"]`). That is the one place to update.

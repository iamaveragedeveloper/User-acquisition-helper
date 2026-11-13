# Reach Timing

Chrome extension for x.com profiles you open yourself. It shows:

- **one clear answer at the top**: "They just posted, reply now then DM", "Good time to message", or "Better to wait,
  try 8:30 PM your time",
- **your clock and theirs side by side**,
- four short rows: **Last post** (how long ago, with a link), **Usually posts** (in your time), **Next post**, **DMs**,
- everything wordier lives under **More details** (collapsed): latest posts with their text and times, their posting
  routine, where they are and how sure we are, a 24-hour you-vs-them timeline, followers, links and bio,

The idea: when they post, reply to the post first, then DM within about 5 minutes. X doesn't add new posts to an open
page, so refresh the profile to check for new ones. To work out their usual posting times, scroll down their profile
to load more posts (about 8 are needed).

**No Notion needed.** Open a profile and click the toolbar icon: the popup shows all of the above (a floating panel on the
page shows it too; turn that off in settings if you only want the popup). Notion is an optional extra that adds a
**Save to Notion** button, which writes it to your leads database (or updates the existing row for that handle).

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick this `extension` folder.
3. Pin the extension, open an X profile, click the icon. Settings are behind the ⚙ in the popup.
   If the profile tab was open before you installed or reloaded the extension, refresh that tab once.

## Notion setup (optional, once)

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

# Raspberry Pi display

Open **https://pi.marktan.ai** in Chromium at 800 × 480, landscape, 100% browser zoom. The subdomain root opens `/pi` in the same Vercel project. The main homepage is unchanged. The page includes Happy Day (the same anniversary calculation as the homepage), Singapore weather, SGD/JPY, ARES, VWRA.L, and SGD per half troy ounce of gold.

Gold reuses the homepage's GC=F futures proxy multiplied by USD/SGD and 0.5. It is not a spot quote or a retail bullion price. Equity/FX/gold timestamps are the provider's quote times, in Singapore time; data may be delayed. Weather is fetched from the same Open-Meteo provider as the homepage. The lightweight data endpoint refreshes at most every five minutes, independently of the homepage's daily edition.

The display also includes BTC in USD. All five tiles show signed absolute and percentage changes, with green/up, red/down, or neutral/flat indicators. Changes compare the current quote with the last available five-minute close at or before 24 hours ago; when markets are closed, the latest known price carries forward. Gold compares the SGD half-ounce value at both times, incorporating currency changes. Missing historical data is marked unavailable rather than substituted with a previous-close figure.

YouTube captions are disabled at player initialization and when each video's captions module loads. Subtitles burned into a video image cannot be removed.

The latest five public channel uploads refresh every 15 minutes. Changed lists take over at the next video boundary. Playback loops, starts muted and skips unavailable videos. Tap Sound off to unmute. YouTube may require a tap to start, and its ads, embedding restrictions and outages still apply. The public RSS feed is used first, with the public Videos tab as a fallback. That fallback depends on YouTube page structure and may need maintenance. No video files are downloaded.

## Birthdays

The installed physical Pi uses a separate birthday-only device credential and needs no Google login. A local Chromium extension adds an Authorization header only to `https://pi.marktan.ai/api/display-birthdays`, only for same-site GET requests. The credential stays in the Pi user's protected configuration directory; the repository contains only its SHA-256 verifier in `api/_birthday-device.js`. That endpoint returns names and month/day only for the −3/+7-day notice window, never birth years, private events, edits, finances or owner-session access. Responses use `private, no-store`. Remove the verifier and redeploy to revoke the Pi. This is a device-installed bearer credential, not a hardware-backed key; someone with access to the Pi user's files could copy it.

The following owner-login option remains available for other browsers:

For Google Sign-In on the new hostname, add `https://pi.marktan.ai` to the existing Google OAuth client's Authorized JavaScript origins. Browser sessions are specific to each hostname. The display's homepage link opens `/index.html` on its current hostname.

Sign in on the homepage once in the **same Pi Chromium profile and hostname**, then return to `/pi`. The display reuses the existing owner session and private calendar endpoint; birthday names are never added to a public feed or cached in browser storage. Notices alternate with weather every ten seconds, cycling through all birthdays from three days ago through seven days ahead, ordered the same way as the homepage. Dates use Singapore time. Without a valid owner session, only weather appears; sign in again if the session expires (normally 90 days). The local preview has no private birthday data.

## Brightness controls

Auto dims at 21:30 and returns to full at 07:30, Asia/Singapore, irrespective of the Pi's timezone. Dim / Full persist in this browser until Auto is selected again. The controls remain touchable when dimmed. This uses a browser brightness filter, including the video; it does not change the panel's physical backlight. Actual backlight control requires the specific display driver and a local Pi service.

## Pi setup after the display arrives

Use the display manufacturer's Pi 5 instructions for its DSI cable, connector, driver and orientation. Power off and unplug the Pi before connecting DSI. Confirm the desktop is 800 × 480 first.

Test the page from the Pi desktop's terminal:

```sh
chromium --kiosk https://marktan.ai/pi
```

For automatic startup, create `~/.config/autostart/marktan-display.desktop` on the Pi with:

```ini
[Desktop Entry]
Type=Application
Name=Marktan display
Exec=chromium --kiosk https://marktan.ai/pi
Terminal=false
```

Enable desktop auto-login and disable screen blanking in Raspberry Pi's desktop settings so the nightly schedule remains visible. This requires Raspberry Pi OS with Desktop. A display that lacks speakers needs separate audio output for sound. Keep the system clock synchronized. Exit kiosk with Alt+F4.

## Development

`node scripts/preview-pi.mjs` starts the preview at http://127.0.0.1:8899/pi.
`node scripts/test-pi.mjs` checks the time boundaries, overrides, Happy Day dates, YouTube parsing, gold conversion, and independent provider failure.

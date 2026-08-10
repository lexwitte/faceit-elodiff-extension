# FACEIT Elo Diff

A small Chrome extension that adds a widget to every Faceit CS2 match room to compare **highest** and **last season** players ELO and find outliers.

<p align="center">
  <img src="widget.png" alt="Elo Diff widget preview" width="640">
</p>

## Why this is useful

Faceit's match room only shows each player's current ELO. That number hides a lot: a player sitting at 2500 today might have peaked above 3200, this extension reveals it.

**Elo Diff** pulls each player's per-season history straight from Faceit's own season statistics API — peak ELO across all seasons, plus where they ended the latest one — and shows it right there in the match room, so you can see at a glance:

- Who on your team has played at a much higher level before.
- Whether the enemy team is stronger than their current ELO suggests.
- A rough win-chance estimate based on the available team ELO averages.

## Install

### Chrome Web Store (preferred)

Go to [chrome web store page](https://chromewebstore.google.com/detail/nfpmdefcdiahenhmnclenahedbkadcog)
and click "Add to Chrome".

### Developer mode

If chrome webstore version is not available for some reason or for developing purposes.

1. Download this folder (Code → Download ZIP, then unzip).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and pick the unzipped folder.

## A note on speed

The first time a player appears, their season history has to be fetched from the web. Requests go out one at a time (the API is rate limited), so a room of ten new players fills in over a few seconds — rows update as each one lands. Results are saved locally for a week. Use the chevron in the widget header to collapse or expand the room details.

## Privacy

- Your Faceit session is used only to read the match you're already looking at and each player's season stats.
- No data is sent to any third-party service.
- Season results are cached in your browser.

## Tech details

- Manifest V3 Chrome extension, no frameworks, no build step.
- `background.js` fetches the Faceit match API and each player's Faceit CS2 season statistics.
- `content.js` injects the widget into the match room's info section.
- Cache lives in `chrome.storage.local` (7 days for found players, 1 day for players with no season ELO).
- Win chance uses the Elo expected-score formula with a 1000-point scale.

## Assisted by

Built with help from **Claude Opus 4.7** (Anthropic) via Claude Code.

# 🚇 Tubed — Daily London Underground Puzzle

**A daily puzzle game where you find the fastest route on the London Underground.**

🔗 **Play at [playtubed.co.uk](https://playtubed.co.uk)**

---

## What is Tubed?

Tubed is a daily browser-based puzzle game inspired by the London Underground. Each day, players are given a start station and a destination, and must build the fastest possible route — choosing the right lines and interchanges to beat the optimal time.

A new puzzle is generated every day at midnight. Everyone in the world gets the same puzzle on the same day, just like Wordle.

---

## How to play

1. You are given a **start station** and a **destination**
2. Build your route by selecting stations and lines one stop at a time using the **station search** — type to find stations instantly, then pick a line
3. You must change lines at least once — no single-line routes
4. Your final stop must be the destination station
5. Submit your route and see how it compares to the optimal

### Scoring

| Medal | Time vs optimal |
|---|---|
| 🥇 | Within 2 minutes |
| 🥈 | Within 5 minutes |
| 🥉 | Within 10 minutes |
| ⭐ | Within 20 minutes |
| 🚇 | More than 20 minutes off |

---

## Features

- **Endless daily puzzles** — algorithmically generated from the date, unique every day forever
- **Route validation** — impossible routes are rejected with a clear explanation
- **Live map** — your route is drawn on a real London map as you build it, with each line coloured correctly
- **Station search with autocomplete** — type to find stations instantly with highlighted matches; keyboard navigation supported
- **Top 5 routes** — see the best possible routes after submitting, each ranked with line-by-line breakdown
- **Your route vs optimal** — results screen shows your route and the optimal route side-by-side, with interchange times itemised
- **Efficiency score** — animated progress bar showing how close you were to optimal, expressed as a percentage
- **Hints system** — three optional hints per puzzle, tracked and reported in your final score:
  - Hint 1: Lines serving the start station
  - Hint 2: Lines serving the destination station
  - Hint 3: Which line to start on
- **Share your result** — one tap copies your score to share with friends, including hints used
- **Day streak** — tracks how many consecutive days you've played
- **How to play modal** — built-in tutorial for new players, shown automatically on first visit
- **Feedback** — in-app feedback form sends directly to the Tubed team
- **Works on mobile** — fully optimised for phones

---

## Technical details

Tubed is a **single static HTML file** — no backend, no database, no server-side code.

- **Frontend** — vanilla HTML, CSS and JavaScript
- **Map** — [Leaflet.js](https://leafletjs.com) with CartoDB Voyager tiles
- **Fonts** — Bebas Neue + DM Sans via Google Fonts
- **Journey times** — extracted from the TfL Timetable API per line, pre-calculated and baked into the HTML as a static lookup table; travel time only (no waiting)
- **Interchange times** — per-station platform-to-platform walk times, used in both scoring and pathfinding
- **Pathfinding** — Dijkstra's algorithm across a full multi-line graph, returning up to 5 distinct optimal routes
- **Puzzle generation** — seeded random algorithm using the date, ensuring everyone gets the same puzzle
- **Score storage** — browser localStorage (no accounts, no data sent anywhere)
- **Feedback** — submitted via [Web3Forms](https://web3forms.com) (no backend required)
- **Analytics** — privacy-friendly page-view counting via [GoatCounter](https://www.goatcounter.com)
- **Hosting** — GitHub Pages (free, static)

---

## Running locally

No build step required. Just open `index.html` in any modern browser.

```bash
git clone https://github.com/douglas-ck-weir/tubed.git
cd tubed
open index.html
```

---

## Data sources

Journey times and station data are sourced from TFL timetable information.

> Powered by TfL Open Data · Not affiliated with Transport for London

Station coordinates, line colours and network topology are based on publicly available London Underground data. Lines covered: Bakerloo, Central, Circle, District, DLR, Elizabeth, Hammersmith & City, Jubilee, Metropolitan, Northern, Overground, Piccadilly, Victoria, Waterloo & City.

---

## Roadmap

- [ ] Difficulty modes (Easy / Medium / Hard based on number of interchanges)
- [ ] Personal stats screen
- [ ] Yesterday's answer reveal
- [ ] Streak calendar
- [ ] Leaderboard

---

## Licence

This project is for personal and educational use. Journey data is sourced from TfL Open Data under their [transport data terms](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service). The TfL name, roundel and branding are not used. This project is not affiliated with or endorsed by Transport for London.

---

*Built with ☕ and a deep respect for the Jubilee line.*

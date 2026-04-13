# 🌤️ Laaganan Finder

A weather-based activity spot finder. It grabs your current location, checks live weather across a grid of nearby coordinates, scores each point based on your chosen activity, and pins the best spot on an interactive map.

No API key required — powered by [Open-Meteo](https://open-meteo.com/).

---

## Features

- 📍 Auto-detects your current location via browser geolocation
- 🗺️ Renders an interactive map with color-coded weather markers
  - 🟢 Green — great conditions
  - 🟠 Orange — decent conditions
  - 🔴 Red — poor conditions
- ⭐ Highlights the single best nearby spot for your activity
- 🏖️ Three activity modes: **General**, **Beach**, **Hiking**
- ⚡ Fetches all 25 grid points in parallel for fast results

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML, CSS, Vanilla JS |
| Map | [Leaflet.js](https://leafletjs.com/) + OpenStreetMap |
| Backend | Node.js + Express |
| Weather API | [Open-Meteo](https://open-meteo.com/) (free, no key) |

---

## Getting Started

**Requirements:** Node.js 18 or higher (for built-in `fetch`)

```bash
# 1. Clone the repo
git clone https://github.com/RipMickel/laaganan-finder.git
cd laaganan-finder

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Then open **http://localhost:3000** in your browser and allow location access when prompted.

---

## How It Works

1. On clicking **Find Best Spot**, the app gets your GPS coordinates.
2. A 5×5 grid of points is generated around you (~0.2° spacing, roughly 20 km radius).
3. Each point is sent to the Express backend, which fetches live weather from Open-Meteo.
4. Every point is scored based on the selected activity (see scoring below).
5. All markers are drawn on the map; the highest-scoring point gets a ⭐ pin.

### Scoring Logic

**Beach 🏖️**
- Temp 26–34°C → +3
- Clear sky → +3
- Wind under 6 m/s → +1
- Rain → −5

**Hiking 🥾**
- Temp 18–26°C → +3
- Cloudy → +2
- Wind under 8 m/s → +1
- Rain → −4

**General 🌍**
- Temp 20–30°C → +2
- Clear sky → +2
- Rain → −3

---

## Project Structure

```
laaganan-finder/
├── index.html      # Frontend UI
├── script.js       # Map logic, scoring, geolocation
├── server.js       # Express server + Open-Meteo proxy
├── package.json
└── README.md
```

---

## Notes

- The app requires browser geolocation permission to work.
- Open-Meteo is free with no rate limits for reasonable use.
- Works best on desktop browsers; mobile Chrome/Safari should work too.

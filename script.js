// ─────────────────────────────────────────────
// 1. MAP SETUP — base tile layers + layer control
// ─────────────────────────────────────────────

// Standard OpenStreetMap tile layer
const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
});

// Satellite tile layer (Esri World Imagery — free, no API key)
const satelliteLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution: 'Tiles © Esri — Source: Esri, Maxar, GeoEye, and the GIS User Community'
  }
);

// Initialize map with OSM as default
const map = L.map('map', {
  center: [14.5995, 120.9842],
  zoom: 10,
  layers: [osmLayer]  // start with street view
});

// Layer control toggle (top-right corner) — switches between street & satellite
L.control.layers(
  { '🗺️ Street Map': osmLayer, '🛰️ Satellite': satelliteLayer },
  {},
  { position: 'topright' }
).addTo(map);

// ─────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────

let markers = [];          // weather circle markers
let routeControl = null;   // Leaflet Routing Machine instance
let routePoints = [];      // [startLatLng, endLatLng] collected by clicks
let routeMode = false;     // whether routing click-mode is active

// ─────────────────────────────────────────────
// 3. GEOLOCATION — center map on user on load
// ─────────────────────────────────────────────

navigator.geolocation.getCurrentPosition(pos => {
  map.setView([pos.coords.latitude, pos.coords.longitude], 11);
});

// ─────────────────────────────────────────────
// 4. ROUTING — click two points to draw a route
// ─────────────────────────────────────────────

// Toggle routing mode on/off
function toggleRouteMode() {
  routeMode = !routeMode;
  const btn = document.getElementById('btn-route-mode');

  if (routeMode) {
    btn.classList.add('active');
    btn.textContent = '📍 Click start point…';
    setResult('📍 Click on the map to set your <b>start point</b>.');
    routePoints = [];
    resetRoute();             // clear any previous route
  } else {
    btn.classList.remove('active');
    btn.textContent = '🗺️ Get Directions';
    setResult('Directions mode off.');
  }
}

// Listen for map clicks when routing mode is active
map.on('click', function (e) {
  if (!routeMode) return;

  routePoints.push(e.latlng);

  if (routePoints.length === 1) {
    // First click = start point
    document.getElementById('btn-route-mode').textContent = '📍 Click end point…';
    setResult('📍 Now click on the map to set your <b>end point</b>.');

  } else if (routePoints.length === 2) {
    // Second click = end point → draw the route
    drawRoute(routePoints[0], routePoints[1]);

    // Exit routing mode automatically
    routeMode = false;
    const btn = document.getElementById('btn-route-mode');
    btn.classList.remove('active');
    btn.textContent = '🗺️ Get Directions';
  }
});

// Draw route between two LatLng points using OSRM (free, no key)
function drawRoute(from, to) {
  // Remove any existing route first
  if (routeControl) {
    map.removeControl(routeControl);
    routeControl = null;
  }

  routeControl = L.Routing.control({
    waypoints: [
      L.latLng(from.lat, from.lng),
      L.latLng(to.lat, to.lng)
    ],
    // OSRM public demo server — free, no API key needed
    router: L.Routing.osrmv1({
      serviceUrl: 'https://router.project-osrm.org/route/v1'
    }),
    // Style the route line
    lineOptions: {
      styles: [{ color: '#1a73e8', weight: 5, opacity: 0.8 }]
    },
    // Show the turn-by-turn directions panel
    show: true,
    collapsible: true,
    // Don't add default drag-to-reposition markers
    addWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false
  }).addTo(map);

  // Show the Clear Route button once a route is drawn
  document.getElementById('btn-reset-route').style.display = 'inline-block';

  setResult('🛣️ Route drawn! See the panel for turn-by-turn directions.');
}

// Remove the current route and hide the clear button
function resetRoute() {
  if (routeControl) {
    map.removeControl(routeControl);
    routeControl = null;
  }
  routePoints = [];
  document.getElementById('btn-reset-route').style.display = 'none';
}

// ─────────────────────────────────────────────
// 5. WEATHER GRID — existing logic (unchanged)
// ─────────────────────────────────────────────

function generateGrid(lat, lon, step = 0.2, size = 2) {
  let points = [];
  for (let i = -size; i <= size; i++) {
    for (let j = -size; j <= size; j++) {
      points.push({ lat: lat + i * step, lon: lon + j * step });
    }
  }
  return points;
}

// WMO weather code → readable label
function interpretWMO(code) {
  if (code === 0)  return "Clear";
  if (code <= 3)   return "Clouds";
  if (code <= 48)  return "Fog";
  if (code <= 67)  return "Rain";
  if (code <= 77)  return "Snow";
  if (code <= 82)  return "Rain";
  if (code <= 99)  return "Thunderstorm";
  return "Unknown";
}

// Fetch weather from Open-Meteo (free, no API key)
async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,wind_speed_10m,weather_code` +
    `&wind_speed_unit=ms`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const raw = await res.json();
  const c = raw.current;

  return {
    temp: c.temperature_2m,
    wind: c.wind_speed_10m,
    weather: interpretWMO(c.weather_code),
  };
}

// Reverse geocode coordinates → place name (Nominatim, free, no key)
async function getPlaceName(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    const a = data.address;
    return a.suburb || a.village || a.town || a.city || a.county || data.display_name.split(',')[0];
  } catch {
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}

// Score a weather point based on the selected activity
function scoreWeather(temp, weather, wind, activity) {
  let score = 0;

  if (activity === 'beach') {
    if (temp >= 26 && temp <= 34) score += 3;
    if (weather === 'Clear')      score += 3;
    if (wind < 6)                 score += 1;
    if (weather === 'Rain')       score -= 5;
  } else if (activity === 'hiking') {
    if (temp >= 18 && temp <= 26) score += 3;
    if (weather === 'Clouds')     score += 2;
    if (wind < 8)                 score += 1;
    if (weather === 'Rain')       score -= 4;
  } else {
    if (temp >= 20 && temp <= 30) score += 2;
    if (weather === 'Clear')      score += 2;
    if (weather === 'Rain')       score -= 3;
  }

  return score;
}

function getColor(score) {
  if (score >= 5) return 'green';
  if (score >= 2) return 'orange';
  return 'red';
}

function setResult(msg) {
  document.getElementById('result').innerHTML = msg;
}

// Main function — fetch weather grid and find best spot
async function loadData() {
  setResult('📍 Getting your location...');

  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    const activity = document.getElementById('activity').value;

    // Clear old weather markers
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    map.setView([latitude, longitude], 11);
    setResult('⏳ Fetching weather for nearby spots...');

    const grid = generateGrid(latitude, longitude);

    // Fetch all 25 grid points in parallel
    const results = await Promise.allSettled(
      grid.map(async point => {
        const w = await fetchWeather(point.lat, point.lon);
        return { point, w };
      })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');

    if (succeeded.length === 0) {
      const reason = results[0]?.reason?.message || 'Unknown error';
      setResult(`❌ Failed to fetch weather: <b>${reason}</b>`);
      return;
    }

    let bestSpot  = null;
    let bestScore = -Infinity;

    for (const result of succeeded) {
      const { point, w } = result.value;
      const score = scoreWeather(w.temp, w.weather, w.wind, activity);

      if (score > bestScore) {
        bestScore = score;
        bestSpot  = { ...point, w, score };
      }

      const marker = L.circleMarker([point.lat, point.lon], {
        color: getColor(score),
        radius: 8,
      })
        .addTo(map)
        .bindPopup(`
          Temp: ${w.temp}°C<br>
          Weather: ${w.weather}<br>
          Wind: ${w.wind} m/s<br>
          Score: ${score}
        `);

      markers.push(marker);
    }

    if (bestSpot) {
      setResult('📍 Finding place name...');
      const placeName = await getPlaceName(bestSpot.lat, bestSpot.lon);

      L.marker([bestSpot.lat, bestSpot.lon])
        .addTo(map)
        .bindPopup(`
          <b>⭐ BEST SPOT</b><br>
          <b>${placeName}</b><br>
          Temp: ${bestSpot.w.temp}°C<br>
          Weather: ${bestSpot.w.weather}<br>
          Score: ${bestSpot.score}
        `)
        .openPopup();

      setResult(
        `⭐ Best spot for <b>${activity}</b>: <b>${placeName}</b> — ` +
        `${bestSpot.w.weather}, ${bestSpot.w.temp}°C (score: ${bestSpot.score}) &nbsp;|&nbsp; ` +
        `<span style="color:#1a73e8; cursor:pointer;" onclick="toggleRouteMode()">🗺️ Get directions there</span>`
      );
    }

  }, err => {
    setResult(`❌ Location error: ${err.message}. Please allow location access.`);
  });
}
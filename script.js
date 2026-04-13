// ─────────────────────────────────────────────
// 1. MAP SETUP — base tile layers + layer control
// ─────────────────────────────────────────────

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
});

// Satellite tile layer — Esri World Imagery (free, no API key)
const satelliteLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution: 'Tiles © Esri — Esri, Maxar, GeoEye, and the GIS User Community'
  }
);

const map = L.map('map', {
  center: [14.5995, 120.9842],
  zoom: 10,
  layers: [osmLayer]
});

// Layer toggle (top-right) — street vs satellite
L.control.layers(
  { '🗺️ Street Map': osmLayer, '🛰️ Satellite': satelliteLayer },
  {},
  { position: 'topright' }
).addTo(map);

// ─────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────

let markers      = [];       // weather circle markers
let routeControl = null;     // Leaflet Routing Machine instance
let routePoints  = [];       // [startLatLng, endLatLng]
let routeMode    = false;    // whether routing click-mode is active
let locationPin  = null;     // current-location marker
let searchPin    = null;     // searched-place marker
let searchTimer  = null;     // debounce timer for autocomplete

// ─────────────────────────────────────────────
// 3. CURRENT LOCATION PIN
// ─────────────────────────────────────────────

// Custom blue pulsing icon for the user's location
const locationIcon = L.divIcon({
  className: '',
  html: `
    <div style="
      width: 18px; height: 18px;
      background: #4285f4;
      border: 3px solid white;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(66,133,244,0.3);
    "></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  popupAnchor: [0, -12]
});

// Place (or move) the user's location pin and center the map
function placeLocationPin(lat, lon, label = 'You are here') {
  if (locationPin) map.removeLayer(locationPin);
  locationPin = L.marker([lat, lon], { icon: locationIcon })
    .addTo(map)
    .bindPopup(`<b>📍 ${label}</b><br>${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  map.setView([lat, lon], 13);
}

// "My Location" button — asks browser for GPS, drops pin
function goToMyLocation() {
  setResult('📍 Getting your location...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      placeLocationPin(pos.coords.latitude, pos.coords.longitude);
      setResult('📍 Showing your current location.');
    },
    err => {
      setResult(`❌ Location error: ${err.message}`);
    }
  );
}

// Auto-drop location pin on page load (silently, no status message)
navigator.geolocation.getCurrentPosition(pos => {
  placeLocationPin(pos.coords.latitude, pos.coords.longitude);
});

// ─────────────────────────────────────────────
// 4. PLACE SEARCH (Nominatim autocomplete)
// ─────────────────────────────────────────────

// Called on every keypress — debounced to avoid hammering Nominatim
function onSearchInput() {
  clearTimeout(searchTimer);
  const query = document.getElementById('search-input').value.trim();
  if (query.length < 3) {
    hideSuggestions();
    return;
  }
  // Wait 400ms after user stops typing before querying
  searchTimer = setTimeout(() => fetchSuggestions(query), 400);
}

async function fetchSuggestions(query) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const results = await res.json();
    showSuggestions(results);
  } catch {
    hideSuggestions();
  }
}

function showSuggestions(results) {
  const box = document.getElementById('search-suggestions');
  if (!results.length) { hideSuggestions(); return; }

  box.innerHTML = results.map((r, i) =>
    `<div class="suggestion-item" onclick="selectSuggestion(${r.lat}, ${r.lon}, '${r.display_name.replace(/'/g, "\\'")}')">
      ${r.display_name}
    </div>`
  ).join('');
  box.style.display = 'block';
}

function hideSuggestions() {
  document.getElementById('search-suggestions').style.display = 'none';
}

// User clicked a suggestion — fly to it and drop a pin
function selectSuggestion(lat, lon, name) {
  document.getElementById('search-input').value = name.split(',')[0];
  hideSuggestions();
  flyToPlace(parseFloat(lat), parseFloat(lon), name);
}

// Search on "Go" button or Enter key — uses first Nominatim result
async function searchPlace() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  hideSuggestions();
  setResult('🔎 Searching...');

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const results = await res.json();
    if (!results.length) {
      setResult(`❌ No results found for "<b>${query}</b>".`);
      return;
    }
    const r = results[0];
    flyToPlace(parseFloat(r.lat), parseFloat(r.lon), r.display_name);
  } catch {
    setResult('❌ Search failed. Check your connection.');
  }
}

// Fly to a searched place and drop a red pin
function flyToPlace(lat, lon, name) {
  if (searchPin) map.removeLayer(searchPin);

  searchPin = L.marker([lat, lon])
    .addTo(map)
    .bindPopup(`<b>🔎 ${name.split(',')[0]}</b><br>${name}`)
    .openPopup();

  map.flyTo([lat, lon], 14, { duration: 1.2 });
  setResult(`🔎 Showing: <b>${name.split(',')[0]}</b>`);
}

// Close suggestions when clicking elsewhere on the page
document.addEventListener('click', e => {
  if (!e.target.closest('#search-container')) hideSuggestions();
});

// ─────────────────────────────────────────────
// 5. ROUTING — click two points to draw a route
// ─────────────────────────────────────────────

function toggleRouteMode() {
  routeMode = !routeMode;
  const btn = document.getElementById('btn-route-mode');

  if (routeMode) {
    btn.classList.add('active');
    btn.textContent = '📍 Click start…';
    setResult('📍 Click on the map to set your <b>start point</b>.');
    routePoints = [];
    resetRoute();
  } else {
    btn.classList.remove('active');
    btn.textContent = '🗺️ Get Directions';
    setResult('Directions mode off.');
  }
}

map.on('click', function (e) {
  if (!routeMode) return;

  routePoints.push(e.latlng);

  if (routePoints.length === 1) {
    document.getElementById('btn-route-mode').textContent = '📍 Click end…';
    setResult('📍 Now click your <b>end point</b> on the map.');
  } else if (routePoints.length === 2) {
    drawRoute(routePoints[0], routePoints[1]);
    routeMode = false;
    const btn = document.getElementById('btn-route-mode');
    btn.classList.remove('active');
    btn.textContent = '🗺️ Get Directions';
  }
});

function drawRoute(from, to) {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }

  routeControl = L.Routing.control({
    waypoints: [L.latLng(from.lat, from.lng), L.latLng(to.lat, to.lng)],
    router: L.Routing.osrmv1({
      serviceUrl: 'https://router.project-osrm.org/route/v1'
    }),
    lineOptions: {
      styles: [{ color: '#1a73e8', weight: 5, opacity: 0.85 }]
    },
    show: true,
    collapsible: true,
    addWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false
  }).addTo(map);

  document.getElementById('btn-reset-route').style.display = 'inline-block';
  setResult('🛣️ Route drawn! See the panel for turn-by-turn directions.');
}

function resetRoute() {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routePoints = [];
  document.getElementById('btn-reset-route').style.display = 'none';
}

// ─────────────────────────────────────────────
// 6. WEATHER GRID — existing logic (unchanged)
// ─────────────────────────────────────────────

function generateGrid(lat, lon, step = 0.2, size = 2) {
  let points = [];
  for (let i = -size; i <= size; i++)
    for (let j = -size; j <= size; j++)
      points.push({ lat: lat + i * step, lon: lon + j * step });
  return points;
}

function interpretWMO(code) {
  if (code === 0)  return 'Clear';
  if (code <= 3)   return 'Clouds';
  if (code <= 48)  return 'Fog';
  if (code <= 67)  return 'Rain';
  if (code <= 77)  return 'Snow';
  if (code <= 82)  return 'Rain';
  if (code <= 99)  return 'Thunderstorm';
  return 'Unknown';
}

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
  return { temp: c.temperature_2m, wind: c.wind_speed_10m, weather: interpretWMO(c.weather_code) };
}

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

async function loadData() {
  setResult('📍 Getting your location...');

  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    const activity = document.getElementById('activity').value;

    markers.forEach(m => map.removeLayer(m));
    markers = [];

    // Re-drop the location pin in case it moved
    placeLocationPin(latitude, longitude);
    setResult('⏳ Fetching weather for nearby spots...');

    const grid = generateGrid(latitude, longitude);
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

      if (score > bestScore) { bestScore = score; bestSpot = { ...point, w, score }; }

      const marker = L.circleMarker([point.lat, point.lon], { color: getColor(score), radius: 8 })
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
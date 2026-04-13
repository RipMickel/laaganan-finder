// ─────────────────────────────────────────────
// 1. MAP SETUP
// ─────────────────────────────────────────────

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
});

const satelliteLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Tiles © Esri' }
);

const map = L.map('map', {
  center: [14.5995, 120.9842],
  zoom: 10,
  layers: [osmLayer]
});

L.control.layers(
  { '🗺️ Street Map': osmLayer, '🛰️ Satellite': satelliteLayer },
  {}, { position: 'topright' }
).addTo(map);

// ─────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────

let placeMarkers   = [];      // all category place markers
let routeControl   = null;
let routePoints    = [];
let routeMode      = false;
let locationPin    = null;
let userLatLng     = null;
let searchPin      = null;
let searchTimer    = null;
let activeCategory = null;
const resultCache  = {};      // cache: "type|lat4|lng4" → elements[]

// ─────────────────────────────────────────────
// 3. CATEGORY CONFIG
// ─────────────────────────────────────────────

// Faster Overpass mirrors — tried in order until one succeeds
const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

// Pick the fastest mirror via a lightweight race
let fastMirror = OVERPASS_MIRRORS[0]; // will be updated on first use

async function overpassFetch(query) {
  // Try mirrors in parallel, use whichever responds first
  const controllers = OVERPASS_MIRRORS.map(() => new AbortController());
  const requests = OVERPASS_MIRRORS.map((url, i) =>
    fetch(url, {
      method: 'POST',
      body: query,
      signal: controllers[i].signal
    }).then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      // Cancel remaining requests
      controllers.forEach((c, j) => { if (j !== i) c.abort(); });
      fastMirror = url;
      return json;
    })
  );
  return Promise.any(requests);
}

const CATEGORIES = {
  restaurant: {
    emoji: '🍽️', label: 'Restaurant', color: '#e53935', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["amenity"="restaurant"](around:${r},${lat},${lng}););out qt 120;`
  },
  pizza: {
    emoji: '🍕', label: 'Pizza', color: '#f4511e', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["amenity"~"restaurant|fast_food"]["cuisine"~"pizza",i](around:${r},${lat},${lng});node["name"~"pizza",i](around:${r},${lat},${lng}););out qt 100;`
  },
  local: {
    emoji: '🥘', label: 'Local Food', color: '#fb8c00', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["amenity"~"restaurant|fast_food"]["cuisine"~"filipino|local|native|pinoy",i](around:${r},${lat},${lng});node["name"~"carinderia|lutong|turo|kainan",i](around:${r},${lat},${lng}););out qt 100;`
  },
  fastfood: {
    emoji: '🍔', label: 'Fast Food', color: '#e6a817', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["amenity"="fast_food"](around:${r},${lat},${lng}););out qt 120;`
  },
  coffee: {
    emoji: '☕', label: 'Coffee Shop', color: '#6f4e37', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["amenity"="cafe"](around:${r},${lat},${lng});node["shop"="coffee"](around:${r},${lat},${lng}););out qt 100;`
  },
  pool: {
    emoji: '🏊', label: 'Swimming Pool', color: '#039be5', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["leisure"="swimming_pool"]["access"!="private"](around:${r},${lat},${lng});way["leisure"="swimming_pool"]["access"!="private"](around:${r},${lat},${lng}););out center qt 80;`
  },
  resort: {
    emoji: '🌴', label: 'Resort', color: '#43a047', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["tourism"="resort"](around:${r},${lat},${lng});node["name"~"resort",i](around:${r},${lat},${lng});way["tourism"="resort"](around:${r},${lat},${lng}););out center qt 80;`
  },
  beach: {
    emoji: '🏖️', label: 'Beach', color: '#ffb300', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["natural"="beach"](around:${r},${lat},${lng});way["natural"="beach"](around:${r},${lat},${lng});node["leisure"="beach_resort"](around:${r},${lat},${lng}););out center qt 80;`
  },
  park: {
    emoji: '🌳', label: 'Park', color: '#388e3c', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["leisure"="park"](around:${r},${lat},${lng});way["leisure"="park"](around:${r},${lat},${lng}););out center qt 100;`
  },
  attraction: {
    emoji: '🎡', label: 'Attraction', color: '#8e24aa', radius: 50000,
    query: (lat, lng, r) => `[out:json][timeout:25];(node["tourism"~"attraction|theme_park|museum|zoo"](around:${r},${lat},${lng});way["tourism"~"attraction|theme_park|museum"](around:${r},${lat},${lng}););out center qt 100;`
  }
};

// ─────────────────────────────────────────────
// 4. LOCATION PIN
// ─────────────────────────────────────────────

const locationIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:18px; height:18px;
    background:#4285f4;
    border:3px solid white;
    border-radius:50%;
    box-shadow:0 0 0 4px rgba(66,133,244,0.3);
  "></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  popupAnchor: [0, -12]
});

function placeLocationPin(lat, lon, label = 'You are here') {
  userLatLng = L.latLng(lat, lon);
  if (locationPin) map.removeLayer(locationPin);
  locationPin = L.marker([lat, lon], { icon: locationIcon })
    .addTo(map)
    .bindPopup(`<b>📍 ${label}</b><br>${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  map.setView([lat, lon], 13);
}

function goToMyLocation() {
  setResult('📍 Getting your location...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      placeLocationPin(pos.coords.latitude, pos.coords.longitude);
      setResult('📍 Showing your current location.');
    },
    err => setResult(`❌ Location error: ${err.message}`)
  );
}

navigator.geolocation.getCurrentPosition(pos => {
  placeLocationPin(pos.coords.latitude, pos.coords.longitude);
});

// ─────────────────────────────────────────────
// 5. PLACES FINDER — Overpass API
// ─────────────────────────────────────────────

function makePlaceIcon(emoji, color) {
  return L.divIcon({
    className: '',
    html: `<div style="
      font-size:20px;
      line-height:1;
      filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));
      cursor:pointer;
    ">${emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14]
  });
}

async function findPlaces(type) {
  if (!userLatLng) {
    setResult('❌ Location not detected yet. Click "My Location" first.');
    return;
  }

  const cfg = CATEGORIES[type];
  if (!cfg) return;

  document.querySelectorAll('.place-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`pbtn-${type}`);
  if (activeBtn) activeBtn.classList.add('active');

  clearPlaces(false);
  activeCategory = type;

  const { lat, lng } = userLatLng;
  const km = (cfg.radius / 1000).toFixed(0);
  const cacheKey = `${type}|${lat.toFixed(3)}|${lng.toFixed(3)}`;

  // ── Serve instantly from cache ──
  if (resultCache[cacheKey]) {
    renderPlaceMarkers(resultCache[cacheKey], cfg);
    const n = resultCache[cacheKey].length;
    setResult(`${cfg.emoji} <b>${n}</b> ${cfg.label}${n !== 1 ? 's' : ''} within <b>${km} km</b> <i style="color:#888">(cached — instant)</i>`);
    return;
  }

  setResult(`${cfg.emoji} Searching for ${cfg.label}s within ${km} km…`);

  try {
    const data = await overpassFetch(cfg.query(lat, lng, cfg.radius));
    let elements = data.elements;

    // Deduplicate by rounded coords
    const seen = new Set();
    elements = elements.filter(el => {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      if (!elLat || !elLon) return false;
      const key = `${elLat.toFixed(4)}|${elLon.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    resultCache[cacheKey] = elements;
    renderPlaceMarkers(elements, cfg);

    if (!elements.length) {
      setResult(`${cfg.emoji} No ${cfg.label}s found within ${km} km of your location.`);
      return;
    }
    setResult(`${cfg.emoji} Found <b>${elements.length}</b> ${cfg.label}${elements.length !== 1 ? 's' : ''} within <b>${km} km</b> — click a marker for details.`);

  } catch (err) {
    setResult(`❌ Failed to load ${cfg.label} data. Try again or check your connection.`);
    console.error(err);
  }
}

function renderPlaceMarkers(elements, cfg) {
  if (!elements.length) return;
  const icon = makePlaceIcon(cfg.emoji, cfg.color);

  elements.forEach(el => {
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (!elLat || !elLon) return;

    const name    = el.tags?.name    || cfg.label;
    const cuisine = el.tags?.cuisine ? `🍴 ${el.tags.cuisine.replace(/_/g,' ')}` : '';
    const phone   = el.tags?.phone   || el.tags?.['contact:phone'] || '';
    const hours   = el.tags?.opening_hours || '';
    const website = el.tags?.website || el.tags?.['contact:website'] || '';
    const wifi    = el.tags?.internet_access === 'wlan' ? '📶 WiFi' : '';
    const fee     = el.tags?.fee === 'yes' ? '💳 Entrance fee' : (el.tags?.fee === 'no' ? '🆓 Free entry' : '');
    const safeName = name.replace(/'/g, "\\'");

    const lines = [
      `<b>${cfg.emoji} ${name}</b>`,
      cuisine,
      phone   ? `📞 ${phone}` : '',
      hours   ? `🕐 ${hours}` : '',
      website ? `🌐 <a href="${website}" target="_blank">Website</a>` : '',
      wifi, fee,
      `<br><span style="color:#1a73e8;cursor:pointer;"
        onclick="routeToPlace(${elLat},${elLon},'${safeName}')">
        🗺️ Directions from my location
      </span>`
    ].filter(Boolean).join('<br>');

    const marker = L.marker([elLat, elLon], { icon }).addTo(map).bindPopup(lines);
    placeMarkers.push(marker);
  });

  document.getElementById('btn-clear-places').style.display = 'block';
  const allMarkers = [...placeMarkers, ...(locationPin ? [locationPin] : [])];
  if (allMarkers.length > 1) map.fitBounds(L.featureGroup(allMarkers).getBounds().pad(0.1));
}

function clearPlaces(resetBtn = true) {
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  if (resetBtn) {
    document.getElementById('btn-clear-places').style.display = 'none';
    document.querySelectorAll('.place-btn').forEach(b => b.classList.remove('active'));
    activeCategory = null;
    setResult('Pick a category from the panel (bottom-left) to explore nearby spots.');
  }
}

// ─────────────────────────────────────────────
// 6. ROUTING
// ─────────────────────────────────────────────

function toggleRouteMode() {
  routeMode = !routeMode;
  const btn = document.getElementById('btn-route-mode');

  if (routeMode) {
    btn.classList.add('active');
    routePoints = [];
    resetRoute();
    if (userLatLng) {
      routePoints.push(userLatLng);
      btn.textContent = '📍 Click destination…';
      setResult('📍 Your location is set as start. Now click your <b>destination</b> on the map.');
    } else {
      btn.textContent = '📍 Click start…';
      setResult('📍 Click on the map to set your <b>start point</b>.');
    }
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
    document.getElementById('btn-route-mode').textContent = '📍 Click destination…';
    setResult('📍 Now click your <b>destination</b> on the map.');
  } else if (routePoints.length === 2) {
    drawRoute(routePoints[0], routePoints[1]);
    routeMode = false;
    const btn = document.getElementById('btn-route-mode');
    btn.classList.remove('active');
    btn.textContent = '🗺️ Get Directions';
  }
});

function routeToPlace(lat, lon, name) {
  if (!userLatLng) { setResult('❌ Your location is not available.'); return; }
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  drawRoute(userLatLng, L.latLng(lat, lon));
  setResult(`🗺️ Getting directions to <b>${name}</b>…`);
}

function drawRoute(from, to) {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routeControl = L.Routing.control({
    waypoints: [L.latLng(from.lat, from.lng), L.latLng(to.lat, to.lng)],
    router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
    lineOptions: { styles: [{ color: '#1a73e8', weight: 5, opacity: 0.85 }] },
    show: true,
    collapsible: true,
    addWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false
  }).addTo(map);
  document.getElementById('btn-reset-route').style.display = 'inline-block';
}

function resetRoute() {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routePoints = [];
  document.getElementById('btn-reset-route').style.display = 'none';
}

// ─────────────────────────────────────────────
// 7. PLACE SEARCH (Nominatim autocomplete)
// ─────────────────────────────────────────────

function onSearchInput() {
  clearTimeout(searchTimer);
  const query = document.getElementById('search-input').value.trim();
  if (query.length < 3) { hideSuggestions(); return; }
  searchTimer = setTimeout(() => fetchSuggestions(query), 400);
}

async function fetchSuggestions(query) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`,
      { headers: { 'Accept-Language': 'en' } }
    );
    showSuggestions(await res.json());
  } catch { hideSuggestions(); }
}

function showSuggestions(results) {
  const box = document.getElementById('search-suggestions');
  if (!results.length) { hideSuggestions(); return; }
  box.innerHTML = results.map(r =>
    `<div class="suggestion-item" onclick="selectSuggestion(${r.lat},${r.lon},'${r.display_name.replace(/'/g,"\\'")}')">
      ${r.display_name}
    </div>`
  ).join('');
  box.style.display = 'block';
}

function hideSuggestions() {
  document.getElementById('search-suggestions').style.display = 'none';
}

function selectSuggestion(lat, lon, name) {
  document.getElementById('search-input').value = name.split(',')[0];
  hideSuggestions();
  flyToPlace(parseFloat(lat), parseFloat(lon), name);
}

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
    if (!results.length) { setResult(`❌ No results for "<b>${query}</b>".`); return; }
    const r = results[0];
    flyToPlace(parseFloat(r.lat), parseFloat(r.lon), r.display_name);
  } catch { setResult('❌ Search failed. Check your connection.'); }
}

function flyToPlace(lat, lon, name) {
  if (searchPin) map.removeLayer(searchPin);
  searchPin = L.marker([lat, lon])
    .addTo(map)
    .bindPopup(`<b>🔎 ${name.split(',')[0]}</b><br>${name}`)
    .openPopup();
  map.flyTo([lat, lon], 14, { duration: 1.2 });
  setResult(`🔎 Showing: <b>${name.split(',')[0]}</b>`);
}

document.addEventListener('click', e => {
  if (!e.target.closest('#search-container')) hideSuggestions();
});

// ─────────────────────────────────────────────
// 8. HELPERS
// ─────────────────────────────────────────────

function setResult(msg) {
  document.getElementById('result').innerHTML = msg;
}
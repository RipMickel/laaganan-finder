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

let allData        = null;   // raw elements from the single bulk fetch
let placeMarkers   = [];     // currently visible markers
let routeControl   = null;
let routePoints    = [];
let routeMode      = false;
let locationPin    = null;
let userLatLng     = null;
let searchPin      = null;
let searchTimer    = null;
let activeCategory = null;
let preloadDone    = false;
let preloadPromise = null;

const RADIUS = 50000; // 50 km for all categories

// ─────────────────────────────────────────────
// 3. OVERPASS — single bulk query for everything
// ─────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

async function overpassFetch(query) {
  const controllers = OVERPASS_MIRRORS.map(() => new AbortController());
  const requests = OVERPASS_MIRRORS.map((url, i) =>
    fetch(url, { method: 'POST', body: query, signal: controllers[i].signal })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        controllers.forEach((c, j) => { if (j !== i) c.abort(); });
        return json;
      })
  );
  return Promise.any(requests);
}

// One giant query that fetches ALL categories in a single round-trip
function buildBulkQuery(lat, lng) {
  const R = RADIUS;
  return `
[out:json][timeout:60];
(
  node["amenity"="restaurant"](around:${R},${lat},${lng});
  node["amenity"="fast_food"](around:${R},${lat},${lng});
  node["amenity"="cafe"](around:${R},${lat},${lng});
  node["shop"="coffee"](around:${R},${lat},${lng});
  node["natural"="beach"](around:${R},${lat},${lng});
  node["leisure"="beach_resort"](around:${R},${lat},${lng});
  node["leisure"="swimming_pool"]["access"!="private"](around:${R},${lat},${lng});
  node["tourism"="resort"](around:${R},${lat},${lng});
  node["name"~"resort",i](around:${R},${lat},${lng});
  node["leisure"="park"](around:${R},${lat},${lng});
  node["tourism"~"attraction|theme_park|museum|zoo"](around:${R},${lat},${lng});
  way["natural"="beach"](around:${R},${lat},${lng});
  way["leisure"="swimming_pool"]["access"!="private"](around:${R},${lat},${lng});
  way["tourism"="resort"](around:${R},${lat},${lng});
  way["leisure"="park"](around:${R},${lat},${lng});
  way["tourism"~"attraction|theme_park|museum"](around:${R},${lat},${lng});
);
out center qt;
`.trim();
}

// ─────────────────────────────────────────────
// 4. CATEGORY DEFINITIONS (client-side classify)
// ─────────────────────────────────────────────

const CATEGORIES = {
  restaurant: {
    emoji: '🍽️', label: 'Restaurant', color: '#e53935',
    match: t => t.amenity === 'restaurant'
  },
  pizza: {
    emoji: '🍕', label: 'Pizza', color: '#f4511e',
    match: t => (t.amenity === 'restaurant' || t.amenity === 'fast_food') &&
                /pizza/i.test(t.cuisine || t.name || '')
  },
  local: {
    emoji: '🥘', label: 'Local Food', color: '#fb8c00',
    match: t => /filipino|local|native|pinoy|carinderia|lutong|turo|kainan/i
                .test((t.cuisine || '') + ' ' + (t.name || ''))
  },
  fastfood: {
    emoji: '🍔', label: 'Fast Food', color: '#e6a817',
    match: t => t.amenity === 'fast_food'
  },
  coffee: {
    emoji: '☕', label: 'Coffee Shop', color: '#6f4e37',
    match: t => t.amenity === 'cafe' || t.shop === 'coffee'
  },
  pool: {
    emoji: '🏊', label: 'Swimming Pool', color: '#039be5',
    match: t => t.leisure === 'swimming_pool'
  },
  resort: {
    emoji: '🌴', label: 'Resort', color: '#43a047',
    match: t => t.tourism === 'resort' || /resort/i.test(t.name || '')
  },
  beach: {
    emoji: '🏖️', label: 'Beach', color: '#ffb300',
    match: t => t.natural === 'beach' || t.leisure === 'beach_resort'
  },
  park: {
    emoji: '🌳', label: 'Park', color: '#388e3c',
    match: t => t.leisure === 'park'
  },
  attraction: {
    emoji: '🎡', label: 'Attraction', color: '#8e24aa',
    match: t => /^(attraction|theme_park|museum|zoo)$/.test(t.tourism || '')
  }
};

// Pre-classified per category: { restaurant: [...], pizza: [...], ... }
const classified = {};

function classifyAll(elements) {
  // Reset
  Object.keys(CATEGORIES).forEach(k => { classified[k] = []; });

  const seen = new Set();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!lat || !lon) continue;
    const key = `${lat.toFixed(4)}|${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const t = el.tags || {};
    // An element can match multiple categories (e.g. pizza + restaurant)
    for (const [type, cfg] of Object.entries(CATEGORIES)) {
      if (cfg.match(t)) classified[type].push({ ...el, _lat: lat, _lon: lon });
    }
  }
}

// ─────────────────────────────────────────────
// 5. PRELOAD — fires as soon as location is known
// ─────────────────────────────────────────────

async function preloadAllCategories(lat, lng) {
  if (preloadDone) return;
  preloadDone = true;

  const animTimer = startLoadingAnimation();
  setResult('⏳ Loading all categories in background… this takes one request for everything.');

  try {
    const query = buildBulkQuery(lat, lng);
    const data  = await overpassFetch(query);
    clearInterval(animTimer);
    allData = data.elements;
    classifyAll(allData);

    updateLoadingBar(100);
    const total = Object.values(classified).reduce((s, a) => s + a.length, 0);
    setResult(`✅ All categories loaded! <b>${total}</b> places within 50 km — pick a category below.`);

    // Update panel badges
    Object.entries(CATEGORIES).forEach(([type, cfg]) => {
      const btn = document.getElementById(`pbtn-${type}`);
      if (!btn) return;
      const count = classified[type].length;
      btn.innerHTML = `${cfg.emoji} ${cfg.label} <span style="
        margin-left:auto;
        background:${cfg.color};
        color:white;
        border-radius:10px;
        padding:1px 7px;
        font-size:11px;
        font-weight:bold;
      ">${count}</span>`;
    });

    // Auto-show last active category or first one
    if (activeCategory && classified[activeCategory]) {
      showCategory(activeCategory);
    }

  } catch (err) {
    clearInterval(animTimer);
    updateLoadingBar(-1);
    setResult('❌ Failed to preload places. Click a category to try individually.');
    preloadDone = false; // allow retry
    console.error(err);
  }
}

function updateLoadingBar(pct) {
  const bar = document.getElementById('loading-bar');
  if (!bar) return;
  if (pct < 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const fill = bar.querySelector('.bar-fill');
  fill.style.width = pct + '%';
  if (pct >= 100) setTimeout(() => { bar.style.display = 'none'; }, 600);
}

// Animate bar from 0→85% while waiting, then jump to 100 when done
function startLoadingAnimation() {
  updateLoadingBar(5);
  let pct = 5;
  const iv = setInterval(() => {
    // Slow down as it approaches 85 to fake indeterminate progress
    pct += (85 - pct) * 0.06;
    updateLoadingBar(Math.min(pct, 85));
  }, 300);
  return iv;
}

// ─────────────────────────────────────────────
// 6. LOCATION PIN
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
  // Kick off background preload as soon as we have coords
  preloadAllCategories(lat, lon);
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

navigator.geolocation.getCurrentPosition(
  pos => placeLocationPin(pos.coords.latitude, pos.coords.longitude),
  ()  => setResult('⚠️ Location access denied. Click "My Location" to try again.')
);

// ─────────────────────────────────────────────
// 7. SHOW CATEGORY (instant from cache)
// ─────────────────────────────────────────────

function findPlaces(type) {
  document.querySelectorAll('.place-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`pbtn-${type}`);
  if (btn) btn.classList.add('active');
  activeCategory = type;

  if (!preloadDone || !classified[type]) {
    // Data not ready yet — queue it
    if (!userLatLng) {
      setResult('❌ Location not detected yet. Click "My Location" first.');
      return;
    }
    setResult(`⏳ Still loading… please wait a moment.`);
    // Retry after preload finishes
    const poll = setInterval(() => {
      if (preloadDone && classified[type]) {
        clearInterval(poll);
        showCategory(type);
      }
    }, 300);
    return;
  }

  showCategory(type);
}

function showCategory(type) {
  const cfg      = CATEGORIES[type];
  const elements = classified[type] || [];

  clearPlaces(false);

  if (!elements.length) {
    setResult(`${cfg.emoji} No ${cfg.label}s found within 50 km.`);
    return;
  }

  const icon = makePlaceIcon(cfg.emoji);

  elements.forEach(el => {
    const t       = el.tags || {};
    const name    = t.name    || cfg.label;
    const cuisine = t.cuisine ? `🍴 ${t.cuisine.replace(/_/g,' ')}` : '';
    const phone   = t.phone   || t['contact:phone'] || '';
    const hours   = t.opening_hours || '';
    const website = t.website || t['contact:website'] || '';
    const wifi    = t.internet_access === 'wlan' ? '📶 WiFi' : '';
    const fee     = t.fee === 'yes' ? '💳 Entrance fee' : t.fee === 'no' ? '🆓 Free' : '';
    const safe    = name.replace(/'/g, "\\'");

    const popup = [
      `<b>${cfg.emoji} ${name}</b>`,
      cuisine, phone ? `📞 ${phone}` : '',
      hours   ? `🕐 ${hours}` : '',
      website ? `🌐 <a href="${website}" target="_blank">Website</a>` : '',
      wifi, fee,
      `<br><span style="color:#1a73e8;cursor:pointer;"
        onclick="routeToPlace(${el._lat},${el._lon},'${safe}')">
        🗺️ Directions from my location</span>`
    ].filter(Boolean).join('<br>');

    const marker = L.marker([el._lat, el._lon], { icon })
      .addTo(map)
      .bindPopup(popup);
    placeMarkers.push(marker);
  });

  document.getElementById('btn-clear-places').style.display = 'block';

  const all = [...placeMarkers, ...(locationPin ? [locationPin] : [])];
  if (all.length > 1) map.fitBounds(L.featureGroup(all).getBounds().pad(0.1));

  setResult(`${cfg.emoji} Showing <b>${elements.length}</b> ${cfg.label}${elements.length !== 1 ? 's' : ''} within <b>50 km</b> — click a marker for details.`);
}

function makePlaceIcon(emoji) {
  return L.divIcon({
    className: '',
    html: `<div style="font-size:20px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));cursor:pointer;">${emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14]
  });
}

function clearPlaces(resetBtn = true) {
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  if (resetBtn) {
    document.getElementById('btn-clear-places').style.display = 'none';
    document.querySelectorAll('.place-btn').forEach(b => b.classList.remove('active'));
    activeCategory = null;
    setResult('Pick a category from the panel to explore nearby spots.');
  }
}

// ─────────────────────────────────────────────
// 8. ROUTING
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
      setResult('📍 Your location is set as start. Now click your <b>destination</b>.');
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

map.on('click', e => {
  if (!routeMode) return;
  routePoints.push(e.latlng);
  if (routePoints.length === 1) {
    document.getElementById('btn-route-mode').textContent = '📍 Click destination…';
    setResult('📍 Now click your <b>destination</b>.');
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
  drawRoute(userLatLng, L.latLng(lat, lon));
  setResult(`🗺️ Getting directions to <b>${name}</b>…`);
}

function drawRoute(from, to) {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routeControl = L.Routing.control({
    waypoints: [L.latLng(from.lat, from.lng), L.latLng(to.lat, to.lng)],
    router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
    lineOptions: { styles: [{ color: '#1a73e8', weight: 5, opacity: 0.85 }] },
    show: true, collapsible: true, addWaypoints: false,
    fitSelectedRoutes: true, showAlternatives: false
  }).addTo(map);
  document.getElementById('btn-reset-route').style.display = 'inline-block';
}

function resetRoute() {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routePoints = [];
  document.getElementById('btn-reset-route').style.display = 'none';
}

// ─────────────────────────────────────────────
// 9. PLACE SEARCH (Nominatim autocomplete)
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
    flyToPlace(parseFloat(results[0].lat), parseFloat(results[0].lon), results[0].display_name);
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
// 10. HELPERS
// ─────────────────────────────────────────────

function setResult(msg) {
  document.getElementById('result').innerHTML = msg;
}
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
  zoom: 11,
  layers: [osmLayer],
  zoomControl: false,
  attributionControl: false
});

L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

// ─────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────

let allData        = null;
let placeMarkers   = [];
let routeControl   = null;
let routePoints    = [];
let routeMode      = false;
let locationPin    = null;
let userLatLng     = null;
let searchPin      = null;
let searchTimer    = null;
let activeCategory = null;
let preloadDone    = false;
let isSatellite    = false;

const RADIUS = 50000; // 50 km

// ─────────────────────────────────────────────
// 3. SATELLITE TOGGLE
// ─────────────────────────────────────────────

function toggleSatellite() {
  isSatellite = !isSatellite;
  const btn = document.getElementById('btn-satellite');
  if (isSatellite) {
    map.removeLayer(osmLayer);
    map.addLayer(satelliteLayer);
    btn.classList.add('active');
    btn.title = 'Switch to Street Map';
  } else {
    map.removeLayer(satelliteLayer);
    map.addLayer(osmLayer);
    btn.classList.remove('active');
    btn.title = 'Switch to Satellite View';
  }
}

// ─────────────────────────────────────────────
// 4. OVERPASS — single bulk query
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
// 5. CATEGORIES & CLASSIFIER
// ─────────────────────────────────────────────

const CATEGORIES = {
  restaurant: { emoji: '🍽️', label: 'Restaurants', color: '#FF3B30',
    match: t => t.amenity === 'restaurant' },
  pizza:      { emoji: '🍕', label: 'Pizza',        color: '#FF6B35',
    match: t => /pizza/i.test((t.cuisine||'')+(t.name||'')) },
  local:      { emoji: '🥘', label: 'Local Food',   color: '#FF9500',
    match: t => /filipino|local|native|pinoy|carinderia|lutong|turo|kainan/i.test((t.cuisine||'')+(t.name||'')) },
  fastfood:   { emoji: '🍔', label: 'Fast Food',    color: '#FFCC00',
    match: t => t.amenity === 'fast_food' },
  coffee:     { emoji: '☕', label: 'Coffee',        color: '#A2845E',
    match: t => t.amenity === 'cafe' || t.shop === 'coffee' },
  pool:       { emoji: '🏊', label: 'Pools',         color: '#32ADE6',
    match: t => t.leisure === 'swimming_pool' },
  resort:     { emoji: '🌴', label: 'Resorts',       color: '#34C759',
    match: t => t.tourism === 'resort' || /resort/i.test(t.name||'') },
  beach:      { emoji: '🏖️', label: 'Beaches',      color: '#FFD60A',
    match: t => t.natural === 'beach' || t.leisure === 'beach_resort' },
  park:       { emoji: '🌳', label: 'Parks',         color: '#30D158',
    match: t => t.leisure === 'park' },
  attraction: { emoji: '🎡', label: 'Attractions',   color: '#BF5AF2',
    match: t => /^(attraction|theme_park|museum|zoo)$/.test(t.tourism||'') }
};

const classified = {};

function classifyAll(elements) {
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
    for (const [type, cfg] of Object.entries(CATEGORIES)) {
      if (cfg.match(t)) classified[type].push({ ...el, _lat: lat, _lon: lon });
    }
  }
}

// ─────────────────────────────────────────────
// 6. LOADING BAR
// ─────────────────────────────────────────────

let _barTimer = null;
function startLoadingAnimation() {
  const bar = document.getElementById('loading-bar');
  bar.style.display = 'block';
  let pct = 5;
  bar.querySelector('.bar-fill').style.width = pct + '%';
  _barTimer = setInterval(() => {
    pct += (85 - pct) * 0.07;
    bar.querySelector('.bar-fill').style.width = Math.min(pct, 85) + '%';
  }, 300);
}
function finishLoadingBar() {
  clearInterval(_barTimer);
  const bar = document.getElementById('loading-bar');
  bar.querySelector('.bar-fill').style.width = '100%';
  setTimeout(() => { bar.style.display = 'none'; bar.querySelector('.bar-fill').style.width = '0%'; }, 600);
}
function failLoadingBar() {
  clearInterval(_barTimer);
  document.getElementById('loading-bar').style.display = 'none';
}

// ─────────────────────────────────────────────
// 7. PRELOAD
// ─────────────────────────────────────────────

async function preloadAllCategories(lat, lng) {
  if (preloadDone) return;
  preloadDone = true;

  startLoadingAnimation();
  setResult('⏳ Discovering places near you…');

  try {
    const data = await overpassFetch(buildBulkQuery(lat, lng));
    finishLoadingBar();
    allData = data.elements;
    classifyAll(allData);

    const total = Object.values(classified).reduce((s, a) => s + a.length, 0);
    setResult(`✅ Found <b>${total}</b> places within 50 km — tap a category above!`);
    updateSheetSubtitle(`${total} places within 50 km`);

    // Update pill badges
    Object.entries(CATEGORIES).forEach(([type, cfg]) => {
      const btn = document.getElementById(`pbtn-${type}`);
      if (!btn) return;
      const count = classified[type].length;
      btn.innerHTML = `${cfg.emoji} ${cfg.label} <span class="pill-badge">${count}</span>`;
    });

    if (activeCategory) showCategory(activeCategory);

  } catch (err) {
    failLoadingBar();
    setResult('❌ Couldn\'t load places. Check your connection and try again.');
    preloadDone = false;
    console.error(err);
  }
}

// ─────────────────────────────────────────────
// 8. LOCATION PIN
// ─────────────────────────────────────────────

const locationIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:20px;height:20px;
    background:#007AFF;
    border:3px solid white;
    border-radius:50%;
    box-shadow:0 0 0 5px rgba(0,122,255,0.25), 0 2px 8px rgba(0,0,0,0.3);
  "></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
  popupAnchor: [0, -14]
});

function placeLocationPin(lat, lon) {
  userLatLng = L.latLng(lat, lon);
  if (locationPin) map.removeLayer(locationPin);
  locationPin = L.marker([lat, lon], { icon: locationIcon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(`<b>📍 You are here</b><br><span style="color:#666;font-size:12px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>`);
  map.setView([lat, lon], 13, { animate: true });
  preloadAllCategories(lat, lon);
}

function goToMyLocation() {
  setResult('📍 Finding your location…');
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
  ()  => setResult('⚠️ Location denied. Tap 📍 to try again.')
);

// ─────────────────────────────────────────────
// 9. SHOW CATEGORY (instant)
// ─────────────────────────────────────────────

function findPlaces(type) {
  document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
  const pill = document.getElementById(`pbtn-${type}`);
  if (pill) {
    pill.classList.add('active');
    pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  activeCategory = type;

  if (!preloadDone || !classified[type]) {
    if (!userLatLng) { setResult('❌ Location not available. Tap 📍 first.'); return; }
    setResult('⏳ Still loading… almost there!');
    const poll = setInterval(() => {
      if (preloadDone && classified[type]) { clearInterval(poll); showCategory(type); }
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
    setResult(`${cfg.emoji} No ${cfg.label} found within 50 km.`);
    expandSheet();
    return;
  }

  const icon = makeIcon(cfg.emoji);
  elements.forEach(el => {
    const t       = el.tags || {};
    const name    = t.name    || cfg.label;
    const cuisine = t.cuisine ? `🍴 ${t.cuisine.replace(/_/g,' ')}` : '';
    const phone   = t.phone   || t['contact:phone'] || '';
    const hours   = t.opening_hours || '';
    const website = t.website || t['contact:website'] || '';
    const wifi    = t.internet_access === 'wlan' ? '📶 WiFi' : '';
    const fee     = t.fee === 'yes' ? '💳 Fee' : t.fee === 'no' ? '🆓 Free' : '';
    const safe    = name.replace(/'/g, "\\'");

    const popup = [
      `<div style="font-weight:700;font-size:15px;margin-bottom:4px">${cfg.emoji} ${name}</div>`,
      cuisine ? `<div style="color:#888;margin-bottom:2px">${cuisine}</div>` : '',
      phone   ? `<div>📞 <a href="tel:${phone}">${phone}</a></div>` : '',
      hours   ? `<div>🕐 ${hours}</div>` : '',
      website ? `<div>🌐 <a href="${website}" target="_blank">Visit website</a></div>` : '',
      (wifi || fee) ? `<div style="margin-top:4px">${[wifi,fee].filter(Boolean).join(' · ')}</div>` : '',
      `<button onclick="routeToPlace(${el._lat},${el._lon},'${safe}')" style="
        margin-top:10px;width:100%;padding:10px;
        background:#007AFF;color:white;border:none;
        border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;">
        🗺️ Get Directions
      </button>`
    ].filter(Boolean).join('');

    const marker = L.marker([el._lat, el._lon], { icon }).addTo(map).bindPopup(popup, { maxWidth: 260 });
    placeMarkers.push(marker);
  });

  document.getElementById('btn-clear-places').style.display = 'flex';

  const all = [...placeMarkers, ...(locationPin ? [locationPin] : [])];
  if (all.length > 1) map.fitBounds(L.featureGroup(all).getBounds().pad(0.12));

  setResult(`${cfg.emoji} <b>${elements.length} ${cfg.label}</b> within 50 km`);
  updateSheetSubtitle(`${elements.length} ${cfg.label} nearby · tap a pin for details`);
  expandSheet();
}

function makeIcon(emoji) {
  return L.divIcon({
    className: '',
    html: `<div style="font-size:22px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.4));cursor:pointer;">${emoji}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -16]
  });
}

function clearPlaces(full = true) {
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  document.getElementById('btn-clear-places').style.display = 'none';
  if (full) {
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
    activeCategory = null;
    setResult('Tap a category above to explore nearby spots.');
    updateSheetSubtitle('Tap a category above to discover places');
    collapseSheet();
  }
}

// ─────────────────────────────────────────────
// 10. ROUTING
// ─────────────────────────────────────────────

function toggleRouteMode() {
  routeMode = !routeMode;
  const fab = document.getElementById('fab-directions');
  const btn = document.getElementById('btn-directions');

  if (routeMode) {
    fab.classList.add('active');
    fab.textContent = '📍';
    routePoints = [];
    resetRoute();
    if (userLatLng) {
      routePoints.push(userLatLng);
      setResult('📍 Location set as start. Now tap your <b>destination</b> on the map.');
      btn.textContent = '📍 Tap destination…';
    } else {
      setResult('📍 Tap the map to set your <b>start point</b>.');
      btn.textContent = '📍 Tap start…';
    }
    expandSheet();
  } else {
    fab.classList.remove('active');
    fab.textContent = '🗺️';
    btn.textContent = '🗺️ Directions';
    setResult('Directions mode off.');
  }
}

map.on('click', e => {
  if (!routeMode) return;
  routePoints.push(e.latlng);
  if (routePoints.length === 1) {
    setResult('📍 Now tap your <b>destination</b> on the map.');
    document.getElementById('btn-directions').textContent = '📍 Tap destination…';
  } else if (routePoints.length === 2) {
    drawRoute(routePoints[0], routePoints[1]);
    routeMode = false;
    document.getElementById('fab-directions').classList.remove('active');
    document.getElementById('fab-directions').textContent = '🗺️';
    document.getElementById('btn-directions').textContent = '🗺️ Directions';
  }
});

function routeToPlace(lat, lon, name) {
  if (!userLatLng) { setResult('❌ Location unavailable.'); return; }
  map.closePopup();
  drawRoute(userLatLng, L.latLng(lat, lon));
  setResult(`🗺️ Directions to <b>${name}</b>`);
}

function drawRoute(from, to) {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routeControl = L.Routing.control({
    waypoints: [L.latLng(from.lat, from.lng), L.latLng(to.lat, to.lng)],
    router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
    lineOptions: { styles: [{ color: '#007AFF', weight: 5, opacity: 0.9 }] },
    show: true, collapsible: true, addWaypoints: false,
    fitSelectedRoutes: true, showAlternatives: false
  }).addTo(map);
  document.getElementById('fab-clear-route').style.display = 'flex';
}

function resetRoute() {
  if (routeControl) { map.removeControl(routeControl); routeControl = null; }
  routePoints = [];
  document.getElementById('fab-clear-route').style.display = 'none';
}

// ─────────────────────────────────────────────
// 11. SEARCH (Nominatim)
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
    `<div class="suggestion-item" ontouchend="selectSuggestion(${r.lat},${r.lon},'${r.display_name.replace(/'/g,"\\'")}')">
      <span class="suggestion-icon">📍</span>
      <span>${r.display_name}</span>
    </div>`
  ).join('');
  box.style.display = 'block';
}

function hideSuggestions() {
  document.getElementById('search-suggestions').style.display = 'none';
}

function selectSuggestion(lat, lon, name) {
  document.getElementById('search-input').value = name.split(',')[0];
  document.getElementById('search-clear').style.display = 'flex';
  hideSuggestions();
  flyToPlace(parseFloat(lat), parseFloat(lon), name);
}

async function searchPlace() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  hideSuggestions();
  setResult('🔎 Searching…');
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const results = await res.json();
    if (!results.length) { setResult(`❌ No results for "<b>${query}</b>".`); return; }
    flyToPlace(parseFloat(results[0].lat), parseFloat(results[0].lon), results[0].display_name);
  } catch { setResult('❌ Search failed.'); }
}

function flyToPlace(lat, lon, name) {
  if (searchPin) map.removeLayer(searchPin);
  searchPin = L.marker([lat, lon])
    .addTo(map)
    .bindPopup(`<b>🔎 ${name.split(',')[0]}</b>`)
    .openPopup();
  map.flyTo([lat, lon], 14, { animate: true, duration: 1 });
  setResult(`🔎 <b>${name.split(',')[0]}</b>`);
  collapseSheet();
}

document.addEventListener('touchend', e => {
  if (!e.target.closest('#search-wrap')) hideSuggestions();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#search-wrap')) hideSuggestions();
});

// ─────────────────────────────────────────────
// 12. UI HELPERS
// ─────────────────────────────────────────────

function setResult(msg) {
  document.getElementById('result-toast').innerHTML = msg;
}

function updateSheetSubtitle(msg) {
  document.getElementById('sheet-subtitle').textContent = msg;
}

function expandSheet()  { window.sheetExpanded = true;  document.getElementById('bottom-sheet').classList.remove('collapsed'); }
function collapseSheet(){ window.sheetExpanded = false; document.getElementById('bottom-sheet').classList.add('collapsed'); }
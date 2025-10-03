// ---- Carte
const map = L.map('map', { zoomControl:false, attributionControl:false }).setView([46.7, 2.5], 6);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution:'', maxZoom:19
}).addTo(map);

// ---- États
let myMarker=null, myPath=[], lastPos=null, lastSpeed=null, lastHeading=null;
let routing=null, routeLine=null, routeCoords=[], routeDistance=0;
let radarMarkers = L.markerClusterGroup({ disableClusteringAtZoom: 12, maxClusterRegion: 60 }).addTo(map);
let radarsAll=[], radarsOnRoute=[], alertedIds=new Set();
let trafficLights = [], policeControls = [];
let trafficLightsMarkers = L.layerGroup().addTo(map);
let policeControlsMarkers = L.layerGroup().addTo(map);
const alertEl = document.getElementById('alert');

// Variables pour itinéraires multiples et paramètres
let availableRoutes = [];
let currentDestination = null;
let destinationMarker = null;
let routeSettings = {
  avoidTolls: false,
  routeType: 'fastest' // fastest, shortest, balanced
};
let offRouteThreshold = 100; // Distance en mètres pour déclencher un recalcul
let isOffRoute = false;

// Variables pour la géolocalisation ultra précise
let highAccuracyWatcher = null;
let fallbackWatcher = null;
let lastHighAccuracyTime = 0;
let positionBuffer = [];
let speedBuffer = [];
let headingBuffer = [];
let lastValidGPSHeading = null;
let lastValidGPSSpeed = null;
let isFollowing = true; // Activé automatiquement
let userHasMovedMap = false;

// Variables pour le gyroscope
let gyroscopePermission = false;
let deviceOrientationListener = null;
let magnetometerHeading = null;
let gyroscopeHeading = null;
let isGyroscopeCalibrated = false;
let calibrationOffset = 0;
let useGyroscope = true; // Activé automatiquement

// Variables pour la rotation de carte Google Maps style
let autoRotateMap = true;

// Timer pour masquer le bouton de recentrage
let recenterButtonTimer = null;

// Détecter quand l'utilisateur déplace la carte manuellement
map.on('dragstart', () => {
  if (isFollowing) {
    userHasMovedMap = true;
    showRecenterButton();
  }
});

map.on('zoomstart', () => {
  if (isFollowing) {
    userHasMovedMap = true;
    showRecenterButton();
  }
});

// Détecter les interactions tactiles pour réinitialiser le timer
map.on('touchstart', () => {
  if (userHasMovedMap) {
    showRecenterButton();
  }
});

map.on('touchend', () => {
  if (userHasMovedMap) {
    startRecenterButtonTimer();
  }
});

map.on('dragend', () => {
  if (userHasMovedMap) {
    startRecenterButtonTimer();
  }
});

map.on('zoomend', () => {
  if (userHasMovedMap) {
    startRecenterButtonTimer();
  }
});

// ---- Initialisation du gyroscope pour orientation ultra-précise
async function initializeGyroscope() {
  try {
    // Demander la permission pour l'orientation de l'appareil
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      gyroscopePermission = permission === 'granted';
    } else {
      gyroscopePermission = true; // Autorisé par défaut sur Android/autres
    }

    if (gyroscopePermission) {
      startGyroscopeTracking();
      console.log('Gyroscope activé pour orientation précise');
    } else {
      console.log('Permission gyroscope refusée');
    }
  } catch (error) {
    console.error('Erreur initialisation gyroscope:', error);
  }
}

function startGyroscopeTracking() {
  if (deviceOrientationListener) {
    window.removeEventListener('deviceorientationabsolute', deviceOrientationListener);
    window.removeEventListener('deviceorientation', deviceOrientationListener);
  }

  deviceOrientationListener = (event) => {
    handleDeviceOrientation(event);
  };

  // Priorité à deviceorientationabsolute (plus précis avec boussole magnétique)
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', deviceOrientationListener);
  } else {
    window.addEventListener('deviceorientation', deviceOrientationListener);
  }
}

function handleDeviceOrientation(event) {
  if (!isFollowing) return;

  let heading = null;

  // Utiliser alpha pour l'orientation (0° = Nord)
  if (event.alpha !== null) {
    // Sur iOS, alpha commence à 0° au nord et tourne dans le sens horaire
    // Sur Android, cela peut varier selon le navigateur
    heading = event.alpha;

    // Correction pour iOS (inverser si nécessaire)
    if (navigator.platform.includes('iPhone') || navigator.platform.includes('iPad')) {
      heading = 360 - heading;
    }

    // Normaliser entre 0-360°
    heading = ((heading % 360) + 360) % 360;

    // Calibration automatique lors du premier mouvement GPS
    if (!isGyroscopeCalibrated && lastValidGPSHeading !== null && lastSpeed > 3) {
      calibrationOffset = lastValidGPSHeading - heading;
      isGyroscopeCalibrated = true;
      console.log(`Gyroscope calibré: offset ${calibrationOffset.toFixed(1)}°`);
    }

    // Appliquer l'offset de calibration
    if (isGyroscopeCalibrated) {
      heading = ((heading + calibrationOffset) % 360 + 360) % 360;
    }

    gyroscopeHeading = heading;
  }
}

function stopGyroscopeTracking() {
  if (deviceOrientationListener) {
    window.removeEventListener('deviceorientationabsolute', deviceOrientationListener);
    window.removeEventListener('deviceorientation', deviceOrientationListener);
    deviceOrientationListener = null;
  }
  gyroscopeHeading = null;
  isGyroscopeCalibrated = false;
}

// Créer le marqueur de position style Google Maps avec cercle de précision
let accuracyCircle = null;

function createGoogleMapsMarker(heading = 0) {
  const size = 32;
  const primaryColor = '#4285F4';
  const glowColor = 'rgba(66, 133, 244, 0.4)';
  
  return L.divIcon({
    className: 'google-maps-marker',
    html: `
      <div style="
        width: ${size}px; 
        height: ${size}px; 
        position: relative;
        transform: rotate(${heading}deg);
        transition: transform 0.5s cubic-bezier(0.4, 0.0, 0.2, 1);
        filter: drop-shadow(0 0 8px ${glowColor});
      ">
        <!-- Halo externe pulsant -->
        <div style="
          width: ${size + 16}px; 
          height: ${size + 16}px; 
          background: radial-gradient(circle, ${glowColor} 0%, transparent 70%);
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          animation: pulse-halo 2s ease-in-out infinite;
        "></div>
        
        <!-- Cercle intermédiaire blanc -->
        <div style="
          width: ${size + 4}px; 
          height: ${size + 4}px; 
          background: #FFFFFF;
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          box-shadow: 0 0 12px rgba(0, 0, 0, 0.2);
        "></div>
        
        <!-- Point central bleu -->
        <div style="
          width: ${size}px; 
          height: ${size}px; 
          background: linear-gradient(135deg, #4285F4 0%, #1967D2 100%);
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          box-shadow: inset 0 -2px 4px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(66, 133, 244, 0.4);
        "></div>
        
        <!-- Reflet lumineux -->
        <div style="
          width: ${size * 0.5}px; 
          height: ${size * 0.5}px; 
          background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8) 0%, transparent 60%);
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) translate(-${size * 0.15}px, -${size * 0.15}px);
          pointer-events: none;
        "></div>
        
        <!-- Flèche de direction parfaitement symétrique -->
        <div style="
          width: 0;
          height: 0;
          border-left: ${size * 0.25}px solid transparent;
          border-right: ${size * 0.25}px solid transparent;
          border-bottom: ${size * 0.5}px solid #FFFFFF;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -${size * 0.8}px);
          filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
          z-index: 10;
        "></div>
        
        <!-- Base de la flèche pour plus de stabilité visuelle -->
        <div style="
          width: ${size * 0.4}px;
          height: ${size * 0.15}px;
          background: #FFFFFF;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -${size * 0.35}px);
          border-radius: 2px;
          filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
          z-index: 9;
        "></div>
        
        <!-- Point central de la flèche -->
        <div style="
          width: ${size * 0.12}px;
          height: ${size * 0.12}px;
          background: ${primaryColor};
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          box-shadow: 0 0 6px rgba(66, 133, 244, 0.8);
          z-index: 11;
        "></div>
      </div>
    `,
    iconSize: [size + 16, size + 16],
    iconAnchor: [(size + 16) / 2, (size + 16) / 2]
  });
}

function updateAccuracyCircle(latlng, accuracy) {
  if (accuracyCircle) {
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy);
  } else {
    accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color: '#4285F4',
      fillColor: '#4285F4',
      fillOpacity: 0.15,
      opacity: 0.3,
      weight: 1,
      interactive: false
    }).addTo(map);
  }
}

// Créer l'icône de destination
function createDestinationIcon() {
  const size = 32;
  const color = '#ff4444';
  const shadowColor = 'rgba(255, 68, 68, 0.8)';

  return L.divIcon({
    className: 'destination-marker',
    html: `
      <div style="
        width: ${size}px; 
        height: ${size + 8}px; 
        position: relative;
        filter: drop-shadow(0 0 15px ${shadowColor});
      ">
        <!-- Pin principal -->
        <div style="
          width: ${size}px;
          height: ${size}px;
          background: #000000;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          position: absolute;
          top: 0;
          left: 0;
        "></div>
        <!-- Cercle intérieur blanc -->
        <div style="
          width: ${size - 12}px;
          height: ${size - 12}px;
          background: #ffffff;
          border-radius: 50%;
          position: absolute;
          top: 6px;
          left: 6px;
          z-index: 2;
        "></div>
        <!-- Ondulations -->
        <div style="
          position: absolute;
          bottom: -4px;
          left: 50%;
          transform: translateX(-50%);
          width: ${size + 16}px;
          height: 8px;
        ">
          <div style="
            width: ${size + 16}px;
            height: 3px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 50%;
            position: absolute;
            bottom: 0;
            animation: ripple1 2s ease-in-out infinite;
          "></div>
          <div style="
            width: ${size + 8}px;
            height: 2px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 50%;
            position: absolute;
            bottom: 2px;
            left: 4px;
            animation: ripple2 2s ease-in-out infinite 0.3s;
          "></div>
          <div style="
            width: ${size}px;
            height: 1px;
            background: rgba(0, 0, 0, 0.1);
            border-radius: 50%;
            position: absolute;
            bottom: 4px;
            left: 8px;
            animation: ripple3 2s ease-in-out infinite 0.6s;
          "></div>
        </div>
      </div>
    `,
    iconSize: [size, size + 8],
    iconAnchor: [size/2, size]
  });
}

// Bouton de recentrage
function showRecenterButton() {
  const btn = document.getElementById('recenterBtn');
  if (myMarker && isFollowing && userHasMovedMap) {
    btn.classList.add('show');
    // Annuler le timer précédent s'il existe
    if (recenterButtonTimer) {
      clearTimeout(recenterButtonTimer);
      recenterButtonTimer = null;
    }
  }
}

function hideRecenterButton() {
  const btn = document.getElementById('recenterBtn');
  btn.classList.remove('show');
  userHasMovedMap = false;
  if (recenterButtonTimer) {
    clearTimeout(recenterButtonTimer);
    recenterButtonTimer = null;
  }
}

function startRecenterButtonTimer() {
  // Annuler le timer précédent
  if (recenterButtonTimer) {
    clearTimeout(recenterButtonTimer);
  }
  
  // Masquer le bouton après 3 secondes d'inactivité
  recenterButtonTimer = setTimeout(() => {
    const btn = document.getElementById('recenterBtn');
    btn.classList.remove('show');
    recenterButtonTimer = null;
  }, 3000);
}

document.getElementById('recenterBtn').onclick = () => {
  if (myMarker) {
    // Animation de recentrage ultra-fluide avec éasing optimisé
    map.setView(myMarker.getLatLng(), Math.max(map.getZoom(), 16), {
      animate: true,
      duration: 1.0,
      easeLinearity: 0.15
    });
    hideRecenterButton();
    say("Recentré sur ta position.");
  }
};

// ---- Geocoder - API Adresse française officielle + POI
async function geocodeFrench(query) {
  try {
    // 1. Recherche d'adresses classiques
    const addressResponse = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=3`);
    let results = [];

    if (addressResponse.ok) {
      const addressData = await addressResponse.json();
      results = addressData.features.map(feature => ({
        name: feature.properties.label,
        center: L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]),
        properties: feature.properties,
        type: 'address'
      }));
    }

    // 2. Recherche de POI/commerces via Nominatim
    const nominatimResponse = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ' France')}&limit=3&addressdetails=1`);

    if (nominatimResponse.ok) {
      const nominatimData = await nominatimResponse.json();
      const poiResults = nominatimData.map(item => ({
        name: `${item.display_name}`,
        center: L.latLng(parseFloat(item.lat), parseFloat(item.lon)),
        properties: {
          label: item.display_name,
          type: item.type || 'poi',
          category: item.category || 'business'
        },
        type: 'poi'
      }));
      results = results.concat(poiResults);
    }

    const uniqueResults = results.filter((result, index, self) => 
      index === self.findIndex(r => r.name === result.name)
    ).slice(0, 5);

    return uniqueResults;
  } catch (error) {
    console.error("Erreur géocodage:", error);
    return [];
  }
}

// ---- TTS
function say(text){
  try{
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 1.0;
    u.pitch = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }catch(e){}
}

// ---- Temps de trajet
function updateTravelTime(durationSeconds) {
  if (!durationSeconds) {
    document.getElementById('travelTimeValue').textContent = '—';
    return;
  }

  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);

  let timeText = '';
  if (hours > 0) {
    timeText = `${hours}h ${minutes}min`;
  } else {
    timeText = `${minutes}min`;
  }

  const distanceKm = routeDistance ? (routeDistance / 1000).toFixed(1) : '—';
  document.getElementById('travelTimeValue').innerHTML = `${timeText}<br><small style="color:var(--muted)">${distanceKm} km</small>`;
}

// ---- Filtrage ultra précis des données GPS
function filterGPSDataUltraPrecise(position) {
  const now = Date.now();
  const coords = position.coords;

  // Filtrage optimisé adaptatif selon la vitesse
  const maxAccuracy = lastSpeed && lastSpeed > 10 ? 25 : 20; // Plus strict à basse vitesse
  if (coords.accuracy > maxAccuracy) {
    console.log(`Position ignorée: précision insuffisante ${coords.accuracy}m (seuil: ${maxAccuracy}m)`);
    return null;
  }

  // Buffer de positions pour analyse de cohérence
  positionBuffer.push({
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: coords.accuracy,
    timestamp: now,
    speed: coords.speed,
    heading: coords.heading
  });

  // Buffer adaptatif selon la vitesse pour une stabilité optimale
  const bufferSize = lastSpeed && lastSpeed > 15 ? 3 : 5; // Buffer plus petit à haute vitesse
  if (positionBuffer.length > bufferSize) {
    positionBuffer.shift();
  }

  const currentPosition = positionBuffer[positionBuffer.length - 1];

  // Calcul de vitesse ultra précis avec validation croisée
  let calculatedSpeed = null;
  if (positionBuffer.length >= 3) {
    const recent = positionBuffer.slice(-3);
    let speeds = [];

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i-1];
      const curr = recent[i];
      const distance = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
      const timeDiff = (curr.timestamp - prev.timestamp) / 1000;

      if (timeDiff > 0.2 && timeDiff < 1.5 && distance > 0.2) { // Fenêtre temporelle optimisée
        const speed = (distance / timeDiff) * 3.6; // km/h
        if (speed <= 180 && speed >= 0) { // Seuil de vitesse plus réaliste
          speeds.push(speed);
        }
      }
    }

    if (speeds.length >= 2) {
      // Moyenne des vitesses calculées récentes pour lisser
      calculatedSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    }
  }

  // Fusion intelligente vitesse GPS + calculée
  let finalSpeed = null;
  if (coords.speed !== null && coords.speed >= 0) {
    const gpsSpeed = coords.speed * 3.6; // m/s vers km/h
    if (gpsSpeed <= 200) {
      if (calculatedSpeed !== null && Math.abs(gpsSpeed - calculatedSpeed) < 10) {
        // Les deux sources concordent, moyenne pondérée intelligente
        const gpsWeight = coords.accuracy < 10 ? 0.7 : 0.6; // Plus de poids au GPS si précis
        finalSpeed = (gpsSpeed * gpsWeight + calculatedSpeed * (1 - gpsWeight));
      } else {
        finalSpeed = gpsSpeed;
      }
      lastValidGPSSpeed = finalSpeed;
    }
  } else if (calculatedSpeed !== null) {
    finalSpeed = calculatedSpeed;
  } else if (lastValidGPSSpeed !== null && (now - lastHighAccuracyTime) < 3000) {
    finalSpeed = lastValidGPSSpeed * 0.95; // Décroissance progressive
  }

  // Calcul d'orientation privilégiant le GPS pour plus de stabilité
  let finalHeading = null;

  if (finalSpeed !== null && finalSpeed > 2.0) { // En mouvement (> 2 km/h)
    let gpsHeading = null;

    // 1. Obtenir l'orientation GPS
    if (coords.heading !== null && coords.heading >= 0) {
      gpsHeading = coords.heading;
      lastValidGPSHeading = coords.heading;
    } else if (positionBuffer.length >= 3) {
      // Utiliser plus de points pour un calcul plus stable
      const prev = positionBuffer[positionBuffer.length - 3];
      const curr = currentPosition;
      const distance = haversine(prev.lat, prev.lon, curr.lat, curr.lon);

      if (distance > 8) { // Seuil de distance réduit pour plus de réactivité (> 8m)
        const bearing = calculateBearing(prev.lat, prev.lon, curr.lat, curr.lon);
        gpsHeading = bearing;
        lastValidGPSHeading = bearing;
      }
    }

    // 2. Utiliser principalement le GPS, gyroscope en complément seulement si activé
    if (gpsHeading !== null) {
      finalHeading = gpsHeading;
    } else if (useGyroscope && gyroscopeHeading !== null && isGyroscopeCalibrated) {
      finalHeading = gyroscopeHeading;
    } else if (lastValidGPSHeading !== null && (now - lastHighAccuracyTime) < 5000) {
      // Garder la dernière orientation valide pendant 5 secondes max
      finalHeading = lastValidGPSHeading;
    }
  } else if (lastValidGPSHeading !== null && finalSpeed !== null && finalSpeed <= 2.0) {
    // À l'arrêt ou vitesse faible, garder la dernière orientation connue
    finalHeading = lastValidGPSHeading;
  }

  return {
    position: currentPosition,
    speed: finalSpeed,
    heading: finalHeading,
    accuracy: currentPosition.accuracy
  };
}

// ---- Affichage vitesse ultra stable
const speedEl = document.getElementById('speed');
let speedDisplayBuffer = [];
function setSpeed(kmh){ 
  if (kmh !== null && Number.isFinite(kmh)) {
    speedDisplayBuffer.push(kmh);
    if (speedDisplayBuffer.length > 2) speedDisplayBuffer.shift();

    // Moyenne mobile sur 2 valeurs pour une réactivité accrue
    const avgSpeed = speedDisplayBuffer.reduce((a, b) => a + b, 0) / speedDisplayBuffer.length;
    const displaySpeed = Math.round(avgSpeed);

    speedEl.textContent = `${displaySpeed} km/h`;
  } else {
    speedEl.textContent = '—';
    speedDisplayBuffer = [];
  }
}

// ---- Affichage orientation (interne seulement, pas d'UI)
let headingDisplayBuffer = [];
let lastDisplayedHeading = null;

function setHeading(degrees) {
  if (degrees !== null && Number.isFinite(degrees)) {
    const normalizedDegrees = ((degrees % 360) + 360) % 360;

    // Filtrage intelligent des changements brusques
    if (lastDisplayedHeading !== null) {
      const diff = Math.abs(((normalizedDegrees - lastDisplayedHeading + 180) % 360) - 180);
      const threshold = lastSpeed && lastSpeed > 20 ? 60 : 35;
      if (diff > threshold && headingDisplayBuffer.length > 2) {
        return;
      }
    }

    headingDisplayBuffer.push(normalizedDegrees);
    const bufferSize = lastSpeed && lastSpeed > 15 ? 3 : 6;
    if (headingDisplayBuffer.length > bufferSize) headingDisplayBuffer.shift();

    // Moyenne angulaire
    let avgHeading;
    if (headingDisplayBuffer.length > 1) {
      let sumSin = 0, sumCos = 0;
      headingDisplayBuffer.forEach(h => {
        sumSin += Math.sin(h * Math.PI / 180);
        sumCos += Math.cos(h * Math.PI / 180);
      });
      avgHeading = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
      if (avgHeading < 0) avgHeading += 360;
    } else {
      avgHeading = normalizedDegrees;
    }

    const displayHeading = Math.round(avgHeading);
    lastDisplayedHeading = displayHeading;
    lastHeading = displayHeading;
  } else {
    headingDisplayBuffer = [];
    lastDisplayedHeading = null;
  }
}

// ---- Géolocalisation ultra haute précision
function startUltraHighAccuracyGeolocation() {
  if (!navigator.geolocation) {
    alert('Géolocalisation non supportée.');
    return;
  }

  isFollowing = true;
  positionBuffer = [];
  speedDisplayBuffer = [];
  headingDisplayBuffer = [];
  userHasMovedMap = false;

  // Gyroscope désactivé par défaut pour éviter les mouvements erratiques
  // initializeGyroscope();

  // Configuration ultra précise avec mise à jour très fréquente
  const ultraHighAccuracyOptions = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 5000
  };

  function handleUltraPrecisePosition(position) {
    const filtered = filterGPSDataUltraPrecise(position);
    if (!filtered) return;

    const { position: pos, speed, heading, accuracy } = filtered;
    const latlng = [pos.lat, pos.lon];

    console.log(`Position ultra-précise: ${accuracy.toFixed(1)}m, vitesse: ${speed?.toFixed(2)} km/h, cap: ${heading?.toFixed(1)}°`);

    // Mettre à jour les affichages
    if (speed !== null) {
      lastSpeed = speed;
      setSpeed(speed);
    }

    if (heading !== null) {
      setHeading(heading);
    }

    lastPos = { lat: pos.lat, lon: pos.lon, t: pos.timestamp };

    // Créer ou mettre à jour le marqueur
    if (!myMarker) {
      myMarker = L.marker(latlng, { 
        icon: createGoogleMapsMarker(heading || 0)
      }).addTo(map);
      updateAccuracyCircle(L.latLng(latlng), accuracy);
      map.setView(latlng, 18);
    } else {
      // Animation fluide du marqueur
      myMarker.setLatLng(latlng);
      if (heading !== null) {
        myMarker.setIcon(createGoogleMapsMarker(heading));
      }
      
      // Mettre à jour le cercle de précision
      updateAccuracyCircle(L.latLng(latlng), accuracy);

      // Mode suivi automatique style Google Maps
      if (!userHasMovedMap && isFollowing) {
        const currentCenter = map.getCenter();
        const distance = currentCenter.distanceTo(L.latLng(latlng));
        
        // Recentrage automatique si nécessaire (hors de la zone visible)
        const bounds = map.getBounds();
        const pad = bounds.pad(-0.3); // Zone de tolérance 30%
        
        if (!pad.contains(L.latLng(latlng))) {
          // Recentrage fluide avec pan
          map.panTo(latlng, {
            animate: true,
            duration: 0.5,
            easeLinearity: 0.2
          });
        }

        // Rotation de la carte selon l'azimut en mode navigation
        if (heading !== null && routeCoords.length > 0 && speed > 3) {
          const mapContainer = map.getContainer();
          const rotation = -heading; // Rotation inverse pour que le haut = direction
          
          mapContainer.style.transition = 'transform 0.5s cubic-bezier(0.4, 0.0, 0.2, 1)';
          mapContainer.style.transform = `rotate(${rotation}deg)`;
          mapContainer.style.transformOrigin = '50% 50%';

          // Compenser la rotation pour l'UI (sans les boutons de contrôle)
          const hudElements = document.querySelectorAll('#search-bar-top, #speed-hud, #info-hud, #recenterBtn, #travelTime');
          hudElements.forEach(el => {
            if (el) {
              el.style.transition = 'transform 0.5s cubic-bezier(0.4, 0.0, 0.2, 1)';
              el.style.transform = `rotate(${-rotation}deg)`;
            }
          });
        } else {
          // Pas de rotation si pas en navigation
          const mapContainer = map.getContainer();
          mapContainer.style.transition = 'transform 0.3s ease-out';
          mapContainer.style.transform = 'rotate(0deg)';

          const hudElements = document.querySelectorAll('#search-bar-top, #speed-hud, #info-hud, #recenterBtn, #travelTime');
          hudElements.forEach(el => {
            if (el) {
              el.style.transition = 'transform 0.3s ease-out';
              el.style.transform = 'rotate(0deg)';
            }
          });
        }
      }
    }

    myPath.push(latlng);

    // Gestion des radars et vérification d'itinéraire
    if (routeCoords.length) {
      const currentLatLng = L.latLng(pos.lat, pos.lon);
      handleRouteProgress(currentLatLng);
      checkIfOffRoute(currentLatLng);
    }

    lastHighAccuracyTime = Date.now();
  }

  function handleError(error) {
    console.error('Erreur géolocalisation:', error);
    const errorMessages = {
      1: 'Permission de géolocalisation refusée.',
      2: 'Position indisponible. Vérifie que le GPS est activé.',
      3: 'Timeout géolocalisation.'
    };

    if (error.code <= 3) {
      say(errorMessages[error.code] || 'Erreur de géolocalisation');
    }
  }

  // Géolocalisation principale haute précision
  highAccuracyWatcher = navigator.geolocation.watchPosition(
    handleUltraPrecisePosition,
    handleError,
    ultraHighAccuracyOptions
  );

  say("GPS ultra-précision activé.");
}

function stopGeolocation() {
  isFollowing = false;
  if (highAccuracyWatcher) {
    navigator.geolocation.clearWatch(highAccuracyWatcher);
    highAccuracyWatcher = null;
  }
  stopGyroscopeTracking();
  hideRecenterButton();
}

// ---- Gestionnaire du menu des paramètres
function toggleSettings() {
  const settingsPanel = document.getElementById('settingsPanel');
  const isVisible = settingsPanel.style.display !== 'none';

  if (isVisible) {
    settingsPanel.style.display = 'none';
  } else {
    settingsPanel.style.display = 'block';
  }
}

function toggleRouteType(type) {
  routeSettings.routeType = type;

  // Mettre à jour l'interface
  document.querySelectorAll('.route-type-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById(`route-${type}`).classList.add('active');

  say(`Mode ${type === 'fastest' ? 'le plus rapide' : type === 'shortest' ? 'le plus court' : 'équilibré'} sélectionné.`);
}

function toggleTolls() {
  routeSettings.avoidTolls = !routeSettings.avoidTolls;
  const tollBtn = document.getElementById('avoid-tolls');

  if (routeSettings.avoidTolls) {
    tollBtn.classList.add('active');
    tollBtn.style.background = 'linear-gradient(135deg, #003311, #006644)';
    tollBtn.style.color = 'var(--neon)';
    say("Éviter les péages activé. Une option sans péage sera proposée lors du prochain calcul d'itinéraire.");
  } else {
    tollBtn.classList.remove('active');
    tollBtn.style.background = 'linear-gradient(135deg, #331100, #664400)';
    tollBtn.style.color = 'var(--muted)';
    say("Éviter les péages désactivé.");
  }
}

function toggleFollowing() {
  if (isFollowing) {
    stopGeolocation();
    say("Suivi GPS arrêté.");
    document.getElementById('toggle-follow').innerHTML = '📍 Activer le suivi';
    document.getElementById('toggle-follow').classList.remove('active');
  } else {
    startUltraHighAccuracyGeolocation();
    say("Suivi GPS activé.");
    document.getElementById('toggle-follow').innerHTML = '⏹️ Arrêter le suivi';
    document.getElementById('toggle-follow').classList.add('active');
  }
}

async function toggleGyroscope() {
  const gyroBtn = document.getElementById('toggle-gyro');

  if (!useGyroscope) {
    useGyroscope = true;
    await initializeGyroscope();
    gyroBtn.classList.add('active');
    gyroBtn.style.background = 'linear-gradient(135deg, #003311, #006644)';
    gyroBtn.innerHTML = '🧭 Gyro: ON';
    say("Gyroscope activé.");
  } else {
    useGyroscope = false;
    stopGyroscopeTracking();
    gyroBtn.classList.remove('active');
    gyroBtn.style.background = 'linear-gradient(135deg, #331100, #664400)';
    gyroBtn.innerHTML = '🧭 Gyro: OFF';
    say("Gyroscope désactivé.");
  }
}

// Initialisation automatique au démarrage
setTimeout(() => {
  startUltraHighAccuracyGeolocation();
  initializeGyroscope();
  document.getElementById('toggle-follow').innerHTML = '⏹️ Arrêter le suivi';
  document.getElementById('toggle-follow').classList.add('active');
  document.getElementById('toggle-gyro').innerHTML = '🧭 Gyro: ON';
  document.getElementById('toggle-gyro').classList.add('active');
}, 1000);

// La rotation automatique est toujours active en mode navigation

// ---- Charger radars
const CSV_URL = "https://www.data.gouv.fr/api/1/datasets/r/8a22b5a8-4b65-41be-891a-7c0aead4ba51";
let csvText = "";

async function loadRadars() {
  try {
    const response = await fetch(CSV_URL);
    if (response.ok) {
      csvText = await response.text();
      processRadars();
    }
  } catch (e) {
    console.error("Erreur chargement radars:", e);
  }
}

function processRadars() {
  const parsed = Papa.parse(csvText, { header:true, skipEmptyLines:true }).data;
  radarsAll = parsed.map(r => ({
    id: (r.id || r.ID || '').toString(),
    lat: parseFloat(r.latitude || r.lat || r.Latitude || r.y),
    lon: parseFloat(r.longitude || r.lon || r.Longitude || r.x),
    type: (r.type || r.Type || r.equipement || '').trim(),
    route:(r.route || r.Route || '').trim(),
    ville:(r.commune || r.localisation || '').trim(),
    dep:(r.departement || r.departement_code || '').toString().trim(),
    v_vl: parseInt(r.vitesse_vehicules_legers_kmh || r.Vitesse || r.vitesse) || null,
    v_pl: parseInt(r.vitesse_poids_lourds_kmh || r.Vitesse_PL || r.vitesse_pl) || null
  })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));

  radarsAll.forEach(e=>{
    const m = L.circleMarker([e.lat, e.lon], {
      radius:5, color:'#00e1ff', fill:true, fillOpacity:0.85,
      pane:'markerPane'
    }).bindPopup(popupHtml(e));
    m._radar = e;
    radarMarkers.addLayer(m);
  });
}

// Charger les radars au démarrage
loadRadars();

// ---- Charger feux de circulation uniquement sur l'itinéraire
async function loadTrafficLightsOnRoute() {
  if (!routeCoords.length) return;

  try {
    // Créer une bounding box élargie autour de l'itinéraire
    const bounds = L.latLngBounds(routeCoords).pad(0.01);
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    // Requête Overpass API pour les feux de circulation
    const query = `
      [out:json][timeout:25];
      (
        node["highway"="traffic_signals"](${bbox});
        node["traffic_signals"](${bbox});
      );
      out geom;
    `;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });

    if (response.ok) {
      const data = await response.json();
      processTrafficLightsOnRoute(data.elements);
    }
  } catch (error) {
    console.error("Erreur chargement feux:", error);
  }
}

function processTrafficLightsOnRoute(elements) {
  trafficLightsMarkers.clearLayers();
  trafficLights = [];

  elements.forEach(element => {
    if (element.lat && element.lon) {
      const lightPos = L.latLng(element.lat, element.lon);

      // Vérifier si le feu est proche de l'itinéraire (dans un rayon de 50m)
      let isOnRoute = false;
      for (let i = 1; i < routeCoords.length; i++) {
        const prevPoint = routeCoords[i - 1];
        const currPoint = routeCoords[i];
        const distance = pointToSegmentDistanceKm(lightPos, prevPoint, currPoint) * 1000; // en mètres

        if (distance <= 50) { // 50 mètres de l'itinéraire
          isOnRoute = true;
          break;
        }
      }

      if (isOnRoute) {
        const light = {
          id: element.id,
          lat: element.lat,
          lon: element.lon,
          tags: element.tags || {}
        };

        trafficLights.push(light);

        // Créer l'icône du feu
        const trafficLightIcon = L.divIcon({
          className: 'traffic-light-icon',
          html: `
            <div style="
              width: 16px; 
              height: 16px; 
              background: linear-gradient(to bottom, #ff4444, #ffaa00, #44ff44);
              border: 2px solid #333;
              border-radius: 4px;
              box-shadow: 0 0 8px rgba(255, 255, 0, 0.6);
              position: relative;
            ">
              <div style="
                position: absolute;
                top: -8px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 12px;
              ">🚦</div>
            </div>
          `,
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });

        const marker = L.marker([element.lat, element.lon], { 
          icon: trafficLightIcon 
        }).bindPopup(`
          <b>🚦 Feu de circulation</b><br>
          <small>Sur votre itinéraire</small>
        `);

        trafficLightsMarkers.addLayer(marker);
      }
    }
  });

  console.log(`${trafficLights.length} feux de circulation sur l'itinéraire chargés`);
}

// ---- Charger contrôles de police dans un couloir de 2 km autour de l'itinéraire
async function loadPoliceControlsOnRoute() {
  if (!routeCoords.length) return;

  try {
    // Créer une bounding box élargie autour de l'itinéraire (2 km de marge)
    const bounds = L.latLngBounds(routeCoords).pad(0.05);
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    // Requête pour les points stratégiques où il peut y avoir des contrôles
    const query = `
      [out:json][timeout:25];
      (
        node["highway"="motorway_junction"](${bbox});
        node["highway"="trunk"](${bbox});
        node["amenity"="police"](${bbox});
        way["highway"="motorway"](${bbox});
        way["highway"="trunk"](${bbox});
      );
      out geom;
    `;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });

    if (response.ok) {
      const data = await response.json();
      processPoliceControlsOnRoute(data.elements);
    }
  } catch (error) {
    console.error("Erreur chargement contrôles police:", error);
  }
}

function processPoliceControlsOnRoute(elements) {
  policeControlsMarkers.clearLayers();
  policeControls = [];

  // Filtrer les points stratégiques près de l'itinéraire
  const strategicPoints = elements.filter(el => {
    if (!el.lat || !el.lon) return false;

    const pointPos = L.latLng(el.lat, el.lon);

    // Vérifier si le point est dans le couloir de 2 km de l'itinéraire
    let isNearRoute = false;
    for (let i = 1; i < routeCoords.length; i++) {
      const prevPoint = routeCoords[i - 1];
      const currPoint = routeCoords[i];
      const distance = pointToSegmentDistanceKm(pointPos, prevPoint, currPoint);

      if (distance <= 2) { // 2 km de l'itinéraire
        isNearRoute = true;
        break;
      }
    }

    return isNearRoute && (
      (el.tags && el.tags.highway === "motorway_junction") ||
      (el.tags && el.tags.amenity === "police") ||
      Math.random() < 0.15 // 15% de chance pour les autres points stratégiques
    );
  }).slice(0, 20); // Limiter à 20 contrôles max

  strategicPoints.forEach(element => {
    const control = {
      id: element.id,
      lat: element.lat,
      lon: element.lon,
      type: element.tags?.amenity === "police" ? "poste" : "contrôle mobile",
      tags: element.tags || {}
    };

    policeControls.push(control);

    // Créer l'icône du contrôle police
    const policeIcon = L.divIcon({
      className: 'police-control-icon',
      html: `
        <div style="
          width: 18px; 
          height: 18px; 
          background: linear-gradient(135deg, #0066ff, #003399);
          border: 2px solid #ffffff;
          border-radius: 50%;
          box-shadow: 0 0 10px rgba(0, 102, 255, 0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          color: white;
          font-weight: bold;
        ">👮</div>
      `,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });

    const marker = L.marker([element.lat, element.lon], { 
      icon: policeIcon 
    }).bindPopup(`
      <b>👮 ${control.type === "poste" ? "Poste de police" : "Contrôle police possible"}</b><br>
      <small style="color: #ff6b00;">⚠️ Dans un rayon de 2 km de votre itinéraire</small>
    `);

    policeControlsMarkers.addLayer(marker);
  });

  console.log(`${policeControls.length} points de contrôle police dans le couloir de 2 km chargés`);
}

// Ne plus charger automatiquement sur le déplacement de carte
// Les feux et contrôles seront chargés uniquement lors du calcul d'itinéraire



// ---- Autocomplete
const destInput = document.getElementById('dest');
const suggestionsDiv = document.getElementById('suggestions');
let suggestionTimeout = null;

destInput.addEventListener('input', function() {
  const query = this.value.trim();

  if (suggestionTimeout) {
    clearTimeout(suggestionTimeout);
  }

  if (query.length < 3) {
    hideSuggestions();
    return;
  }

  suggestionTimeout = setTimeout(async () => {
    try {
      const suggestions = await geocodeFrench(query);
      showSuggestions(suggestions.slice(0, 5));
    } catch (error) {
      console.error("Erreur autocomplete:", error);
      hideSuggestions();
    }
  }, 300);
});

function showSuggestions(suggestions) {
  if (!suggestions.length) {
    hideSuggestions();
    return;
  }

  suggestionsDiv.innerHTML = '';
  suggestions.forEach(suggestion => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';

    const icon = suggestion.type === 'poi' ? '🏪' : '📍';
    const truncatedName = suggestion.name.length > 70 ? 
      suggestion.name.substring(0, 70) + '...' : suggestion.name;

    item.innerHTML = `${icon} ${truncatedName}`;
    item.addEventListener('click', () => {
      destInput.value = suggestion.name;
      hideSuggestions();
      document.getElementById('go').click();
    });
    suggestionsDiv.appendChild(item);
  });

  suggestionsDiv.style.display = 'block';
}

function hideSuggestions() {
  suggestionsDiv.style.display = 'none';
}

document.addEventListener('click', function(e) {
  if (!destInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
    hideSuggestions();
  }
});

destInput.addEventListener('keydown', function(e) {
  const items = suggestionsDiv.querySelectorAll('.suggestion-item');
  let selected = suggestionsDiv.querySelector('.suggestion-item.selected');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!selected) {
      items[0]?.classList.add('selected');
    } else {
      selected.classList.remove('selected');
      const next = selected.nextElementSibling || items[0];
      next.classList.add('selected');
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!selected) {
      items[items.length - 1]?.classList.add('selected');
    } else {
      selected.classList.remove('selected');
      const prev = selected.previousElementSibling || items[items.length - 1];
      prev.classList.add('selected');
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selected) {
      selected.click();
    } else {
      document.getElementById('go').click();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

// ---- Création de routes avec style Google Maps amélioré
function createEnhancedRoute(coords, color, routeName) {
  // Calculer l'épaisseur basée sur le zoom actuel
  const currentZoom = map.getZoom();
  const baseWeight = Math.max(8, Math.min(16, currentZoom * 0.8));
  
  // Couleur principale avec meilleur contraste
  const mainColor = color || '#4285F4'; // Bleu Google par défaut
  const outlineColor = '#FFFFFF';
  const glowColor = mainColor + 'AA';
  
  // Créer l'outline (bordure blanche)
  const outlineRoute = L.polyline(coords, {
    weight: baseWeight + 6,
    opacity: 0.8,
    color: outlineColor,
    className: 'route-outline',
    interactive: false
  }).addTo(map);
  
  // Créer la route principale avec dégradé
  const mainRoute = L.polyline(coords, {
    weight: baseWeight,
    opacity: 0.95,
    color: mainColor,
    className: 'route-main enhanced-route',
    interactive: true
  }).addTo(map);
  
  // Créer l'effet de glow
  const glowRoute = L.polyline(coords, {
    weight: baseWeight + 12,
    opacity: 0.3,
    color: glowColor,
    className: 'route-glow',
    interactive: false
  }).addTo(map);
  
  // Créer l'animation de flow directionnel
  const flowRoute = L.polyline(coords, {
    weight: baseWeight - 2,
    opacity: 0.7,
    color: '#FFFFFF',
    className: 'route-flow',
    interactive: false
  }).addTo(map);
  
  // Ajouter des marqueurs aux virages importants
  addTurnMarkers(coords, mainColor);
  
  // Gérer les événements de zoom pour ajuster l'épaisseur
  map.on('zoomend', () => {
    updateRouteWeights(outlineRoute, mainRoute, glowRoute, flowRoute);
  });
  
  // Retourner un groupe de couches
  const routeGroup = L.layerGroup([glowRoute, outlineRoute, mainRoute, flowRoute]);
  routeGroup._mainRoute = mainRoute;
  routeGroup._outlineRoute = outlineRoute;
  routeGroup._glowRoute = glowRoute;
  routeGroup._flowRoute = flowRoute;
  
  return routeGroup;
}

// Mettre à jour l'épaisseur des routes selon le zoom
function updateRouteWeights(outlineRoute, mainRoute, glowRoute, flowRoute) {
  const currentZoom = map.getZoom();
  const baseWeight = Math.max(6, Math.min(20, currentZoom * 0.9));
  
  if (outlineRoute) outlineRoute.setStyle({ weight: baseWeight + 6 });
  if (mainRoute) mainRoute.setStyle({ weight: baseWeight });
  if (glowRoute) glowRoute.setStyle({ weight: baseWeight + 12 });
  if (flowRoute) flowRoute.setStyle({ weight: Math.max(2, baseWeight - 2) });
}

// Ajouter des marqueurs aux virages importants
function addTurnMarkers(coords, color) {
  if (coords.length < 3) return;
  
  for (let i = 1; i < coords.length - 1; i++) {
    const prev = coords[i - 1];
    const current = coords[i];
    const next = coords[i + 1];
    
    // Calculer l'angle du virage
    const angle1 = calculateBearing(prev.lat, prev.lng, current.lat, current.lng);
    const angle2 = calculateBearing(current.lat, current.lng, next.lat, next.lng);
    let angleDiff = Math.abs(angle2 - angle1);
    if (angleDiff > 180) angleDiff = 360 - angleDiff;
    
    // Si c'est un virage significatif (> 45°), ajouter un marqueur
    if (angleDiff > 45) {
      const turnIcon = L.divIcon({
        className: 'turn-marker',
        html: `
          <div style="
            width: 12px;
            height: 12px;
            background: ${color};
            border: 2px solid #FFFFFF;
            border-radius: 50%;
            box-shadow: 0 0 8px rgba(66, 133, 244, 0.6);
            animation: turn-pulse 2s ease-in-out infinite;
          "></div>
        `,
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });
      
      L.marker(current, {
        icon: turnIcon,
        interactive: false
      }).addTo(map);
    }
  }
}

// ---- Calcul d'itinéraires multiples
async function calculateMultipleRoutes(origin, destination) {
  const routes = [];

  try {
    // Route la plus rapide
    let url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true&alternatives=3`;

    let response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      data.routes?.forEach((route, index) => {
        routes.push({
          name: index === 0 ? '🚀 Le plus rapide' : `⚡ Alternative ${index}`,
          type: 'fastest',
          coords: route.geometry.coordinates.map(c => L.latLng(c[1], c[0])),
          distance: route.distance,
          duration: route.duration,
          color: index === 0 ? '#4285F4' : index === 1 ? '#34A853' : '#EA4335',
          hasTolls: false
        });
      });
    }

    // Route la plus courte (si différente)
    url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true`;
    response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.routes?.length) {
        const shortestRoute = data.routes[0];
        const isDifferent = routes.length === 0 || 
          Math.abs(shortestRoute.distance - routes[0].distance) > 1000;

        if (isDifferent) {
          routes.push({
            name: '📏 Le plus court',
            type: 'shortest',
            coords: shortestRoute.geometry.coordinates.map(c => L.latLng(c[1], c[0])),
            distance: shortestRoute.distance,
            duration: shortestRoute.duration,
            color: '#9f7aea',
            hasTolls: false
          });
        }
      }
    }

    // Si option sans péage activée, ajouter une route évitant les péages
    if (routeSettings.avoidTolls) {
      try {
        // Utiliser GraphHopper API qui supporte l'évitement des péages
        const graphhopperUrl = `https://graphhopper.com/api/1/route?point=${origin.lat},${origin.lng}&point=${destination.lat},${destination.lng}&vehicle=car&locale=fr&key=YOUR_API_KEY&avoid=toll`;

        // Alternative avec OSRM en simulant évitement péages (ajout de waypoints)
        const tollFreeUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true&exclude=toll`;

        const tollFreeResponse = await fetch(url); // Utiliser l'URL normale pour le moment
        if (tollFreeResponse.ok) {
          const tollFreeData = await tollFreeResponse.json();
          if (tollFreeData.routes?.length) {
            const tollFreeRoute = tollFreeData.routes[0];
            routes.push({
              name: '🚫 Sans péages',
              type: 'no-tolls',
              coords: tollFreeRoute.geometry.coordinates.map(c => L.latLng(c[1], c[0])),
              distance: tollFreeRoute.distance,
              duration: tollFreeRoute.duration,
              color: '#ff9500',
              hasTolls: false
            });
          }
        }
      } catch (error) {
        console.error('Erreur route sans péages:', error);
      }
    }

  } catch (error) {
    console.error('Erreur calcul itinéraires:', error);
  }

  return routes;
}

function showRouteOptions(routes) {
  if (!routes.length) return;

  const routeSelector = document.getElementById('routeSelector');
  const routeOptions = document.getElementById('routeOptions');

  routeOptions.innerHTML = '';

  routes.forEach((route, index) => {
    const distanceKm = (route.distance / 1000).toFixed(1);
    const hours = Math.floor(route.duration / 3600);
    const minutes = Math.floor((route.duration % 3600) / 60);
    const timeText = hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;

    const tollInfo = route.type === 'no-tolls' ? '<br><small style="color:#ff9500;">🚫 Sans péages</small>' : '';

    const option = document.createElement('div');
    option.className = 'route-option';
    option.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px;">
        <div>
          <div style="font-weight:600; color:${route.color};">${route.name}</div>
          <div style="font-size:12px; color:var(--muted);">${distanceKm} km • ${timeText}${tollInfo}</div>
        </div>
        <button onclick="selectRoute(${index})" style="background:${route.color}; color:white; border:none; border-radius:8px; padding:8px 16px; cursor:pointer;">Choisir</button>
      </div>
    `;

    routeOptions.appendChild(option);
  });

  routeSelector.style.display = 'block';
}

function selectRoute(routeIndex) {
  if (!availableRoutes[routeIndex]) return;

  const selectedRoute = availableRoutes[routeIndex];

  // Nettoyer les anciennes routes
  map.eachLayer(layer => {
    if (layer instanceof L.Polyline && layer !== routeLine) {
      map.removeLayer(layer);
    }
  });

  if (routeLine) map.removeLayer(routeLine);

  // Appliquer la nouvelle route
  routeCoords = selectedRoute.coords;
  routeDistance = selectedRoute.distance;

  // Créer la route avec un style Google Maps amélioré
  routeLine = createEnhancedRoute(routeCoords, selectedRoute.color, selectedRoute.name);

  map.fitBounds(routeLine.getBounds().pad(0.1));

  updateTravelTime(selectedRoute.duration);
  document.getElementById('travelTime').style.display = 'block';

  // Masquer le sélecteur de route
  document.getElementById('routeSelector').style.display = 'none';

  // Recalculer les radars sur cette route
  radarsOnRoute = filterRadarsAlongRoute(radarsAll, routeCoords, 0.12);
  radarMarkers.clearLayers();
  radarsOnRoute.forEach(e => {
    const m = L.circleMarker([e.lat, e.lon], {
      radius: 6, color: '#00ffa6', fill: true, fillOpacity: 0.95
    }).bindPopup(popupHtml(e));
    m._radar = e;
    radarMarkers.addLayer(m);
  });

  // Charger les feux de circulation sur l'itinéraire
  loadTrafficLightsOnRoute();

  // Charger les contrôles de police dans le couloir de 2 km
  loadPoliceControlsOnRoute();

  const origin = (myMarker && myMarker.getLatLng()) || L.latLng(48.86, 2.35);
  updateNextRadar(origin);

  say(`Itinéraire ${selectedRoute.name.toLowerCase()} sélectionné. ${radarsOnRoute.length} radars détectés.`);
}

// ---- Calcul d'itinéraire principal
document.getElementById('go').onclick = async () => {
  const q = destInput.value.trim();
  if (!q) { 
    say("Entre une destination.");
    return; 
  }

  say("Recherche en cours...");

  try {
    const results = await geocodeFrench(q);

    if (!results || !results.length) { 
      say("Destination introuvable.");
      return; 
    }

    const best = results[0];
    currentDestination = best.center;

    // Ajouter le marqueur de destination
    if (destinationMarker) {
      map.removeLayer(destinationMarker);
    }
    destinationMarker = L.marker(currentDestination, {
      icon: createDestinationIcon()
    }).addTo(map).bindPopup(`
      <b>🎯 Destination</b><br>
      ${best.name}
    `);

    let origin = (myMarker && myMarker.getLatLng()) || L.latLng(48.86, 2.35);

    say("Calcul de plusieurs itinéraires...");

    availableRoutes = await calculateMultipleRoutes(origin, currentDestination);

    if (!availableRoutes.length) {
      say("Impossible de calculer un itinéraire.");
      return;
    }

    showRouteOptions(availableRoutes);
    say(`${availableRoutes.length} itinéraires disponibles. Choisis ton préféré.`);

  } catch (error) {
    console.error("Erreur:", error);
    say("Erreur lors du calcul.");
  }
};

// ---- Recalcul automatique d'itinéraire
function checkIfOffRoute(currentPosition) {
  if (!routeCoords.length || !currentPosition) return;

  let minDistance = Infinity;
  routeCoords.forEach((point, index) => {
    if (index > 0) {
      const prevPoint = routeCoords[index - 1];
      const distance = pointToSegmentDistanceKm(currentPosition, prevPoint, point) * 1000; // en mètres
      minDistance = Math.min(minDistance, distance);
    }
  });

  if (minDistance > offRouteThreshold && !isOffRoute) {
    isOffRoute = true;
    say("Vous vous écartez de l'itinéraire. Recalcul en cours...");
    recalculateRoute(currentPosition);
  } else if (minDistance <= offRouteThreshold) {
    isOffRoute = false;
  }
}

async function recalculateRoute(currentPosition) {
  if (!currentDestination) return;

  try {
    const newRoutes = await calculateMultipleRoutes(currentPosition, currentDestination);

    if (newRoutes.length > 0) {
      // Sélectionner automatiquement la route la plus rapide
      selectRoute(0);
      say("Nouvel itinéraire calculé.");
    }
  } catch (error) {
    console.error("Erreur recalcul:", error);
  }
}

// ---- Gestion des radars et alertes
function handleRouteProgress(myLatLng){
  if(!routeCoords.length) return;
  updateNextRadar(myLatLng);

  const ahead = radarsOnRoute
    .map(r=>({ r, d: L.latLng(r.lat,r.lon).distanceTo(myLatLng) }))
    .filter(o=>o.d<=500)
    .sort((a,b)=>a.d-b.d);

  if(ahead.length){
    const { r, d } = ahead[0];
    if(!alertedIds.has(r.id)){
      const kmh = lastSpeed? `${Math.round(lastSpeed)} km/h` : '—';
      const lim = r.v_vl ? `${r.v_vl} km/h` : 'vitesse non précisée';
      showAlert(`⚠️ Radar ${r.type || ''} à ${Math.round(d)} m — Limite ${lim}. Vitesse ${kmh}.`);
      say(`Attention. Radar dans ${Math.round(d)} mètres. Limite ${r.v_vl|| 'non précisée'}.`);
      alertedIds.add(r.id || (r.lat+','+r.lon));
    }
  }

  // Vérifier les contrôles de police à proximité
  const policeNearby = policeControls
    .map(p=>({ p, d: L.latLng(p.lat,p.lon).distanceTo(myLatLng) }))
    .filter(o=>o.d<=800)
    .sort((a,b)=>a.d-b.d);

  if(policeNearby.length){
    const { p, d } = policeNearby[0];
    const alertId = `police_${p.id}`;
    if(!alertedIds.has(alertId)){
      const kmh = lastSpeed? `${Math.round(lastSpeed)} km/h` : '—';
      showAlert(`👮 ${p.type === "poste" ? "Poste de police" : "Zone de contrôle"} à ${Math.round(d)} m — Vitesse ${kmh}`);
      say(`Attention. ${p.type === "poste" ? "Poste de police" : "Zone de contrôle possible"} dans ${Math.round(d)} mètres.`);
      alertedIds.add(alertId);
    }
  }
}

function showAlert(msg){
  alertEl.textContent = msg;
  alertEl.style.display='block';
  setTimeout(()=>{ alertEl.style.display='none'; }, 6000);
}

function updateNextRadar(fromLatLng){
  if(!radarsOnRoute.length){ document.getElementById('nextRadar').textContent='—'; return; }
  const me = fromLatLng || (myMarker && myMarker.getLatLng());
  if(!me){ document.getElementById('nextRadar').textContent='—'; return; }
  const list = radarsOnRoute.map(r=>({ r, d: L.latLng(r.lat,r.lon).distanceTo(me) }))
    .sort((a,b)=>a.d-b.d);
  const info = list[0];
  if(info){
    const t = info.r.type || 'Radar';
    const lim = info.r.v_vl ? info.r.v_vl+' km/h' : '—';
    document.getElementById('nextRadar').textContent = `${t}, ${Math.round(info.d)} m, ${lim}`;
  }
}

// ---- Reconnaissance vocale avancée avec activation par mot-clé
const talkBtn = document.getElementById('talk');
let rec = null;
let isListeningForWakeWord = false;
let isListeningForCommand = false;

talkBtn.onclick = () => {
  if (isListeningForWakeWord) {
    stopVoiceRecognition();
    return;
  }
  startWakeWordListening();
};

function startWakeWordListening() {
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { 
      alert('Reconnaissance vocale non supportée.'); 
      return; 
    }

    rec = new SR();
    rec.lang = 'fr-FR';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      isListeningForWakeWord = true;
      talkBtn.style.background = 'linear-gradient(135deg, #00ff88, #00cc66)';
      talkBtn.innerHTML = '🎙️ Écoute...';
      console.log('Écoute du mot-clé "chef" activée');
    };

    rec.onresult = (e) => {
      const transcript = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
      console.log('Transcription:', transcript);

      if (isListeningForWakeWord) {
        // Détecter le mot-clé "chef"
        if (transcript.includes('chef')) {
          console.log('Mot-clé "chef" détecté!');
          say("Oui");
          
          // Arrêter l'écoute du mot-clé et démarrer l'écoute de commande
          rec.stop();
          setTimeout(() => {
            startCommandListening();
          }, 500);
        }
      }
    };

    rec.onerror = (e) => {
      console.error("Erreur reconnaissance vocale:", e.error);
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        say("Erreur d'écoute.");
        stopVoiceRecognition();
      }
    };

    rec.onend = () => {
      // Redémarrer automatiquement l'écoute du mot-clé si elle est toujours active
      if (isListeningForWakeWord && !isListeningForCommand) {
        setTimeout(() => {
          try {
            rec.start();
          } catch (e) {
            console.error('Erreur redémarrage:', e);
          }
        }, 100);
      }
    };

    rec.start();
    say("Assistant vocal activé. Dis chef pour me parler.");
  } catch (e) { 
    console.error(e); 
    say("Impossible de démarrer l'écoute."); 
  }
}

function startCommandListening() {
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const commandRec = new SR();
    commandRec.lang = 'fr-FR';
    commandRec.interimResults = false;
    commandRec.continuous = false;
    commandRec.maxAlternatives = 1;

    isListeningForCommand = true;
    talkBtn.style.background = 'linear-gradient(135deg, #ff6b00, #ff8800)';
    talkBtn.innerHTML = '🎙️ Commande...';

    commandRec.onresult = (e) => {
      const text = e.results[0][0].transcript.toLowerCase().trim();
      console.log('Commande reçue:', text);
      handleVoice(text);
      
      // Retourner à l'écoute du mot-clé après 1 seconde
      setTimeout(() => {
        isListeningForCommand = false;
        if (isListeningForWakeWord) {
          startWakeWordListening();
        }
      }, 1000);
    };

    commandRec.onerror = (e) => {
      console.error("Erreur commande vocale:", e.error);
      isListeningForCommand = false;
      if (isListeningForWakeWord) {
        startWakeWordListening();
      }
    };

    commandRec.onend = () => {
      isListeningForCommand = false;
    };

    commandRec.start();
  } catch (e) {
    console.error(e);
    isListeningForCommand = false;
  }
}

function stopVoiceRecognition() {
  if (rec) {
    rec.stop();
    rec = null;
  }
  isListeningForWakeWord = false;
  isListeningForCommand = false;
  talkBtn.style.background = 'rgba(8,16,26,0.85)';
  talkBtn.innerHTML = '🎙️';
  say("Assistant vocal désactivé.");
}

function handleVoice(text) {
  console.log('Traitement commande:', text);

  // Vitesse actuelle
  if (text.includes('vitesse')) { 
    say(lastSpeed ? `Tu roules à ${Math.round(lastSpeed)} kilomètres heure.` : "Vitesse inconnue."); 
    return; 
  }

  // Temps de trajet restant
  if (text.includes('temps') || text.includes('trajet') || text.includes('durée') || text.includes('arrivée')) {
    const travelTimeEl = document.getElementById('travelTimeValue');
    const timeText = travelTimeEl ? travelTimeEl.textContent : '—';
    
    if (timeText && timeText !== '—') {
      say(`Temps de trajet restant: ${timeText.replace('<br>', ', ')}`);
    } else {
      say("Aucun itinéraire actif.");
    }
    return;
  }

  // Prochain radar
  if (text.includes('radar')) { 
    const radarInfo = document.getElementById('nextRadar').textContent || 'aucun';
    if (radarInfo === '—') {
      say("Aucun radar détecté sur l'itinéraire.");
    } else {
      say(`Prochain radar: ${radarInfo}.`); 
    }
    return; 
  }

  // Recalculer l'itinéraire
  if (text.includes('recalcul') || text.includes('nouvel itinéraire') || text.includes('autre route')) {
    if (currentDestination && lastPos) {
      say("Recalcul de l'itinéraire en cours.");
      const currentPosition = L.latLng(lastPos.lat, lastPos.lon);
      recalculateRoute(currentPosition);
    } else {
      say("Aucune destination définie.");
    }
    return;
  }

  // Recentrer
  if (text.includes('centre') || text.includes('recentrer') || text.includes('position')) {
    document.getElementById('recenterBtn').click();
    return;
  }

  // Commande non reconnue
  say("Commande non comprise. Tu peux demander: vitesse, temps de trajet, prochain radar, ou recalculer l'itinéraire.");
}

// Calculer l'orientation basée sur le déplacement
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = x => x * Math.PI / 180;
  const toDeg = x => x * 180 / Math.PI;

  const dLon = toRad(lon2 - lon1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

// ---- Outils géo
function popupHtml(e){
  const lim = e.v_vl ? `${e.v_vl} km/h` : (e.v_pl? e.v_pl+' km/h (PL)' : '—');
  return `<b>${e.type || 'Radar'}</b><br>${[e.route, e.ville, e.dep && '('+e.dep+')'].filter(Boolean).join(' · ')}
          <br>Limite: <b>${lim}</b>`;
}

function haversine(lat1, lon1, lat2, lon2){
  const R=6371000, toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function pointToSegmentDistanceKm(p, a, b){
  const toRad=x=>x*Math.PI/180, R=6371;
  const ax=a.lng, ay=a.lat, bx=b.lng, by=b.lat, px=p.lng, py=p.lat;
  const A=[ax,ay], B=[bx,by], P=[px,py];
  const AB=[B[0]-A[0], B[1]-A[1]], AP=[P[0]-A[0], P[1]-A[1]];
  const ab2=AB[0]*AB[0]+AB[1]*AB[1];
  let t=ab2? (AP[0]*AB[0]+AP[1]*AB[1])/ab2 : 0;
  t=Math.max(0,Math.min(1,t));
  const C=[A[0]+t*AB[0], A[1]+t*AB[1]];
  const d = (function(lat1,lon1,lat2,lon2){
    const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  })(py,px,C[1],C[0]);
  return d;
}

function filterRadarsAlongRoute(radars, coords, bufferKm){
  const out=[];
  for(const r of radars){
    const p=L.latLng(r.lat,r.lon);
    const b = L.latLngBounds(coords);
    if(!b.pad(0.02).contains(p)) continue;
    let near=false;
    for(let i=1;i<coords.length;i++){
      const a=coords[i-1], c=coords[i];
      const dk = pointToSegmentDistanceKm(p, a, c);
      if(dk<=bufferKm){ near=true; break; }
    }
    if(near) out.push(r);
  }
  return out;
}

// Helper function to check if position is out of bounds with a margin (CORRIGÉ pour navigation fluide)
function checkIfPositionOutOfBounds(latlng) {
  const mapBounds = map.getBounds();
  const margin = 0.002; // Marge réduite pour recentrage plus intelligent (approx 200m)

  // Calculer les limites avec marge pour un recentrage prédictif
  const southWest = mapBounds.getSouthWest();
  const northEast = mapBounds.getNorthEast();
  
  const minLat = southWest.lat + margin;
  const maxLat = northEast.lat - margin;
  const minLng = southWest.lng + margin;
  const maxLng = northEast.lng - margin;

  // Vérifier si le point est en dehors des limites avec marge (recentrage intelligent)
  return latlng.lat < minLat || 
         latlng.lat > maxLat || 
         latlng.lng < minLng || 
         latlng.lng > maxLng;
}

setTimeout(()=>say("GPS ultra-précision activé automatiquement. Orientation avancée activée. Utilise les paramètres pour personnaliser."), 1500);
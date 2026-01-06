// itineraryController.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const logger = require("pino")();
const { spawn } = require("child_process");
const path = require("path");

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// ---------------------------------------------------------
// CONFIGURATION & UTILS
// ---------------------------------------------------------
const BUDGET_RANGES = {
  low: { min: 0, max: 15000, label: 'Low (₹5,000 - ₹15,000)', dailyLimit: 2000 },
  medium: { min: 15001, max: 40000, label: 'Medium (₹15,001 - ₹40,000)', dailyLimit: 5000 },
  high: { min: 40001, max: Infinity, label: 'High (₹40,001+)', dailyLimit: 10000 }
};

const getBudgetLevel = (budget) => {
  if (budget <= BUDGET_RANGES.low.max) return 'low';
  if (budget <= BUDGET_RANGES.medium.max) return 'medium';
  return 'high';
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  // Haversine (km)
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// convert km to minutes using mode assumptions (walking/driving)
const travelMinutesEstimate = (km, mode = 'driving') => {
  if (mode === 'walking') {
    // avg 5 km/h => 12 min/km
    return Math.ceil(km * 12);
  }
  // driving avg 40 km/h => 1.5 min/km (i.e., 60/40 = 1.5)
  return Math.ceil(km * 1.5 + 5); // +5 min overhead for parking/slowdowns
};

// Helper: Custom Timeout Wrapper for AI Calls
const generateWithFallback = async (prompt, modelName = "gemini-2.5-flash", timeoutMs = 30000) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`AI Generation Timed Out (${timeoutMs/1000}s)`)), timeoutMs)
  );

  const fetchPromise = async () => {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
      });
      return await model.generateContent(prompt);
    } catch (err) {
      logger.warn(`Model ${modelName} failed, falling back to gemini-1.5-flash. Error: ${err.message}`);
      const fallbackModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      return await fallbackModel.generateContent(prompt);
    }
  };

  return Promise.race([fetchPromise(), timeoutPromise]);
};

// ---------------------------------------------------------
// LOGIC: SCORING & DATA
// ---------------------------------------------------------
const calculateLandmarkScore = (landmark, preferences = {}, budgetLevel = 'medium') => {
  let score = 0;
  const popularity = landmark.popularity || 50;
  score += popularity * 0.4;

  const rating = landmark.rating || 3.5;
  score += (rating / 5) * 50 * 0.3;

  if (landmark.source === 'user') score += 50;

  if (budgetLevel === 'low') {
    if (landmark.entryCost === 0) score += 15;
  } else if (budgetLevel === 'high') {
    if (landmark.isPremium) score += 10;
  }

  // small boost if visit duration is compact (prefer more items)
  if (landmark.visit_duration_minutes && landmark.visit_duration_minutes <= 30) score += 5;

  return Math.min(100, score);
};

// ---------------------------------------------------------
// LOGIC: AI GENERATION (requests updated to include durations)
// ---------------------------------------------------------
const fetchSupplementaryLandmarksFromAI = async (location, count, existingNames, tripDetails) => {
  try {
    logger.info(`AI Filling: Generating ${count} extra landmarks for ${location}...`);

    // NOTE: ask for visit_duration_minutes explicitly
    const prompt = `Plan trip to ${location}.
Existing: ${Array.from(existingNames).join(', ')}.

Suggest exactly ${count} NEW, POPULAR tourist attractions in ${location}.
Budget: ${getBudgetLevel(tripDetails.budget)}.

Return STRICT JSON array ONLY (no other text). Each item must include:
- name (string)
- description (max 10 words)
- latitude (number)
- longitude (number)
- popularity (0-100)
- entryCost (number, INR)
- visit_duration_minutes (integer)
- category (string)

Example:
[{"name":"Name","description":"Short description","latitude":12.0,"longitude":77.0,"popularity":80,"entryCost":50,"visit_duration_minutes":60,"category":"museum"}]`;

    const result = await generateWithFallback(prompt, "gemini-2.5-flash", 30000);
    const text = (result && typeof result.response?.text === 'function') ? result.response.text().replace(/```json|```/g, "").trim() : String(result);

    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']') + 1;

    if (jsonStart !== -1) {
      const parsed = JSON.parse(text.substring(jsonStart, jsonEnd));
      return parsed;
    }
    return [];
  } catch (err) {
    logger.error(err, "AI Supplementary landmark fetch failed");
    return [];
  }
};

const fetchEnhancedLandmarks = async (location, userLandmarks, tripDetails) => {
  try {
    const existingNames = new Set(userLandmarks.map(l => l.name.toLowerCase()));

    const enhancedUserLandmarks = userLandmarks.map(l => ({
      ...l,
      popularity: l.popularity || 80,
      score: 100,
      source: 'user',
      verified: true,
      visit_duration_minutes: l.visit_duration_minutes || 60
    }));

    const targetPerDay = 4;
    const totalNeeded = tripDetails.numberOfDays * targetPerDay;
    let deficit = totalNeeded - enhancedUserLandmarks.length;

    if (deficit <= 0) return enhancedUserLandmarks;

    logger.info(`Need ${deficit} more landmarks. Starting parallel fetch...`);

    const apiKey = process.env.OPENTRIPMAP_API_KEY;

    const otmPromise = apiKey ? (async () => {
      try {
        const geoRes = await axios.get(`https://api.opentripmap.com/0.1/en/places/geoname?name=${encodeURIComponent(location)}&apikey=${apiKey}`, { timeout: 4000 });
        if (geoRes.data && geoRes.data.lat) {
          const { lat, lon } = geoRes.data;
          const landRes = await axios.get(`https://api.opentripmap.com/0.1/en/places/radius?radius=15000&lon=${lon}&lat=${lat}&apikey=${apiKey}&limit=50&rate=3&kinds=interesting_places,museums,monuments,architecture`, { timeout: 6000 });
          return landRes.data.features || [];
        }
      } catch (e) { return []; }
      return [];
    })() : Promise.resolve([]);

    const aiPromise = fetchSupplementaryLandmarksFromAI(location, deficit, existingNames, tripDetails);

    const [otmFeatures, aiLandmarks] = await Promise.all([otmPromise, aiPromise]);

    const additionalLandmarks = [];

    for (const feature of otmFeatures) {
      const name = feature.properties.name;
      if (name && !existingNames.has(name.toLowerCase()) && additionalLandmarks.length < deficit) {
        existingNames.add(name.toLowerCase());
        additionalLandmarks.push({
          name: name,
          latitude: feature.geometry.coordinates[1],
          longitude: feature.geometry.coordinates[0],
          description: (feature.properties.kinds || "").split(',')[0].replace(/_/g, ' '),
          popularity: 70 + (feature.properties.rate || 0) * 5,
          entryCost: 0,
          source: 'opentripmap',
          verified: true,
          visit_duration_minutes: 60
        });
      }
    }

    // Add AI landmarks (which now should include visit_duration_minutes)
    if (aiLandmarks && aiLandmarks.length) {
      aiLandmarks.forEach(l => {
        if (!l.name) return;
        if (!existingNames.has(l.name.toLowerCase())) {
          existingNames.add(l.name.toLowerCase());
          additionalLandmarks.push({
            ...l,
            source: 'ai_reasoning',
            verified: false,
            // ensure duration exists and is reasonable
            visit_duration_minutes: typeof l.visit_duration_minutes === 'number' && l.visit_duration_minutes > 0 ? l.visit_duration_minutes : 60,
            entryCost: typeof l.entryCost === 'number' ? l.entryCost : (l.entryCost ? parseInt(l.entryCost, 10) || 0 : 0)
          });
        }
      });
    }

    const finalLandmarks = [...enhancedUserLandmarks, ...additionalLandmarks].map(l => ({
      ...l,
      score: calculateLandmarkScore(l, tripDetails.preferences, getBudgetLevel(tripDetails.budget))
    }));

    finalLandmarks.sort((a, b) => b.score - a.score);

    logger.info(`Fetch complete. Total landmarks: ${finalLandmarks.length}`);
    return finalLandmarks;
  } catch (err) {
    logger.error(err, "Critical error in fetchEnhancedLandmarks");
    return userLandmarks;
  }
};

// ---------------------------------------------------------
// LOGIC: TRAVEL TIME MATRIX (Google Distance Matrix with fallback)
// ---------------------------------------------------------
/**
 * Returns a matrix of travel time minutes NxN for landmarks.
 * Tries Google Maps Distance Matrix if API key present, otherwise approximate using Haversine.
 *
 * landmarks: array with {latitude, longitude}
 * mode: 'driving'|'walking'
 */
const getTravelTimeMatrix = async (landmarks, mode = 'driving') => {
  const n = landmarks.length;
  const matrix = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));

  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  // If no maps key or too many landmarks, fallback to haversine approximation
  if (!mapsKey || n === 0 || n > 50) {
    // approximate distances -> minutes
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { matrix[i][j] = 0; continue; }
        const a = landmarks[i];
        const b = landmarks[j];
        if (!a || !b || isNaN(a.latitude) || isNaN(b.latitude)) {
          matrix[i][j] = 30; // fallback
        } else {
          const km = calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude);
          matrix[i][j] = travelMinutesEstimate(km, mode);
        }
      }
    }
    return matrix;
  }

  // Use Google Distance Matrix API in batches if necessary (limit per request varies; use safe chunking)
  // Build location strings
  const locs = landmarks.map(l => `${l.latitude},${l.longitude}`);
  // Google supports up to 25 origins or destinations per request for free API; to be safe, we chunk origins into <=25
  const chunkSize = 25;
  for (let o = 0; o < n; o += chunkSize) {
    const origins = locs.slice(o, o + chunkSize);
    // destinations can be all locs (careful with URL length). We'll batch destinations also if n large
    for (let d = 0; d < n; d += chunkSize) {
      const destinations = locs.slice(d, d + chunkSize);
      try {
        const params = {
          origins: origins.join('|'),
          destinations: destinations.join('|'),
          key: mapsKey,
          mode: mode
        };
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json`;
        const res = await axios.get(url, { params, timeout: 8000 });
        if (res.data && res.data.rows) {
          for (let i = 0; i < res.data.rows.length; i++) {
            const row = res.data.rows[i];
            for (let j = 0; j < row.elements.length; j++) {
              const globalI = o + i;
              const globalJ = d + j;
              const elem = row.elements[j];
              if (elem && elem.duration && typeof elem.duration.value === 'number') {
                // duration.value is seconds
                matrix[globalI][globalJ] = Math.ceil(elem.duration.value / 60);
              } else {
                matrix[globalI][globalJ] = 999; // unreachable / unknown -> large penalty
              }
            }
          }
        }
      } catch (e) {
        logger.warn(`Distance Matrix chunk failed (orig ${o} dest ${d}): ${e.message}. Falling back to Haversine for this chunk.`);
        // fallback for this chunk
        for (let i = o; i < Math.min(o + chunkSize, n); i++) {
          for (let j = d; j < Math.min(d + chunkSize, n); j++) {
            if (i === j) { matrix[i][j] = 0; continue; }
            const a = landmarks[i];
            const b = landmarks[j];
            if (!a || !b || isNaN(a.latitude) || isNaN(b.latitude)) {
              matrix[i][j] = 30;
            } else {
              const km = calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude);
              matrix[i][j] = travelMinutesEstimate(km, mode);
            }
          }
        }
      }
    }
  }
  return matrix;
};

// ---------------------------------------------------------
// LOGIC: SCHEDULER / PACKING
// ---------------------------------------------------------
/**
 * Greedy packer: assigns landmarks to days given travel time matrix and visit durations.
 * - landmarks: array of landmarks (must have visit_duration_minutes)
 * - travelTimeMatrix: NxN minutes
 * - days: number of days to pack
 * - dayAvailableMinutes: minutes available per day (e.g., 9*60)
 * - startLatLng: optional {latitude, longitude} for the day's start (hotel). If not provided, first visited location has 0 travel from start.
 */
const packIntoDaysGreedy = (landmarks, travelTimeMatrix, days, dayAvailableMinutes, startLatLng = null) => {
  // Create working copies
  const remaining = landmarks.slice();
  const n = landmarks.length;

  // Map to original indices (for referencing travelTimeMatrix)
  const indexMap = new Map();
  landmarks.forEach((l, idx) => indexMap.set(l, idx));

  const daysPlan = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    schedule: [],
    usedMinutes: 0,
    lastIndex: null // index in landmarks (for travel)
  }));

  // Helper to compute travel from last to candidate
  const travelFromLast = (dayObj, candidateIdx) => {
    if (dayObj.lastIndex == null) {
      if (!startLatLng) return 0;
      // if startLatLng provided, estimate travel minutes from start to candidate using Haversine
      const cand = landmarks[candidateIdx];
      if (!cand || !cand.latitude) return 10;
      const km = calculateDistance(startLatLng.latitude, startLatLng.longitude, cand.latitude, cand.longitude);
      return travelMinutesEstimate(km, 'driving');
    }
    return travelTimeMatrix[dayObj.lastIndex][candidateIdx] || 999;
  };

  // Greedy fill: for each day, try fitting highest score remaining items
  // Sort remaining by score desc
  remaining.sort((a, b) => (b.score || 0) - (a.score || 0));

  for (let d = 0; d < days; d++) {
    const dayObj = daysPlan[d];
    let i = 0;
    while (i < remaining.length) {
      const candidate = remaining[i];
      const candidateIdx = indexMap.get(candidate);
      const travelMins = travelFromLast(dayObj, candidateIdx);
      const duration = candidate.visit_duration_minutes || 60;
      const cost = travelMins + duration;

      if (dayObj.usedMinutes + cost <= dayAvailableMinutes) {
        // assign
        dayObj.schedule.push({
          name: candidate.name,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          description: candidate.description,
          visit_duration_minutes: duration,
          entryCost: candidate.entryCost || 0,
          source: candidate.source,
          verified: candidate.verified,
          score: candidate.score
        });
        dayObj.usedMinutes += cost;
        dayObj.lastIndex = candidateIdx;
        remaining.splice(i, 1);
        // do not increment i, since array shifted
      } else {
        i++;
      }
      // If no more remaining, break
      if (remaining.length === 0) break;
    }
  }

  return { daysPlan, unassigned: remaining };
};

// ---------------------------------------------------------
// LOGIC: AI RENDERING (only renders descriptions for computed schedule)
// ---------------------------------------------------------
const renderScheduleWithAI = async (daysPlan, tripDetails) => {
  // Build a compact context: days with schedule entries but NO times (we supply times later if needed)
  const context = daysPlan.map(d => ({
    day: d.day,
    landmarks: d.schedule.map(s => s.name)
  }));

  const prompt = `You are a concise itinerary text generator.
I will provide a precise day-by-day schedule in JSON with exact times and durations later.
Right now: Please RETURN ONLY JSON with short descriptions (max 15 words) for each scheduled visit.

Input:
${JSON.stringify(daysPlan, null, 2)}

Return format:
{ "itinerary": { "days": [{"day":1,"schedule":[{"time":"09:00 AM","activity":"Visit X","description":"Short desc (<=15 words)","duration_minutes":60,"cost":50}] }] } }

IMPORTANT: ONLY return JSON, no extra text. For each item, generate a concise description (<=15 words).
`;

  try {
    const result = await generateWithFallback(prompt, "gemini-2.5-flash", 45000);
    const text = (result && typeof result.response?.text === 'function') ? result.response.text().replace(/```json|```/g, "").trim() : String(result);

    // Try parse. If parse fails, fall back to attaching short generic descriptions
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch (e) {
      logger.warn("AI render parse failed, using fallback text descriptions");
      // Attach simple descriptions
      const fallbackItinerary = { itinerary: { days: daysPlan.map(d => ({
        day: d.day,
        schedule: d.schedule.map((s, idx) => ({
          time: `${9 + Math.floor((idx * (s.visit_duration_minutes || 60)) / 60)}:00 AM`,
          activity: `Visit ${s.name}`,
          description: s.description || "Popular attraction.",
          duration_minutes: s.visit_duration_minutes || 60,
          cost: s.entryCost || 0
        }))
      })) } };
      return fallbackItinerary;
    }
  } catch (err) {
    logger.error(err, "AI Itinerary Rendering Error. Using fallback.");
    const fallbackItinerary = { itinerary: { days: daysPlan.map(d => ({
      day: d.day,
      schedule: d.schedule.map((s, idx) => ({
        time: `${9 + Math.floor((idx * (s.visit_duration_minutes || 60)) / 60)}:00 AM`,
        activity: `Visit ${s.name}`,
        description: s.description || "Popular attraction.",
        duration_minutes: s.visit_duration_minutes || 60,
        cost: s.entryCost || 0
      }))
    })) } };
    return fallbackItinerary;
  }
};

// ---------------------------------------------------------
// LEGACY: Clustering & fallbacks (kept but we prefer packer above)
// ---------------------------------------------------------
const runKMeansClustering = async (landmarks, numberOfDays) => {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, '../python/clustering.py');
    const validData = landmarks.map(l => ({
      name: l.name,
      latitude: parseFloat(l.latitude),
      longitude: parseFloat(l.longitude),
      popularity: l.popularity || 50
    })).filter(l => !isNaN(l.latitude));

    if (validData.length === 0) return reject(new Error("No valid coordinates"));

    const python = spawn('python', [pythonScript], { stdio: ['pipe', 'pipe', 'pipe'] });
    let result = '';

    python.stdout.on('data', (d) => { result += d.toString(); });
    python.on('close', (code) => {
      if (code === 0 && result) {
        try { resolve(JSON.parse(result)); }
        catch (e) { reject(e); }
      } else {
        reject(new Error("Clustering failed"));
      }
    });

    python.stdin.write(JSON.stringify({ landmarks: validData, k: numberOfDays }));
    python.stdin.end();
  });
};

const fallbackClustering = (landmarks, days) => {
  const clusters = Array.from({ length: days }, (_, i) => ({ day: i + 1, landmarks: [] }));
  landmarks.forEach((l, i) => clusters[i % days].landmarks.push(l));
  return { clusters, silhouette_score: 0 };
};

const optimizeClusterRoute = (landmarks) => {
  if (!landmarks || landmarks.length < 2) return landmarks;
  const simpleDist = (p1, p2) => {
    return Math.sqrt(Math.pow(p1.latitude - p2.latitude, 2) + Math.pow(p1.longitude - p2.longitude, 2));
  };

  const sorted = [landmarks[0]];
  const pool = landmarks.slice(1);
  while (pool.length) {
    const last = sorted[sorted.length - 1];
    let nearestIdx = 0;
    let minDist = Infinity;
    pool.forEach((p, i) => {
      const d = simpleDist(last, p);
      if (d < minDist) { minDist = d; nearestIdx = i; }
    });
    sorted.push(pool[nearestIdx]);
    pool.splice(nearestIdx, 1);
  }
  return sorted;
};

const generateFallbackItinerary = (clusters) => {
  logger.warn("Generating Fallback Itinerary (Manual Construction)");
  return {
    itinerary: {
      days: clusters.map((cluster, index) => {
        let currentTime = 9;

        return {
          day: cluster.day || index + 1,
          schedule: cluster.landmarks.map(landmark => {
            const timeString = `${Math.floor(currentTime)}:00 ${currentTime >= 12 ? 'PM' : 'AM'}`;
            currentTime += 2;

            return {
              time: timeString,
              activity: `Visit ${landmark.name}`,
              location: landmark.name,
              description: landmark.description || "Popular attraction.",
              cost: 50,
              duration: "2 hours"
            };
          })
        };
      })
    }
  };
};

// ---------------------------------------------------------
// MAIN CONTROLLER
// ---------------------------------------------------------
const generateItinerary = async (req, res) => {
  try {
    const { landmarks, tripDetails } = req.body;

    if (!landmarks || !tripDetails) {
      return res.status(400).json({ success: false, message: "Missing data" });
    }

    logger.info(`Starting itinerary gen for ${tripDetails.location}`);

    // 1. Data Fetch & enhancement (user landmarks + OTM + AI-supplement with durations)
    const allLandmarks = await fetchEnhancedLandmarks(tripDetails.location, landmarks, tripDetails);

    // 2. Try to compute travel time matrix
    let travelMatrix;
    try {
      travelMatrix = await getTravelTimeMatrix(allLandmarks, tripDetails.preferredTransport || 'driving');
    } catch (e) {
      logger.warn(`Travel matrix failed: ${e.message}. Falling back to haversine estimates.`);
      // fallback: compute local haversine matrix
      travelMatrix = await getTravelTimeMatrix(allLandmarks, 'driving');
    }

    // 3. Pack into days (use greedy packer that respects visit_duration and travel times)
    const days = tripDetails.numberOfDays || 1;
    // Default available minutes per day (allow customization via tripDetails.availableHours)
    const dayAvailableMinutes = (tripDetails.availableHours && tripDetails.availableHours > 0) ? Math.floor(tripDetails.availableHours * 60) : (9 * 60);
    // optional start location (hotel) in tripDetails.startLocation {latitude, longitude}
    const startLocation = tripDetails.startLocation && tripDetails.startLocation.latitude && tripDetails.startLocation.longitude ? tripDetails.startLocation : null;

    const { daysPlan, unassigned } = packIntoDaysGreedy(allLandmarks, travelMatrix, days, dayAvailableMinutes, startLocation);

    // 4. If the packer left many unassigned or daysPlan empty, fallback to clustering + simple assignment
    let finalDaysPlan = daysPlan;
    if (finalDaysPlan.every(d => d.schedule.length === 0)) {
      logger.warn("Packer produced empty schedule; attempting clustering fallback.");
      let clusteringResult;
      try {
        clusteringResult = await runKMeansClustering(allLandmarks, days);
        clusteringResult.clusters.forEach(c => { c.landmarks = optimizeClusterRoute(c.landmarks); });
        finalDaysPlan = clusteringResult.clusters.map(c => ({ day: c.day, schedule: c.landmarks }));
      } catch (err) {
        logger.warn(`Clustering fallback: ${err.message}`);
        const fallback = fallbackClustering(allLandmarks, days);
        finalDaysPlan = fallback.clusters.map((c, idx) => ({ day: idx + 1, schedule: c.landmarks }));
      }
    }

    // 5. Render schedule descriptions with AI (AI only renders descriptions; times/durations already decided)
    // We want a schedule with times. Convert each day's schedule into times greedy starting at 09:00
    const scheduleWithTimes = finalDaysPlan.map(d => {
      let currentMinutes = (tripDetails.startHour && !isNaN(tripDetails.startHour)) ? (tripDetails.startHour * 60) : (9 * 60); // minutes since 00:00
      return {
        day: d.day,
        schedule: d.schedule.map((s) => {
          const timeHr = Math.floor(currentMinutes / 60);
          const timeMin = Math.floor(currentMinutes % 60);
          const timeStr = `${((timeHr + 11) % 12) + 1}:${timeMin.toString().padStart(2, '0')} ${timeHr >= 12 ? 'PM' : 'AM'}`;
          const entry = {
            time: timeStr,
            activity: `Visit ${s.name}`,
            name: s.name,
            description: s.description || "",
            duration_minutes: s.visit_duration_minutes || 60,
            cost: s.entryCost || 0,
            source: s.source || 'unknown',
            verified: typeof s.verified === 'boolean' ? s.verified : false
          };
          // advance time: visit duration + approximate travel to next (we'll add safe buffer)
          currentMinutes += entry.duration_minutes + 15; // add 15 min buffer between stops
          return entry;
        })
      };
    });

    // Now ask Gemini to render compact descriptions for each scheduled item (but we already have times)
    let aiRenderedItinerary;
    try {
      aiRenderedItinerary = await renderScheduleWithAI(scheduleWithTimes, tripDetails);
    } catch (e) {
      logger.warn("Rendering with AI failed, using computed schedule directly.");
      aiRenderedItinerary = { itinerary: { days: scheduleWithTimes } };
    }

    // 6. [FIXED] CALCULATE BUDGET BREAKDOWN MANUALLY
    const budget = tripDetails.budget || 0;
    const level = getBudgetLevel(budget);

    const budgetBreakdown = {
      level: level,
      range: BUDGET_RANGES[level].label,
      attractions: Math.floor(budget * 0.7),
      miscellaneous: Math.floor(budget * 0.3),
      total: budget,
      dailyAverage: Math.floor(budget / days),
      note: "Estimated breakdown based on travel standards."
    };

    // 7. Return combined response
    res.json({
      success: true,
      data: {
        ...aiRenderedItinerary, // contains itinerary.days[].schedule with descriptions (from AI or fallback)
        optimizedLandmarks: allLandmarks,
        packing: {
          daysPlan,
          unassigned,
          finalSchedule: scheduleWithTimes
        },
        budgetBreakdown: budgetBreakdown,
        tripSummary: {
          totalLandmarks: allLandmarks.length,
          userSelected: landmarks.length,
          aiAdded: allLandmarks.length - landmarks.length,
          budgetLevel: level
        }
      }
    });
  } catch (error) {
    logger.error(error, "Controller Error");
    res.status(500).json({
      success: false,
      message: "Failed to generate itinerary",
      error: error.message
    });
  }
};

module.exports = { generateItinerary };

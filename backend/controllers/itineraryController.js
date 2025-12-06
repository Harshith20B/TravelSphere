const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const logger = require("pino")();
const { spawn } = require('child_process');
const path = require('path');

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
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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
  return Math.min(100, score);
};

// ---------------------------------------------------------
// LOGIC: AI GENERATION
// ---------------------------------------------------------

const fetchSupplementaryLandmarksFromAI = async (location, count, existingNames, tripDetails) => {
  try {
    logger.info(`AI Filling: Generating ${count} extra landmarks for ${location}...`);
    
    const prompt = `Plan trip to ${location}.
    Existing: ${Array.from(existingNames).join(', ')}.
    
    Suggest exactly ${count} NEW, POPULAR tourist attractions in ${location}.
    Budget: ${getBudgetLevel(tripDetails.budget)}.
    
    Return strict JSON Array:
    [{"name": "Name", "description": "Short description (max 10 words)", "latitude": 12.0, "longitude": 77.0, "popularity": 80, "entryCost": 50, "category": "General"}]`;

    const result = await generateWithFallback(prompt, "gemini-2.5-flash", 30000);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']') + 1;
    
    if (jsonStart !== -1) {
      return JSON.parse(text.substring(jsonStart, jsonEnd));
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
      verified: true
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
                description: feature.properties.kinds.split(',')[0].replace(/_/g, ' '),
                popularity: 70 + (feature.properties.rate || 0) * 5,
                source: 'opentripmap',
                verified: true
            });
        }
    }

    const remainingDeficit = totalNeeded - (enhancedUserLandmarks.length + additionalLandmarks.length);
    if (remainingDeficit > 0 || aiLandmarks.length > 0) {
        aiLandmarks.forEach(l => {
            if (!existingNames.has(l.name.toLowerCase())) {
                existingNames.add(l.name.toLowerCase());
                additionalLandmarks.push({
                    ...l,
                    source: 'ai_reasoning',
                    verified: false
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
// LOGIC: CLUSTERING & ITINERARY
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
  if (landmarks.length < 2) return landmarks;
  // Fallback distance calculation since we removed the Google Maps helper to save space
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

const generateEnhancedAIItinerary = async (clusters, tripDetails) => {
  const { location, numberOfDays, budget } = tripDetails;
  
  const clusterContext = clusters.map(c => ({
    day: c.day,
    landmarks: c.landmarks.map(l => l.name).join(", ")
  }));

  const prompt = `Create a ${numberOfDays}-day itinerary for ${location}. Budget: ₹${budget}.
  Schedule EXACTLY these landmarks per day:
  ${JSON.stringify(clusterContext)}
  
  IMPORTANT: Keep descriptions SHORT (under 15 words) to ensure the JSON is not cut off.
  
  JSON format only:
  { "itinerary": { "days": [{ "day": 1, "schedule": [{ "time": "09:00 AM", "activity": "Visit X", "description": "Short description...", "cost": 100, "duration": "1.5 hours" }] }] } }`;

  try {
    const result = await generateWithFallback(prompt, "gemini-2.5-flash", 90000);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    
    try {
        return JSON.parse(text);
    } catch (parseError) {
        logger.error("JSON Parse Failed. Using Fallback.");
        return generateFallbackItinerary(clusters);
    }
  } catch (err) {
    logger.error(err, "AI Itinerary Generation Error. Using Fallback.");
    return generateFallbackItinerary(clusters);
  }
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

    // 1. Data Fetch
    const allLandmarks = await fetchEnhancedLandmarks(tripDetails.location, landmarks, tripDetails);

    // 2. Clustering
    let clusteringResult;
    try {
      clusteringResult = await runKMeansClustering(allLandmarks, tripDetails.numberOfDays);
    } catch (err) {
      logger.warn(`Clustering fallback: ${err.message}`);
      clusteringResult = fallbackClustering(allLandmarks, tripDetails.numberOfDays);
    }

    // 3. Optimization
    clusteringResult.clusters.forEach(c => {
      c.landmarks = optimizeClusterRoute(c.landmarks);
    });

    // 4. AI Generation
    const finalItinerary = await generateEnhancedAIItinerary(clusteringResult.clusters, tripDetails);

    // 5. [FIXED] CALCULATE BUDGET BREAKDOWN MANUALLY
    // The frontend relies on this object existing.
    const budget = tripDetails.budget || 0;
    const days = tripDetails.numberOfDays || 1;
    const level = getBudgetLevel(budget);
    
    const budgetBreakdown = {
        level: level,
        range: BUDGET_RANGES[level].label,
        attractions: Math.floor(budget * 0.7), // 70% allocation estimate
        miscellaneous: Math.floor(budget * 0.3), // 30% allocation estimate
        total: budget,
        dailyAverage: Math.floor(budget / days),
        note: "Estimated breakdown based on travel standards."
    };

    // 6. Response
    res.json({
      success: true,
      data: {
        ...finalItinerary,
        optimizedLandmarks: allLandmarks,
        budgetBreakdown: budgetBreakdown, // <--- ADDED THIS FIELD
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
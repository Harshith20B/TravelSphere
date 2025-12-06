// Updated backend API endpoint using Gemini
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const logger = require('pino')();

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

const getLandmarksFromGemini = async (location, radius) => {
  try {
    // UPDATED: Using Gemini 2.5 Flash with higher output token capacity
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192, // Increased for 2.5 Flash capabilities
        topP: 0.8,
      }
    });

    const prompt = `Provide a list of ${radius < 10 ? '10-15' : '15-20'} popular landmarks and tourist attractions within ${radius} km of ${location}. 
    For each landmark, include:
    - Name
    - Brief description (1 sentence)
    - Type (monument, museum, park, etc.)
    - Approximate latitude and longitude
    
    Format the response as a JSON array like this:
    [
      {
        "name": "Landmark Name",
        "description": "Brief description",
        "type": "landmark type",
        "latitude": 12.3456,
        "longitude": 78.9012
      }
    ]
    
    Only return valid JSON with no additional text or markdown.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Clean and parse JSON response
    let cleanResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonStart = cleanResponse.indexOf('[');
    const jsonEnd = cleanResponse.lastIndexOf(']') + 1;
    
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      return JSON.parse(cleanResponse.substring(jsonStart, jsonEnd));
    }
    
    throw new Error('Invalid JSON response from AI');
  } catch (error) {
    logger.error('Error fetching landmarks from Gemini:', error);
    return [];
  }
};

const fetchImageFromPexels = async (query) => {
  try {
    const response = await axios.get('https://api.pexels.com/v1/search', {
      params: {
        query: `${query} landmark`,
        per_page: 1,
        orientation: 'landscape'
      },
      headers: {
        'Authorization': process.env.PEXELS_API_KEY
      },
      timeout: 5000
    });

    return response.data.photos?.[0]?.src?.medium || null;
  } catch (error) {
    logger.error('Error fetching from Pexels:', error.message);
    return null;
  }
};

const getLandmarksWithImages = async (req, res) => {
  const { location, radius } = req.query;

  try {
    // First get landmarks from Gemini
    const landmarks = await getLandmarksFromGemini(location, radius);
    
    if (!landmarks.length) {
      return res.status(404).json({ 
        message: 'No landmarks found for this location',
        suggestions: ['Try a larger radius', 'Check the spelling of the location']
      });
    }

    // Get images for each landmark
    const landmarksWithImages = await Promise.all(landmarks.map(async landmark => {
      let imageUrl = await fetchImageFromPexels(landmark.name);
      
      if (!imageUrl) {
        // Try with location name if specific landmark image not found
        imageUrl = await fetchImageFromPexels(`${landmark.name} ${location}`);
      }
      
      return {
        ...landmark,
        imageUrl: imageUrl || generateStyledPlaceholder(landmark.name),
        _id: `landmark-${landmark.name.toLowerCase().replace(/\s+/g, '-')}`
      };
    }));

    res.json(landmarksWithImages);
  } catch (error) {
    logger.error("Error fetching landmarks:", error.message);
    res.status(500).json({ 
      message: 'Error fetching landmarks',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = { getLandmarksWithImages };
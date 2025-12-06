// controllers/landmarkController.js

const Landmark = require('../models/Landmark');
const Landmark2 = require('../models/Landmark2');
// Function to get most visited landmarks
const getMostVisitedLandmarks = async (req, res) => {
  try {
    const landmarks = await Landmark.find().sort({ visits: -1 }).limit(9); // Top 9 most visited landmarks
    res.json(landmarks);
  } catch (error) {
    console.error("Error fetching landmarks:", error);
    res.status(500).json({ message: 'Error fetching landmarks' });
  }
};
const searchLandmarks2 = async (req, res) => {
  const { location, radius } = req.query;
  
  try {
    // Convert the radius to a number (in kilometers)
    const radiusInKm = parseFloat(radius);

    // Find landmarks with the specified location and radius
    const landmarks = await Landmark2.find({
      location: location, // Match the given location
      radius: { $lte: radiusInKm }, // Find landmarks within the specified radius
    });

    res.json(landmarks);
  } catch (error) {
    console.error("Error fetching landmarks:", error);
    res.status(500).json({ message: 'Error fetching landmarks' });
  }
};
// Function to get details of a specific landmark by ID
const getLandmarkDetails = async (req, res) => {
  const { id } = req.params;  // Extract the landmark ID from the request parameters

  try {
    // Fetch the landmark by its ID
    const landmark = await Landmark.findById(id);

    // If the landmark is not found, return a 404 error
    if (!landmark) {
      return res.status(404).json({ message: 'Landmark not found' });
    }

    // Return the landmark details as a JSON response
    res.json(landmark);
  } catch (error) {
    console.error("Error fetching landmark details:", error);
    res.status(500).json({ message: 'Error fetching landmark details' });
  }
};

module.exports = { getMostVisitedLandmarks, getLandmarkDetails, searchLandmarks2 };
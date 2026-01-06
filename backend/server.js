/**
 * Express server for TravelSphere backend
 * Clean CORS config to allow all origins dynamically with credentials
 */
 //travelo\Scripts\activate
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const landmarkRoutes = require('./routes/landmarkRoutes');
const exploreRoutes = require('./routes/exploreRoutes');
const productRoutes = require('./routes/productRoutes');
const travelPlanRoutes = require('./routes/travelPlanRoutes');
const userRoutes = require('./routes/userRoutes');
const postsRoutes = require('./routes/postsRoutes');

dotenv.config();

const app = express();

/**
 * ✅ Proper CORS setup
 * Allows ANY origin dynamically while supporting credentials
 * Required because Vercel preview URLs change on each deploy
 */
app.use(cors({
  origin: (origin, callback) => {
    // Dynamically allow any origin if present
    if (!origin) return callback(null, true);
    callback(null, origin);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());


// Handle preflight requests
app.options('*', cors());

// Body parser
app.use(express.json({ limit: '50mb' }));

/**
 * ✅ ROUTES
 */
app.use('/api', productRoutes);
app.use('/api/travelplans', travelPlanRoutes);
app.use('/api/explore', exploreRoutes);
app.use('/api/landmarks', landmarkRoutes);
app.use('/api/user', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/social', postsRoutes);

/**
 * ✅ ERROR HANDLING
 */
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

/**
 * ✅ SERVE FRONTEND (Optional)
 * If you're also deploying static frontend from backend
 */
const buildPath = path.join(__dirname, 'build');
app.use(express.static(buildPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

/**
 * ✅ DATABASE CONNECTION AND SERVER START
 */
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  });

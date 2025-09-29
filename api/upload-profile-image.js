// api/upload-profile-image.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const { userId, imageData } = JSON.parse(body);
        
        console.log('DEBUG_UPLOAD: Received upload request');
        console.log('DEBUG_UPLOAD: userId:', userId);
        console.log('DEBUG_UPLOAD: imageData length:', imageData?.length);
        console.log('DEBUG_UPLOAD: imageData starts with:', imageData?.substring(0, 50));
        
        if (!userId || !imageData) {
          console.log('DEBUG_UPLOAD: Missing userId or imageData');
          return res.status(400).json({
            success: false,
            message: 'User ID and image data are required'
          });
        }

        // Validate base64 image data
        if (!imageData.startsWith('data:image/')) {
          console.log('DEBUG_UPLOAD: Invalid image format');
          return res.status(400).json({
            success: false,
            message: 'Invalid image format. Please provide base64 image data'
          });
        }

        // Check image size (limit to 2MB to prevent database bloat)
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageSize = (base64Data.length * 3) / 4; // Approximate size in bytes
        
        if (imageSize > 2 * 1024 * 1024) { // 2MB limit
          console.log('DEBUG_UPLOAD: Image too large:', imageSize);
          return res.status(400).json({
            success: false,
            message: 'Image too large. Please use images smaller than 2MB'
          });
        }

        console.log('DEBUG_UPLOAD: Image validation passed, returning base64 data');
        
        // For base64 storage, we just return the base64 string
        return res.status(200).json({
          success: true,
          imageUrl: imageData, // Return the base64 string as "imageUrl"
          message: 'Image processed successfully. Ready to save to profile.'
        });

      } catch (parseError) {
        console.log('DEBUG_UPLOAD: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Upload image error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process image',
      error: error.message
    });
  }
};
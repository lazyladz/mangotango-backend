const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

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

// ✅ Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

        console.log('DEBUG_UPLOAD: userId:', userId);

        if (!userId || !imageData) {
          return res.status(400).json({
            success: false,
            message: 'User ID and image data are required'
          });
        }

        if (!imageData.startsWith('data:image/')) {
          return res.status(400).json({
            success: false,
            message: 'Invalid image format. Please provide base64 image data'
          });
        }

        // ✅ Upload to Cloudinary
        const uploadResult = await cloudinary.uploader.upload(imageData, {
          folder: 'profile_images'
        });

        // ✅ Save only URL to Firebase
        await db.ref(`users/${userId}`).update({ profileImage: uploadResult.secure_url });

        return res.status(200).json({
  success: true,
  message: 'Profile image updated successfully',
  imageUrl: uploadResult.secure_url   // 👈 matches Android code
});

      } catch (parseError) {
        console.error('JSON Parse error:', parseError);
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

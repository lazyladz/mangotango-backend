const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

// ✅ Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
        const { 
          userId, 
          name, 
          email, 
          address, 
          phonenumber,
          profileImage
        } = JSON.parse(body);

        console.log('DEBUG_UPDATE: Received update request');
        console.log('DEBUG_UPDATE: userId:', userId);
        console.log('DEBUG_UPDATE: name:', name);
        console.log('DEBUG_UPDATE: profileImage length:', profileImage?.length);
        console.log('DEBUG_UPDATE: profileImage starts with:', profileImage?.substring(0, 50));

        // Validate required fields
        if (!userId || !name || !email) {
          console.log('DEBUG_UPDATE: Missing required fields');
          return res.status(400).json({
            success: false,
            message: 'User ID, name, and email are required'
          });
        }

        // Check if user exists
        const userSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!userSnapshot.exists()) {
          console.log('DEBUG_UPDATE: User not found:', userId);
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        // ✅ Upload to Cloudinary if profileImage is base64
        let uploadedImageUrl = '';
        if (profileImage && profileImage.startsWith('data:image/')) {
          try {
            const uploadResult = await cloudinary.uploader.upload(profileImage, {
              folder: 'profile_images'
            });
            uploadedImageUrl = uploadResult.secure_url;
            console.log('DEBUG_UPDATE: Uploaded image to Cloudinary:', uploadedImageUrl);
          } catch (cloudErr) {
            console.error('DEBUG_UPDATE: Cloudinary upload failed:', cloudErr);
          }
        }

        // Update user data
        const updatedData = {
          name: name,
          email: email,
          address: address || '',
          phonenumber: phonenumber || '',
          profileImage: uploadedImageUrl || profileImage || '',
          updatedAt: Date.now()
        };

        console.log('DEBUG_UPDATE: Updating database with:', {
          ...updatedData,
          profileImage: updatedData.profileImage ? `${updatedData.profileImage.substring(0, 50)}...` : 'empty'
        });

        await db.ref(`users/${userId}`).update(updatedData);

        console.log('DEBUG_UPDATE: Database update successful');

        return res.status(200).json({
          success: true,
          message: 'Profile updated successfully',
          user: {
            userId: userId,
            name: name,
            email: email,
            address: address,
            phonenumber: phonenumber,
            profileImage: updatedData.profileImage
          }
        });

      } catch (parseError) {
        console.log('DEBUG_UPDATE: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

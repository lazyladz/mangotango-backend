const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

// Initialize Firebase Admin if not already initialized
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

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const db = admin.database();

module.exports = async (req, res) => {
  // CORS headers
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
        const requestData = JSON.parse(body);
        const { action, userId, ...otherData } = requestData;

        console.log('DEBUG_PROFILE: Action:', action);
        console.log('DEBUG_PROFILE: UserId:', userId);

        if (!action) {
          return res.status(400).json({
            success: false,
            message: 'Action is required (get, update, or updateImage)'
          });
        }

        if (!userId) {
          return res.status(400).json({
            success: false,
            message: 'User ID is required'
          });
        }

        // Check if user exists
        const userSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!userSnapshot.exists()) {
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        let result;

        switch (action) {
          case 'get':
            result = await handleGetProfile(userId, userSnapshot);
            break;

          case 'update':
            result = await handleUpdateProfile(userId, otherData);
            break;

          case 'updateImage':
            result = await handleUpdateImage(userId, otherData);
            break;

          default:
            return res.status(400).json({
              success: false,
              message: 'Invalid action. Use: get, update, or updateImage'
            });
        }

        return res.status(200).json(result);

      } catch (parseError) {
        console.log('DEBUG_PROFILE: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Profile API error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Handle get profile
async function handleGetProfile(userId, userSnapshot) {
  const userData = userSnapshot.val();

  return {
    success: true,
    message: 'Profile data retrieved successfully',
    user: {
      userId: userId,
      name: userData.name || '',
      email: userData.email || '',
      address: userData.address || '',
      phonenumber: userData.phonenumber || '',
      profileImage: userData.profileImage || '',
      language: userData.language || '',
      age: userData.age || '',
      role: userData.role || 'User'
    }
  };
}

// Handle update profile
async function handleUpdateProfile(userId, data) {
  const { name, email, address, phonenumber, profileImage } = data;

  console.log('DEBUG_PROFILE_UPDATE: Received update data');
  console.log('DEBUG_PROFILE_UPDATE: name:', name);
  console.log('DEBUG_PROFILE_UPDATE: profileImage length:', profileImage?.length);
  console.log('DEBUG_PROFILE_UPDATE: profileImage starts with:', profileImage?.substring(0, 50));

  // Validate required fields
  if (!name || !email) {
    console.log('DEBUG_PROFILE_UPDATE: Missing required fields');
    return {
      success: false,
      message: 'Name and email are required'
    };
  }

  // Upload to Cloudinary if profileImage is base64
  let uploadedImageUrl = '';
  if (profileImage && profileImage.startsWith('data:image/')) {
    try {
      const uploadResult = await cloudinary.uploader.upload(profileImage, {
        folder: 'profile_images'
      });
      uploadedImageUrl = uploadResult.secure_url;
      console.log('DEBUG_PROFILE_UPDATE: Uploaded image to Cloudinary:', uploadedImageUrl);
    } catch (cloudErr) {
      console.error('DEBUG_PROFILE_UPDATE: Cloudinary upload failed:', cloudErr);
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

  console.log('DEBUG_PROFILE_UPDATE: Updating database with:', {
    ...updatedData,
    profileImage: updatedData.profileImage ? `${updatedData.profileImage.substring(0, 50)}...` : 'empty'
  });

  await db.ref(`users/${userId}`).update(updatedData);

  console.log('DEBUG_PROFILE_UPDATE: Database update successful');

  return {
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
  };
}

// Handle update image only
async function handleUpdateImage(userId, data) {
  const { imageData } = data;

  console.log('DEBUG_PROFILE_IMAGE: userId:', userId);

  if (!imageData) {
    return {
      success: false,
      message: 'Image data is required'
    };
  }

  if (!imageData.startsWith('data:image/')) {
    return {
      success: false,
      message: 'Invalid image format. Please provide base64 image data'
    };
  }

  // Upload to Cloudinary
  const uploadResult = await cloudinary.uploader.upload(imageData, {
    folder: 'profile_images'
  });

  // Save only URL to Firebase
  await db.ref(`users/${userId}`).update({ 
    profileImage: uploadResult.secure_url,
    updatedAt: Date.now()
  });

  return {
    success: true,
    message: 'Profile image updated successfully',
    imageUrl: uploadResult.secure_url
  };
}
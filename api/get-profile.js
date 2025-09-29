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
        const { userId } = JSON.parse(body);

        if (!userId) {
          return res.status(400).json({
            success: false,
            message: 'User ID is required'
          });
        }

        // Get user data from Realtime Database
        const userSnapshot = await db.ref(`users/${userId}`).once('value');
        
        if (!userSnapshot.exists()) {
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        const userData = userSnapshot.val();

        return res.status(200).json({
  success: true,
  message: 'Profile data retrieved successfully',
  user: {
    userId: userId,
    name: userData.name || '',
    email: userData.email || '',
    address: userData.address || '',
    phonenumber: userData.phonenumber || '',
    profileImage: userData.profileImage || '', // ADD THIS LINE
    language: userData.language || '',
    age: userData.age || '',
    role: userData.role || 'User'
  }
});


      } catch (parseError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
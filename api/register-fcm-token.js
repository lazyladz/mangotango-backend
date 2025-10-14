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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId, fcmToken, platform, userName, appVersion, timestamp } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'userId and fcmToken are required' 
      });
    }

    console.log(`📱 Registering FCM token for user: ${userId} (${userName || 'Unknown'})`);

    // Store token in Realtime Database
    await db.ref(`user_tokens/${userId}`).set({
      fcmToken: fcmToken,
      platform: platform || 'android',
      userName: userName || 'Unknown User',
      appVersion: appVersion || '1.0.0',
      lastUpdated: timestamp || Date.now(),
      registeredAt: Date.now()
    });

    console.log(`✅ FCM token stored for user: ${userId}`);
    console.log(`📱 Platform: ${platform || 'android'}`);
    console.log(`🔑 Token: ${fcmToken.substring(0, 10)}...`);

    return res.status(200).json({
      success: true,
      message: 'FCM token registered successfully',
      userId: userId
    });

  } catch (error) {
    console.error('❌ Token registration error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to register FCM token',
      error: error.message 
    });
  }
};
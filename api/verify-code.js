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
        const { userId, code } = JSON.parse(body);

        if (!userId || !code) {
          return res.status(400).json({
            success: false,
            message: 'User ID and code are required'
          });
        }

        const resetRef = db.ref(`password_reset_codes/${userId}`);
        const snapshot = await resetRef.once('value');

        if (!snapshot.exists()) {
          return res.status(404).json({
            success: false,
            message: 'Code not found. Please request a new one.'
          });
        }

        const resetData = snapshot.val();
        const storedCode = resetData.code;
        const expirationTime = resetData.expirationTime || 0;
        const isUsed = resetData.used || false;
        const currentTime = Date.now();

        if (isUsed) {
          return res.status(400).json({
            success: false,
            message: 'This code has already been used'
          });
        }

        if (currentTime > expirationTime) {
          return res.status(400).json({
            success: false,
            message: 'This code has expired. Please request a new one.'
          });
        }

        if (storedCode !== code) {
          return res.status(400).json({
            success: false,
            message: 'Invalid code. Please try again.'
          });
        }

        await resetRef.update({ used: true });

        return res.status(200).json({
          success: true,
          message: 'Code verified successfully!',
          data: {
            userId: userId,
            verified: true
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
    console.error('Verify code error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
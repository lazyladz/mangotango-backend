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

const auth = admin.auth();
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
          oldPassword, 
          newPassword 
        } = JSON.parse(body);

        // Validate required fields
        if (!userId || !oldPassword || !newPassword) {
          return res.status(400).json({
            success: false,
            message: 'User ID, old password, and new password are required'
          });
        }

        if (newPassword.length < 6) {
          return res.status(400).json({
            success: false,
            message: 'Password must be at least 6 characters'
          });
        }

        // Get user email from database
        const userSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!userSnapshot.exists()) {
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        const userData = userSnapshot.val();
        const userEmail = userData.email;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: 'User email not found'
          });
        }

        try {
          // Verify old password by attempting to sign in
          const firebaseResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: userEmail,
              password: oldPassword,
              returnSecureToken: true
            })
          });

          const authResult = await firebaseResponse.json();

          if (!authResult.idToken) {
            return res.status(401).json({
              success: false,
              message: 'Current password is incorrect'
            });
          }

          // Old password is correct, update to new password
          await auth.updateUser(userId, {
            password: newPassword
          });

          // Also update in Realtime Database if you store passwords there
          await db.ref(`users/${userId}/password`).set(newPassword);

          return res.status(200).json({
            success: true,
            message: 'Password updated successfully',
            data: {
              userId: userId,
              passwordUpdated: true
            }
          });

        } catch (authError) {
          console.error('Auth error:', authError);
          return res.status(401).json({
            success: false,
            message: 'Current password is incorrect'
          });
        }

      } catch (parseError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Change password error:', error);
    
    if (error.code === 'auth/weak-password') {
      return res.status(400).json({
        success: false,
        message: 'Password is too weak'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
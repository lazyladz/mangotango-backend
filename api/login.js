const admin = require('firebase-admin');

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

const auth = admin.auth();
const db = admin.database();

module.exports = async (req, res) => {
  // Enable CORS
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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Step 1: Verify password using Firebase REST API
    const firebaseResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        password: password,
        returnSecureToken: true
      })
    });

    const authResult = await firebaseResponse.json();

    if (!authResult.idToken) {
      return res.status(401).json({
        success: false,
        message: 'Login failed: ' + (authResult.error?.message || 'Invalid credentials')
      });
    }

    const userId = authResult.localId;

    // Step 2: Use Admin SDK to get user data from Realtime Database
    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    let userData = userSnapshot.val();

    console.log('DEBUG_LOGIN: User data from database:', userData);

    if (!userData) {
      return res.status(404).json({
        success: false,
        message: 'User data not found'
      });
    }

    // 🔥 CRITICAL FIX: Ensure user has a proper name
    let userName = userData.name || '';
    
    // If name is empty, "User", or missing, set a proper name
    if (!userName || userName.trim() === '' || userName === 'User') {
      console.log('DEBUG_LOGIN: User has invalid name, setting proper name');
      
      // Use email prefix as name, or a default
      userName = email.split('@')[0] || 'App User';
      
      // Update the database with the proper name
      await db.ref(`users/${userId}`).update({
        name: userName,
        updatedAt: Date.now()
      });
      
      console.log('DEBUG_LOGIN: Updated user name to:', userName);
      
      // Update the userData for response
      userData.name = userName;
    }

    console.log('DEBUG_LOGIN: Final user name:', userName);

    // Step 3: Return success response with user data
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        userId: userId,
        idToken: authResult.idToken,
        refreshToken: authResult.refreshToken,
        name: userName, // Use the validated name
        email: userData.email || '',
        address: userData.address || '',
        language: userData.language || '',
        age: userData.age || '',
        phonenumber: userData.phonenumber || '',
        profileImage: userData.profileImage || ''
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
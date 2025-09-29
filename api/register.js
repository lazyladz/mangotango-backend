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
          name, 
          address, 
          language, 
          email, 
          password, 
          confirmPassword, 
          age, 
          phone 
        } = JSON.parse(body);

        // Validate required fields
        if (!email || !password || !name) {
          return res.status(400).json({
            success: false,
            message: 'Name, email, and password are required'
          });
        }

        if (password !== confirmPassword) {
          return res.status(400).json({
            success: false,
            message: 'Passwords do not match'
          });
        }

        if (password.length < 6) {
          return res.status(400).json({
            success: false,
            message: 'Password must be at least 6 characters'
          });
        }

        // Check if email already exists
        try {
          await auth.getUserByEmail(email);
          return res.status(400).json({
            success: false,
            message: 'Email already registered'
          });
        } catch (error) {
          // Email doesn't exist, continue with registration
        }

        // Create user in Firebase Auth
        const userRecord = await auth.createUser({
          email: email,
          password: password,
          displayName: name,
          emailVerified: false
        });

        const userId = userRecord.uid;

        // Save user data in Realtime Database
        const userData = {
          name: name || '',
          address: address || '',
          language: language || '',
          email: email || '',
          age: age || '',
          phonenumber: phone || '',
          createdAt: Date.now()
        };

        await db.ref(`users/${userId}`).set(userData);

        return res.status(200).json({
          success: true,
          message: 'Registration successful!',
          user: {
            userId: userId,
            email: email,
            name: name,
            address: address,
            language: language,
            age: age,
            phonenumber: phone
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
    console.error('Registration error:', error);
    
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }
    
    if (error.code === 'auth/invalid-email') {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address'
      });
    }
    
    if (error.code === 'auth/weak-password') {
      return res.status(400).json({
        success: false,
        message: 'Password is too weak'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message
    });
  }
};
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
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const requestData = JSON.parse(body);
        const { action } = requestData;

        console.log('AUTH_API: Received request -', { action });

        if (!action) {
          return res.status(400).json({
            success: false,
            message: 'Action is required (login or register)'
          });
        }

        switch (action) {
          case 'login':
            await handleLogin(requestData, res);
            break;
          
          case 'register':
            await handleRegister(requestData, res);
            break;
          
          default:
            return res.status(400).json({
              success: false,
              message: 'Invalid action. Supported actions: login, register'
            });
        }

      } catch (parseError) {
        console.error('AUTH_API: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('AUTH_API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// LOGIN - Handle user login
async function handleLogin(requestData, res) {
  try {
    const { email, password } = requestData;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    console.log('AUTH_API: Login attempt for email:', email);

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
      console.log('AUTH_API: Login failed -', authResult.error?.message);
      
      // Check if email exists first
      try {
        // Try to get user by email to see if email exists
        const userRecord = await auth.getUserByEmail(email);
        
        // If we reach here, email exists but password is wrong
        return res.status(401).json({
          success: false,
          message: 'wrong_password'
        });
      } catch (emailError) {
        // Email doesn't exist in Firebase Auth
        if (emailError.code === 'auth/user-not-found') {
          return res.status(401).json({
            success: false,
            message: 'email_not_found'
          });
        }
        
        // Some other error occurred
        return res.status(401).json({
          success: false,
          message: 'Login failed: ' + (authResult.error?.message || 'Invalid credentials')
        });
      }
    }

    const userId = authResult.localId;

    // Step 2: Get user data from Realtime Database
    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    let userData = userSnapshot.val();

    console.log('AUTH_API: User data from database:', userData);

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
      console.log('AUTH_API: User has invalid name, setting proper name');
      
      // Use email prefix as name, or a default
      userName = email.split('@')[0] || 'App User';
      
      // Update the database with the proper name
      await db.ref(`users/${userId}`).update({
        name: userName,
        updatedAt: Date.now()
      });
      
      console.log('AUTH_API: Updated user name to:', userName);
      
      // Update the userData for response
      userData.name = userName;
    }

    console.log('AUTH_API: Login successful for user:', userName);

    // Step 3: Return success response with user data
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        userId: userId,
        idToken: authResult.idToken,
        refreshToken: authResult.refreshToken,
        name: userName,
        email: userData.email || '',
        address: userData.address || '',
        language: userData.language || '',
        age: userData.age || '',
        phonenumber: userData.phonenumber || '',
        profileImage: userData.profileImage || ''
      }
    });

  } catch (error) {
    console.error('AUTH_API: Login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message
    });
  }
}

// REGISTER - Handle user registration
async function handleRegister(requestData, res) {
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
    } = requestData;

    console.log('AUTH_API: Registration attempt for email:', email);

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
      profileImage: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await db.ref(`users/${userId}`).set(userData);

    console.log('AUTH_API: Registration successful for user:', name);

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

  } catch (error) {
    console.error('AUTH_API: Registration error:', error);
    
    // Handle specific Firebase Auth errors
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
}
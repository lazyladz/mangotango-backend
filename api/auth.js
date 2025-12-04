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
          
          case 'cleanup-duplicates':
            await handleCleanupDuplicates(requestData, res);
            break;
          
          default:
            return res.status(400).json({
              success: false,
              message: 'Invalid action. Supported actions: login, register, cleanup-duplicates'
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

// ==================== HELPER FUNCTIONS ====================

async function findUserByEmail(email) {
  try {
    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();
    
    // First check if email exists in Firebase Auth
    try {
      const authUser = await auth.getUserByEmail(normalizedEmail);
      return {
        exists: true,
        userId: authUser.uid,
        source: 'auth',
        userRecord: authUser
      };
    } catch (authError) {
      // Email not in Firebase Auth, check database
      const usersRef = db.ref('users');
      const snapshot = await usersRef.once('value');
      const users = snapshot.val();
      
      if (users) {
        for (const [userId, userData] of Object.entries(users)) {
          if (userData?.email && userData.email.toLowerCase().trim() === normalizedEmail) {
            return {
              exists: true,
              userId: userId,
              source: 'database',
              userData: userData
            };
          }
        }
      }
      
      return { exists: false };
    }
  } catch (error) {
    console.error('findUserByEmail error:', error);
    return { exists: false, error: error.message };
  }
}

async function mergeDuplicateAccounts(mainUserId, duplicateUserId) {
  console.log(`Merging ${duplicateUserId.substring(0, 8)}... into ${mainUserId.substring(0, 8)}...`);
  
  try {
    // Get data from duplicate account
    const duplicateUserRef = db.ref(`users/${duplicateUserId}`);
    const duplicateUserSnapshot = await duplicateUserRef.once('value');
    const duplicateUserData = duplicateUserSnapshot.val();
    
    const duplicateTokenRef = db.ref(`user_tokens/${duplicateUserId}`);
    const duplicateTokenSnapshot = await duplicateTokenRef.once('value');
    const duplicateTokenData = duplicateTokenSnapshot.val();
    
    // Get main account data
    const mainUserRef = db.ref(`users/${mainUserId}`);
    const mainUserSnapshot = await mainUserRef.once('value');
    const mainUserData = mainUserSnapshot.val() || {};
    
    const mainTokenRef = db.ref(`user_tokens/${mainUserId}`);
    const mainTokenSnapshot = await mainTokenRef.once('value');
    const mainTokenData = mainTokenSnapshot.val();
    
    // Merge user data (keep non-empty fields from duplicate)
    const mergedUserData = { ...mainUserData };
    
    // Fields to merge (prefer duplicate's data if main is empty)
    const fieldsToMerge = ['name', 'address', 'language', 'age', 'phonenumber', 'profileImage', 'preferredCity'];
    
    fieldsToMerge.forEach(field => {
      if (duplicateUserData?.[field] && (!mainUserData[field] || mainUserData[field] === '')) {
        mergedUserData[field] = duplicateUserData[field];
      }
    });
    
    // Update main user data
    await mainUserRef.update({
      ...mergedUserData,
      mergedFrom: duplicateUserId,
      mergedAt: Date.now(),
      updatedAt: Date.now()
    });
    
    // Merge tokens (keep the most recent token)
    if (duplicateTokenData?.fcmToken) {
      const shouldReplaceToken = !mainTokenData?.fcmToken || 
        (duplicateTokenData.updatedAt > (mainTokenData.updatedAt || 0));
      
      if (shouldReplaceToken) {
        await mainTokenRef.set({
          fcmToken: duplicateTokenData.fcmToken,
          updatedAt: duplicateTokenData.updatedAt || Date.now(),
          mergedFrom: duplicateUserId
        });
      }
    }
    
    // Delete duplicate account
    await duplicateUserRef.remove();
    await duplicateTokenRef.remove();
    
    // Try to delete from Firebase Auth too
    try {
      await auth.deleteUser(duplicateUserId);
    } catch (authError) {
      // User might not exist in Auth, that's fine
      console.log('Note: Could not delete duplicate from Auth:', authError.message);
    }
    
    console.log(`✅ Successfully merged accounts`);
    return { success: true, mainUserId, duplicateUserId };
    
  } catch (error) {
    console.error('Merge error:', error);
    return { success: false, error: error.message };
  }
}

// ==================== LOGIN FUNCTION ====================
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

    // Step 1: Check for duplicate accounts BEFORE login
    const emailCheck = await findUserByEmail(email);
    
    if (emailCheck.exists && emailCheck.source === 'database' && emailCheck.userId) {
      // Email exists in database but not in Auth - this is an orphaned account
      console.log('AUTH_API: Found orphaned account in database:', emailCheck.userId);
      
      // We'll handle this after successful auth
    }

    // Step 2: Verify password using Firebase REST API
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

    const loggedInUserId = authResult.localId;

    // Step 3: Check for and merge duplicate accounts
    const normalizedEmail = email.toLowerCase().trim();
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();
    
    let duplicateUserIds = [];
    
    if (users) {
      for (const [userId, userData] of Object.entries(users)) {
        if (userId !== loggedInUserId && 
            userData?.email && 
            userData.email.toLowerCase().trim() === normalizedEmail) {
          duplicateUserIds.push(userId);
        }
      }
    }
    
    // Merge any duplicates found
    if (duplicateUserIds.length > 0) {
      console.log(`AUTH_API: Found ${duplicateUserIds.length} duplicate accounts for ${email}`);
      
      for (const duplicateUserId of duplicateUserIds) {
        await mergeDuplicateAccounts(loggedInUserId, duplicateUserId);
      }
    }

    // Step 4: Get user data from Realtime Database
    const userSnapshot = await db.ref(`users/${loggedInUserId}`).once('value');
    let userData = userSnapshot.val();

    console.log('AUTH_API: User data from database:', userData);

    // If no user data exists in database, create it
    if (!userData) {
      console.log('AUTH_API: No user data found, creating default profile');
      
      // Get user info from Firebase Auth
      const authUser = await auth.getUser(loggedInUserId);
      
      userData = {
        name: authUser.displayName || email.split('@')[0] || 'User',
        email: email,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      
      await db.ref(`users/${loggedInUserId}`).set(userData);
    }

    // 🔥 CRITICAL FIX: Ensure user has a proper name
    let userName = userData.name || '';
    
    // If name is empty, "User", or missing, set a proper name
    if (!userName || userName.trim() === '' || userName === 'User') {
      console.log('AUTH_API: User has invalid name, setting proper name');
      
      // Use email prefix as name, or a default
      userName = email.split('@')[0] || 'App User';
      
      // Update the database with the proper name
      await db.ref(`users/${loggedInUserId}`).update({
        name: userName,
        updatedAt: Date.now()
      });
      
      console.log('AUTH_API: Updated user name to:', userName);
      
      // Update the userData for response
      userData.name = userName;
    }

    console.log('AUTH_API: Login successful for user:', userName);

    // Step 5: Return success response with user data
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      mergedAccounts: duplicateUserIds.length,
      user: {
        userId: loggedInUserId,
        idToken: authResult.idToken,
        refreshToken: authResult.refreshToken,
        name: userName,
        email: userData.email || '',
        address: userData.address || '',
        language: userData.language || '',
        age: userData.age || '',
        phonenumber: userData.phonenumber || '',
        profileImage: userData.profileImage || '',
        preferredCity: userData.preferredCity || ''
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

// ==================== REGISTER FUNCTION ====================
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

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists in DATABASE (not just Auth)
    const emailCheck = await findUserByEmail(normalizedEmail);
    
    if (emailCheck.exists) {
      console.log('AUTH_API: Email already exists in system:', emailCheck);
      
      // If email exists but user wants to "re-register", suggest login
      return res.status(400).json({
        success: false,
        message: 'Email already registered. Please login instead.',
        existingUserId: emailCheck.userId,
        canLogin: true
      });
    }

    // Create user in Firebase Auth
    const userRecord = await auth.createUser({
      email: normalizedEmail,
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
      email: normalizedEmail, // Store normalized email
      age: age || '',
      phonenumber: phone || '',
      profileImage: '',
      preferredCity: '', // Add this field
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
        email: normalizedEmail,
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

// ==================== CLEANUP FUNCTION ====================
async function handleCleanupDuplicates(requestData, res) {
  try {
    const { secret, dryRun = true } = requestData;
    
    // Simple security check
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }
    
    console.log('AUTH_API: Starting duplicate cleanup, dryRun:', dryRun);
    
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();
    
    if (!users) {
      return res.status(200).json({
        success: true,
        message: 'No users found',
        results: []
      });
    }
    
    // Group by email
    const emailGroups = {};
    Object.entries(users).forEach(([userId, userData]) => {
      if (userData?.email) {
        const email = userData.email.toLowerCase().trim();
        if (!emailGroups[email]) emailGroups[email] = [];
        emailGroups[email].push({ userId, userData });
      }
    });
    
    const results = [];
    let accountsRemoved = 0;
    
    // Process duplicates
    for (const [email, userList] of Object.entries(emailGroups)) {
      if (userList.length > 1) {
        console.log(`Processing ${email}: ${userList.length} accounts`);
        
        // Find the "main" account (most recent or with auth record)
        let mainAccount = null;
        let duplicateAccounts = [];
        
        // Try to find account that exists in Firebase Auth
        for (const user of userList) {
          try {
            await auth.getUser(user.userId);
            if (!mainAccount) {
              mainAccount = user;
            } else {
              duplicateAccounts.push(user);
            }
          } catch (authError) {
            // Not in Auth, check for most recently updated
            duplicateAccounts.push(user);
          }
        }
        
        // If no auth account found, use most recently updated as main
        if (!mainAccount) {
          userList.sort((a, b) => {
            const timeA = a.userData.updatedAt || a.userData.createdAt || 0;
            const timeB = b.userData.updatedAt || b.userData.createdAt || 0;
            return timeB - timeA; // Newest first
          });
          
          mainAccount = userList[0];
          duplicateAccounts = userList.slice(1);
        } else {
          // Already have main account, ensure duplicates array is correct
          duplicateAccounts = userList.filter(u => u.userId !== mainAccount.userId);
        }
        
        if (duplicateAccounts.length > 0) {
          if (!dryRun) {
            // Actually merge duplicates
            for (const duplicate of duplicateAccounts) {
              await mergeDuplicateAccounts(mainAccount.userId, duplicate.userId);
              accountsRemoved++;
            }
          }
          
          results.push({
            email: email,
            mainAccount: mainAccount.userId.substring(0, 8) + '...',
            duplicateCount: duplicateAccounts.length,
            duplicateIds: duplicateAccounts.map(u => u.userId.substring(0, 8) + '...'),
            action: dryRun ? 'would_merge' : 'merged'
          });
        }
      }
    }
    
    return res.status(200).json({
      success: true,
      dryRun: dryRun,
      totalEmails: Object.keys(emailGroups).length,
      duplicateEmails: results.length,
      accountsRemoved: accountsRemoved,
      results: results
    });
    
  } catch (error) {
    console.error('Cleanup error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
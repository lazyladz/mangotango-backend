const nodemailer = require('nodemailer');
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
  
  // Handle preflight request
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
        const { action, ...otherData } = requestData;

        console.log('DEBUG_PASSWORD_RESET: Action:', action);

        if (!action) {
          return res.status(400).json({
            success: false,
            message: 'Action is required (send-email, verify-code, or reset-password)'
          });
        }

        let result;

        switch (action) {
          case 'send-email':
            result = await handleSendEmail(otherData);
            break;

          case 'verify-code':
            result = await handleVerifyCode(otherData);
            break;

          case 'reset-password':
            result = await handleResetPassword(otherData);
            break;

          default:
            return res.status(400).json({
              success: false,
              message: 'Invalid action. Use: send-email, verify-code, or reset-password'
            });
        }

        return res.status(200).json(result);

      } catch (parseError) {
        console.log('DEBUG_PASSWORD_RESET: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Password reset API error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Send Email Function
async function handleSendEmail(data) {
  const { email, username, code } = data;

  console.log('DEBUG_SEND_EMAIL: Received data:', { email, username, code });

  console.log('DEBUG_SEND_EMAIL: GMAIL_EMAIL from env:', process.env.GMAIL_EMAIL);
  console.log('DEBUG_SEND_EMAIL: GMAIL_PASSWORD exists:', !!process.env.GMAIL_PASSWORD);

  if (!email || !code) {
    return {
      success: false,
      message: 'Email and code are required'
    };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_EMAIL,
      pass: process.env.GMAIL_PASSWORD,
    },
  });

  const mailOptions = {
    from: `MangoTango App <${process.env.GMAIL_EMAIL}>`,
    to: email,
    subject: 'Password Reset Verification Code - MangoTango',
    html: `Your verification code is: <strong>${code}</strong>`
  };

  await transporter.sendMail(mailOptions);
  
  return {
    success: true,
    message: 'Verification code sent successfully'
  };
}

// Verify Code Function
async function handleVerifyCode(data) {
  const { userId, code } = data;

  if (!userId || !code) {
    return {
      success: false,
      message: 'User ID and code are required'
    };
  }

  const resetRef = db.ref(`password_reset_codes/${userId}`);
  const snapshot = await resetRef.once('value');

  if (!snapshot.exists()) {
    return {
      success: false,
      message: 'Code not found. Please request a new one.'
    };
  }

  const resetData = snapshot.val();
  const storedCode = resetData.code;
  const expirationTime = resetData.expirationTime || 0;
  const isUsed = resetData.used || false;
  const currentTime = Date.now();

  if (isUsed) {
    return {
      success: false,
      message: 'This code has already been used'
    };
  }

  if (currentTime > expirationTime) {
    return {
      success: false,
      message: 'This code has expired. Please request a new one.'
    };
  }

  if (storedCode !== code) {
    return {
      success: false,
      message: 'Invalid code. Please try again.'
    };
  }

  await resetRef.update({ used: true });

  return {
    success: true,
    message: 'Code verified successfully!',
    data: {
      userId: userId,
      verified: true
    }
  };
}

// Reset Password Function
async function handleResetPassword(data) {
  const { userId, email, newPassword } = data;

  if (!userId || !email || !newPassword) {
    return {
      success: false,
      message: 'User ID, email, and new password are required'
    };
  }

  if (newPassword.length < 6) {
    return {
      success: false,
      message: 'Password must be at least 6 characters'
    };
  }

  try {
    await auth.updateUser(userId, {
      password: newPassword
    });

    await db.ref(`users/${userId}/password`).set(newPassword);

    return {
      success: true,
      message: 'Password reset successful',
      data: {
        userId: userId,
        passwordUpdated: true
      }
    };

  } catch (authError) {
    console.error('Auth update error:', authError);
    return {
      success: false,
      message: 'Failed to reset password',
      error: authError.message
    };
  }
}
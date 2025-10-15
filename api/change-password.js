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

  // Route based on the path
  const path = req.url;

  if (path.includes('/send-email')) {
    await handleSendEmail(req, res);
  } else if (path.includes('/verify-code')) {
    await handleVerifyCode(req, res);
  } else if (path.includes('/reset-password')) {
    await handleResetPassword(req, res);
  } else {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
};

// Original send-email.js code (unchanged)
async function handleSendEmail(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, username, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: 'Email and code are required'
      });
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
    
    return res.status(200).json({
      success: true,
      message: 'Verification code sent successfully'
    });

  } catch (error) {
    console.error('Error sending email:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send verification email',
      error: error.message
    });
  }
}

// Original verify-code.js code (unchanged)
async function handleVerifyCode(req, res) {
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
}

// Original reset-password.js code (unchanged)
async function handleResetPassword(req, res) {
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
        const { userId, email, newPassword } = JSON.parse(body);

        if (!userId || !email || !newPassword) {
          return res.status(400).json({
            success: false,
            message: 'User ID, email, and new password are required'
          });
        }

        if (newPassword.length < 6) {
          return res.status(400).json({
            success: false,
            message: 'Password must be at least 6 characters'
          });
        }

        try {
          await auth.updateUser(userId, {
            password: newPassword
          });

          await db.ref(`users/${userId}/password`).set(newPassword);

          return res.status(200).json({
            success: true,
            message: 'Password reset successful',
            data: {
              userId: userId,
              passwordUpdated: true
            }
          });

        } catch (authError) {
          console.error('Auth update error:', authError);
          return res.status(500).json({
            success: false,
            message: 'Failed to reset password',
            error: authError.message
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
    console.error('Reset password error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
}
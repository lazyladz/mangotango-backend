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
            message: 'Action is required (check-email, send-email, verify-code, or reset-password)'
          });
        }

        let result;

        switch (action) {
          case 'check-email':
            result = await handleCheckEmail(otherData);
            break;

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
              message: 'Invalid action. Use: check-email, send-email, verify-code, or reset-password'
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

// Check Email Function
async function handleCheckEmail(data) {
  const { email } = data;

  console.log('DEBUG_CHECK_EMAIL: Checking email:', email);

  if (!email) {
    return {
      success: false,
      message: 'Email is required'
    };
  }

  try {
    const usersRef = db.ref('users');
    const snapshot = await usersRef.orderByChild('email').equalTo(email).once('value');
    
    if (snapshot.exists()) {
      const userData = snapshot.val();
      const userId = Object.keys(userData)[0];
      const user = userData[userId];
      const username = user.username || 'User';
      
      console.log('DEBUG_CHECK_EMAIL: Email found - userId:', userId, 'username:', username);
      
      return {
        success: true,
        exists: true,
        userId: userId,
        username: username,
        email: email
      };
    } else {
      console.log('DEBUG_CHECK_EMAIL: Email not found:', email);
      return {
        success: true,
        exists: false,
        message: 'Email not found'
      };
    }
  } catch (error) {
    console.error('DEBUG_CHECK_EMAIL: Error checking email:', error);
    return {
      success: false,
      message: 'Error checking email',
      error: error.message
    };
  }
}

// Send Email Function
async function handleSendEmail(data) {
  const { email, username, code, userId } = data;

  console.log('DEBUG_SEND_EMAIL: Received data:', { email, username, code, userId });

  if (!email || !code || !userId) {
    return {
      success: false,
      message: 'Email, code, and user ID are required'
    };
  }

  try {
    // Save the reset code to database
    const resetRef = db.ref(`password_reset_codes/${userId}`);
    const expirationTime = Date.now() + (10 * 60 * 1000); // 10 minutes
    
    const resetData = {
      code: code,
      email: email,
      expirationTime: expirationTime,
      used: false,
      createdAt: Date.now()
    };

    await resetRef.set(resetData);
    console.log('DEBUG_SEND_EMAIL: Reset code saved to database for user:', userId);

    // Send email
    console.log('DEBUG_SEND_EMAIL: GMAIL_EMAIL from env:', process.env.GMAIL_EMAIL);
    console.log('DEBUG_SEND_EMAIL: GMAIL_PASSWORD exists:', !!process.env.GMAIL_PASSWORD);

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
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ff6b00;">MangoTango Password Reset</h2>
          <p>Hello ${username},</p>
          <p>You requested a password reset for your MangoTango account.</p>
          <div style="background: #f4f4f4; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
            <h3 style="margin: 0; color: #333;">Your Verification Code:</h3>
            <div style="font-size: 32px; font-weight: bold; color: #ff6b00; letter-spacing: 5px; margin: 10px 0;">
              ${code}
            </div>
          </div>
          <p><strong>This code will expire in 10 minutes.</strong></p>
          <p>If you didn't request this reset, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">MangoTango Team</p>
        </div>
      `
    };

    const emailResult = await transporter.sendMail(mailOptions);
    console.log('DEBUG_SEND_EMAIL: Email sent successfully:', emailResult.messageId);
    
    return {
      success: true,
      message: 'Verification code sent successfully'
    };

  } catch (error) {
    console.error('DEBUG_SEND_EMAIL: Error:', error);
    return {
      success: false,
      message: 'Failed to send email',
      error: error.message
    };
  }
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

  try {
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
  } catch (error) {
    console.error('DEBUG_VERIFY_CODE: Error:', error);
    return {
      success: false,
      message: 'Error verifying code',
      error: error.message
    };
  }
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
    // Update Firebase Auth password
    await auth.updateUser(userId, {
      password: newPassword
    });

    // Update user password in database
    await db.ref(`users/${userId}/password`).set(newPassword);

    // Clean up used reset code
    await db.ref(`password_reset_codes/${userId}`).remove();

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
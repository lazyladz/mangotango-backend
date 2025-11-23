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

async function handleSendEmail(data) {
  const { email, username, code } = data;

  console.log('DEBUG_SEND_EMAIL: Received data:', { email, username, code });

  if (!email || !code) {
    return {
      success: false,
      message: 'Email and code are required'
    };
  }

  // Use SendGrid SMTP
  const transporter = nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
    auth: {
      user: 'apikey', // Literally the word 'apikey'
      pass: process.env.SENDGRID_API_KEY, // Your SendGrid API key
    },
  });

  const mailOptions = {
    from: 'MangoTango App <noreply@mangotango.com>',
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

  try {
    await transporter.sendMail(mailOptions);
    console.log('DEBUG_SEND_EMAIL: Email sent successfully via SendGrid');
    
    return {
      success: true,
      message: 'Verification code sent successfully'
    };
  } catch (emailError) {
    console.error('DEBUG_SEND_EMAIL: SendGrid error:', emailError);
    return {
      success: false,
      message: 'Failed to send email',
      error: emailError.message
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
const admin = require('firebase-admin');
const axios = require('axios');

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

// Helper function to extract technicianId from conversationId
function extractTechnicianIdFromConversation(conversationId, senderId) {
  if (!conversationId || !senderId) return '';
  
  console.log(`🔄 Extracting technicianId from conversation: ${conversationId}, sender: ${senderId}`);
  
  const parts = conversationId.split('_');
  if (parts.length === 2) {
    // Return the part that is NOT the sender
    const technicianId = parts[0] === senderId ? parts[1] : parts[0];
    console.log(`✅ Extracted technicianId: ${technicianId}`);
    return technicianId;
  }
  
  console.log('❌ Could not extract technicianId from conversation');
  return '';
}

// Function to get pest alerts based on weather
function getPestAlerts(temp, condition, humidity, windSpeed) {
  const pests = [];
  
  if (temp > 28 && condition === 'Sunny') pests.push('Mango hopper');
  if (temp > 25 && condition === 'Cloudy') pests.push('Mealybug');
  if (temp >= 22 && temp <= 30 && condition === 'Rainy') pests.push('Cecid Fly');
  if (condition === 'Rainy') pests.push('Anthracnose');
  if (temp > 30) pests.push('Leaf Hopper');
  
  // Additional alerts
  if (condition === 'Rainy' && temp > 25) pests.push('Fungal diseases');
  if (condition === 'Sunny' && temp > 32) pests.push('Heat stress');
  if (humidity > 85) pests.push('Powdery mildew risk');
  if (windSpeed > 5) pests.push('Wind may spread pests');
  
  return pests;
}

// Function to get farming advice
function getFarmingAdvice(temp, condition, humidity, windSpeed) {
  const advice = [];
  
  if (condition === 'Rainy') advice.push('Avoid field work.');
  if (condition === 'Stormy') advice.push('Secure farm equipment.');
  if (temp > 30) advice.push('Water plants early morning.');
  if (temp < 20) advice.push('Protect sensitive plants.');
  if (humidity > 85) advice.push('Monitor for fungal diseases.');
  if (windSpeed > 6) advice.push('Check for wind damage.');
  
  return advice.length > 0 ? advice.join(' ') : 'Normal farming activities.';
}

// Function to send weather notification to a specific user
async function sendWeatherNotificationToUser(userId, city, weatherData) {
  try {
    console.log(`🌤️ Sending weather notification to user: ${userId} for ${city}`);
    
    // Get user's FCM token
    const tokenRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await tokenRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData || !tokenData.fcmToken) {
      console.log(`❌ No FCM token for user: ${userId}`);
      return false;
    }
    
    const { temp, condition, humidity, windSpeed, pests } = weatherData;
    const currentTime = new Date().toLocaleTimeString('en-PH', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: 'Asia/Manila'
    });
    
    // Create notification message
    const title = `🌤️ Weather: ${city}`;
    const weatherMessage = `🌡️ ${temp}°C | ${condition}\n💧 ${humidity}% | 💨 ${windSpeed}m/s\n⏰ ${currentTime}`;
    
    const pestMessage = pests.length > 0 
      ? `\n\n⚠️ Pest Alert:\n${pests.map(p => `• ${p}`).join('\n')}`
      : '\n\n✅ No major pest threats';
    
    const advice = getFarmingAdvice(temp, condition, humidity, windSpeed);
    const fullMessage = `${weatherMessage}${pestMessage}\n\n💡 ${advice}`;
    
    // Prepare FCM message
    const messagePayload = {
      token: tokenData.fcmToken,
      notification: {
        title: title,
        body: `${temp}°C | ${condition}`
      },
      data: {
        type: 'weather',
        city: city,
        temperature: temp.toString(),
        condition: condition,
        humidity: humidity.toString(),
        wind_speed: windSpeed.toString(),
        pests: JSON.stringify(pests),
        timestamp: new Date().toISOString(),
        message: fullMessage
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'weather_alerts'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };
    
    console.log(`🚀 Sending weather FCM to ${userId}`);
    const response = await admin.messaging().send(messagePayload);
    console.log(`✅ Weather notification sent: ${response}`);
    
    return true;
    
  } catch (error) {
    console.error(`❌ Error sending weather notification to ${userId}:`, error.message);
    
    // Remove invalid token
    if (error.code === 'messaging/registration-token-not-registered') {
      await db.ref(`user_tokens/${userId}`).remove();
      console.log(`🗑️ Removed invalid FCM token for user: ${userId}`);
    }
    
    return false;
  }
}

// Function to fetch weather for a city
async function fetchWeatherForCity(city) {
  try {
    const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'fbc049c0ab6883e70eb66f800322b567';
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city},PH&appid=${WEATHER_API_KEY}&units=metric`;
    
    console.log(`🌤️ Fetching weather for: ${city}`);
    const response = await axios.get(url);
    
    const data = response.data;
    const temp = Math.round(data.main.temp);
    const condition = data.weather[0].main;
    const humidity = data.main.humidity;
    const windSpeed = data.wind.speed;
    
    const pests = getPestAlerts(temp, condition, humidity, windSpeed);
    
    return {
      city,
      temp,
      condition,
      humidity,
      windSpeed: Math.round(windSpeed * 10) / 10,
      pests,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`❌ Error fetching weather for ${city}:`, error.message);
    return null;
  }
}

module.exports = async (req, res) => {
  // 🔥 COMPLETE CORS HEADERS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 🔥 FIX: Parse JSON body for Vercel Serverless Functions
    let requestBody;
    if (typeof req.body === 'string') {
      try {
        requestBody = JSON.parse(req.body);
      } catch (parseError) {
        console.error('❌ JSON Parse Error:', parseError.message);
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid JSON format',
          error: parseError.message 
        });
      }
    } else {
      requestBody = req.body || {};
    }
    
    console.log('✅ Parsed request body:', requestBody);
    const { type } = requestBody;
    
    // Handle different types of notifications
    if (type === 'message') {
      // Handle message notifications
      return await handleMessageNotification(requestBody, res);
    } else if (type === 'weather') {
      // Handle weather notifications
      return await handleWeatherNotification(requestBody, res);
    } else {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid notification type. Use "message" or "weather"' 
      });
    }
    
  } catch (error) {
    console.error('❌ Server Error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message 
    });
  }
};

// Handle message notifications
async function handleMessageNotification(body, res) {
  const { 
    conversationId, 
    technicianName, 
    message,
    recipientId,
    senderId,
    technicianId
  } = body;

  console.log('📨 MESSAGE NOTIFICATION REQUEST:');
  console.log('   - conversationId:', conversationId);
  console.log('   - technicianName:', technicianName);
  console.log('   - technicianId:', technicianId);
  console.log('   - recipientId:', recipientId);

  if (!conversationId || !technicianName || !message || !recipientId) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required: conversationId, technicianName, message, recipientId' 
    });
  }

  const finalTechnicianId = technicianId || extractTechnicianIdFromConversation(conversationId, senderId);
  
  // Get recipient's FCM token
  const tokenRef = db.ref(`user_tokens/${recipientId}`);
  const tokenSnapshot = await tokenRef.once('value');
  const tokenData = tokenSnapshot.val();
  
  if (!tokenData || !tokenData.fcmToken) {
    console.log(`📱 No FCM token found for recipient: ${recipientId}`);
    return res.status(404).json({ 
      success: false, 
      message: 'Recipient FCM token not found' 
    });
  }

  const recipientToken = tokenData.fcmToken;

  // Prepare FCM message
  const messagePayload = {
    token: recipientToken,
    notification: {
      title: `💬 ${technicianName}`,
      body: message
    },
    data: {
      type: 'message',
      technicianName: technicianName,
      technicianId: finalTechnicianId,
      conversationId: conversationId,
      message: message,
      senderId: senderId || 'unknown',
      from_fcm: 'true'
    },
    android: {
      priority: 'high'
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title: `💬 ${technicianName}`,
            body: message
          },
          sound: 'default',
          badge: 1
        }
      }
    }
  };

  console.log('🚀 Sending message FCM...');
  const response = await admin.messaging().send(messagePayload);
  
  console.log(`✅ Message notification sent successfully`);
  
  return res.status(200).json({
    success: true,
    message: 'Push notification sent successfully',
    messageId: response,
    recipientId: recipientId,
    technicianId: finalTechnicianId
  });
}

// Handle weather notifications
async function handleWeatherNotification(body, res) {
  const { 
    city,
    userId,  // Send to specific user
    broadcast // Send to all users in city
  } = body;

  console.log('🌤️ WEATHER NOTIFICATION REQUEST:');
  console.log('   - city:', city);
  console.log('   - userId:', userId);
  console.log('   - broadcast:', broadcast);

  if (!city) {
    return res.status(400).json({ 
      success: false, 
      message: 'City is required' 
    });
  }

  // Fetch weather data
  const weatherData = await fetchWeatherForCity(city);
  if (!weatherData) {
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch weather data' 
    });
  }

  let successCount = 0;
  let failCount = 0;

  if (userId) {
    // Send to specific user
    const success = await sendWeatherNotificationToUser(userId, city, weatherData);
    if (success) successCount++;
    else failCount++;
    
  } else if (broadcast) {
    // Send to all users
    console.log('📢 Broadcasting weather to all users in', city);
    
    const usersRef = db.ref('user_tokens');
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val();
    
    if (users) {
      const userIds = Object.keys(users);
      
      for (const userId of userIds) {
        const success = await sendWeatherNotificationToUser(userId, city, weatherData);
        if (success) successCount++;
        else failCount++;
      }
    }
    
  } else {
    // No target specified - just fetch and return weather data
    return res.status(200).json({
      success: true,
      message: 'Weather data fetched',
      weather: weatherData
    });
  }

  return res.status(200).json({
    success: true,
    message: `Weather notifications sent: ${successCount} successful, ${failCount} failed`,
    sent: successCount,
    failed: failCount,
    weather: weatherData
  });
}

// Add a GET endpoint for testing weather
if (require.main === module) {
  // For testing directly
  module.exports({ 
    method: 'POST',
    body: { 
      type: 'weather',
      city: 'Manila',
      userId: 'test-user-id' 
    }
  }, {
    setHeader: () => {},
    status: (code) => ({ json: (data) => console.log(data) }),
    json: (data) => console.log(data)
  });
}
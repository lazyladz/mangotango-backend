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

// ==================== HELPER FUNCTIONS ====================

function getPestAlerts(temp, condition, humidity, windSpeed) {
  const pests = [];
  
  if (temp > 28 && condition === 'Sunny') pests.push('Mango hopper');
  if (temp > 25 && condition === 'Cloudy') pests.push('Mealybug');
  if (temp >= 22 && temp <= 30 && condition === 'Rainy') pests.push('Cecid Fly');
  if (condition === 'Rainy') pests.push('Anthracnose');
  if (temp > 30) pests.push('Leaf Hopper');
  
  if (condition === 'Rainy' && temp > 25) pests.push('Fungal diseases');
  if (condition === 'Sunny' && temp > 32) pests.push('Heat stress');
  if (humidity > 85) pests.push('Powdery mildew risk');
  if (windSpeed > 5) pests.push('Wind may spread pests');
  
  return pests;
}

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
      timestamp: new Date().toISOString(),
      fetchedAt: new Date().toLocaleTimeString('en-PH', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Manila'
      })
    };
    
  } catch (error) {
    console.error(`❌ Error fetching weather for ${city}:`, error.message);
    return null;
  }
}

async function sendWeatherNotificationToUser(userId, city, weatherData, isTest = false) {
  try {
    console.log(`🌤️ Sending weather notification to user: ${userId} for ${city} (Test: ${isTest})`);
    
    // Get user's FCM token
    const tokenRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await tokenRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData || !tokenData.fcmToken) {
      console.log(`❌ No FCM token for user: ${userId}`);
      return false;
    }
    
    const { temp, condition, humidity, windSpeed, pests, fetchedAt } = weatherData;
    
    // Create notification message
    const title = isTest 
      ? `🧪 Weather Test: ${city}` 
      : `🌤️ Weather Update: ${city}`;
    
    const weatherMessage = `🌡️ ${temp}°C | ${condition}\n💧 ${humidity}% | 💨 ${windSpeed}m/s\n⏰ ${fetchedAt}`;
    
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
        message: fullMessage,
        test: isTest.toString(),
        source: 'weather-cron'
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

// ==================== MAIN FUNCTIONS ====================

// Function 1: Manual test
async function handleManualTest(userId, city = null) {
  console.log('🧪 MANUAL WEATHER TEST REQUESTED');
  
  const testCity = city || 'Manila'; // Default to Manila
  const weatherData = await fetchWeatherForCity(testCity);
  
  if (!weatherData) {
    throw new Error(`Failed to fetch weather for ${testCity}`);
  }
  
  const success = await sendWeatherNotificationToUser(userId, testCity, weatherData, true);
  
  return {
    success,
    city: testCity,
    weather: weatherData,
    message: success ? 'Test notification sent successfully' : 'Failed to send test notification'
  };
}

// Function 2: Cron job (called every 5 minutes) - UPDATED!
async function handleCronJob() {
  console.log('⏰ CRON JOB TRIGGERED:', new Date().toISOString());
  
  // Get all users with their preferred cities
  const usersRef = db.ref('users');
  const usersSnapshot = await usersRef.once('value');
  const users = usersSnapshot.val();
  
  if (!users) {
    console.log('❌ Cron job: No users found');
    return { success: false, error: 'No users found' };
  }
  
  const userCount = Object.keys(users).length;
  console.log(`📢 Cron job: Found ${userCount} users`);
  
  let successCount = 0;
  let failCount = 0;
  const results = [];
  
  // Process each user separately with their preferred city
  for (const [userId, userData] of Object.entries(users)) {
    // Skip if no user data
    if (!userData) continue;
    
    try {
      // Get user's preferred city from Firebase, default to Manila
      const userCity = userData.preferredCity || 'Manila';
      
      console.log(`  👤 User: ${userId}, City: ${userCity}`);
      
      // Fetch weather for user's city
      const weatherData = await fetchWeatherForCity(userCity);
      
      if (!weatherData) {
        console.log(`  ❌ Failed to fetch weather for ${userCity}`);
        failCount++;
        results.push({ userId, city: userCity, success: false, error: 'Weather fetch failed' });
        continue;
      }
      
      // Send notification
      const success = await sendWeatherNotificationToUser(userId, userCity, weatherData, false);
      
      if (success) {
        successCount++;
        results.push({ userId, city: userCity, success: true });
        console.log(`  ✅ Sent weather for ${userCity} to ${userId}`);
      } else {
        failCount++;
        results.push({ userId, city: userCity, success: false, error: 'FCM send failed' });
        console.log(`  ❌ Failed to send to ${userId}`);
      }
      
      // Add small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      console.error(`  ❌ Error processing user ${userId}:`, error.message);
      failCount++;
      results.push({ userId, success: false, error: error.message });
    }
  }
  
  return {
    success: true,
    summary: {
      totalUsers: userCount,
      usersAttempted: successCount + failCount,
      usersSuccessful: successCount,
      usersFailed: failCount,
      timestamp: new Date().toISOString(),
      nextRun: 'in 5 minutes'
    },
    results: results.slice(0, 10) // Return first 10 results to avoid huge response
  };
}

// Function 3: Quick test (no FCM)
async function handleQuickTest(city = 'Manila') {
  console.log('⚡ QUICK WEATHER TEST');
  
  const weatherData = await fetchWeatherForCity(city);
  
  if (!weatherData) {
    throw new Error(`Failed to fetch weather for ${city}`);
  }
  
  return {
    success: true,
    city,
    weather: weatherData,
    message: 'Weather data fetched successfully'
  };
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  console.log(`📨 Weather Cron Request: ${req.method} ${new Date().toISOString()}`);
  
  try {
    // Parse request body
    let requestBody = {};
    if (req.body) {
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }
    
    const { action, userId, city } = requestBody;
    
    // Check if it's a cron job call (from Vercel scheduler)
    const isCronJob = req.headers['cron-secret'] === process.env.CRON_SECRET || 
                      req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` ||
                      requestBody.secret === process.env.CRON_SECRET;
    
    if (isCronJob) {
      console.log('🔐 Cron job authenticated');
      const result = await handleCronJob();
      return res.status(200).json(result);
    }
    
    // Manual API requests
    switch (action) {
      case 'test':
        if (!userId) {
          return res.status(400).json({ error: 'userId is required for test action' });
        }
        const testResult = await handleManualTest(userId, city);
        return res.status(200).json(testResult);
        
      case 'quick-test':
        const quickResult = await handleQuickTest(city || 'Manila');
        return res.status(200).json(quickResult);
        
      case 'cron-simulate':
        // Simulate cron job manually
        const cronResult = await handleCronJob();
        return res.status(200).json(cronResult);
        
      default:
        // Default: Show available endpoints
        return res.status(200).json({
          service: 'Weather Cron Service',
          status: 'running',
          timestamp: new Date().toISOString(),
          endpoints: [
            { 
              action: 'test', 
              method: 'POST', 
              description: 'Send test weather notification to user',
              example: '{"action":"test","userId":"YOUR_USER_ID","city":"Manila (optional)"}'
            },
            { 
              action: 'quick-test', 
              method: 'POST', 
              description: 'Fetch weather data only (no FCM)',
              example: '{"action":"quick-test","city":"Manila (optional)"}'
            },
            { 
              action: 'cron-simulate', 
              method: 'POST', 
              description: 'Manually trigger cron job',
              example: '{"action":"cron-simulate"}'
            }
          ],
          note: 'Cron job runs automatically every 5 minutes and sends personalized weather for each user\'s preferred city'
        });
    }
    
  } catch (error) {
    console.error('❌ Weather Crons Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
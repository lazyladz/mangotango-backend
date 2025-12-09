const admin = require('firebase-admin');
const functions = require('firebase-functions');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { action, userId, taskData, taskId, triggerReminders } = req.body;

    console.log('TASKS_API: Received request -', { action, userId, taskId });

    if (!userId && action !== 'trigger_reminders') {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Special endpoint to trigger reminders manually (for testing)
    if (action === 'trigger_reminders') {
      await checkAndSendReminders(res);
      return;
    }

    switch (action) {
      case 'read':
        await getTasks(userId, res);
        break;
      
      case 'create':
        if (!taskData) {
          return res.status(400).json({
            success: false,
            message: 'Task data is required for creating task'
          });
        }
        await createTask(userId, taskData, res);
        break;
      
      case 'update':
        if (!taskId || !taskData) {
          return res.status(400).json({
            success: false,
            message: 'Task ID and task data are required for updating task'
          });
        }
        await updateTask(userId, taskId, taskData, res);
        break;
      
      case 'delete':
        if (!taskId) {
          return res.status(400).json({
            success: false,
            message: 'Task ID is required for deleting task'
          });
        }
        await deleteTask(userId, taskId, res);
        break;
      
      case 'delete_all':
        await deleteAllTasks(userId, res);
        break;
      
      case 'complete':
        if (!taskId) {
          return res.status(400).json({
            success: false,
            message: 'Task ID is required for marking task complete'
          });
        }
        await markTaskComplete(userId, taskId, res);
        break;
      
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid action. Supported actions: read, create, update, delete, delete_all, complete'
        });
    }

  } catch (error) {
    console.error('TASKS_API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// ==================== TASK REMINDER FUNCTIONS ====================

// Function to check and send reminders (called manually or from client)
async function checkAndSendReminders(res) {
  try {
    console.log('⏰ Checking task reminders...');
    
    const now = Date.now();
    const fiveMinutesFromNow = now + (5 * 60 * 1000);
    
    // Find reminders due within next 5 minutes
    const remindersRef = db.ref('task_reminders');
    const snapshot = await remindersRef
      .orderByChild('reminderTime')
      .startAt(now - 60000) // 1 minute ago (for late checks)
      .endAt(fiveMinutesFromNow)
      .once('value');
    
    if (!snapshot.exists()) {
      console.log('✅ No reminders due');
      if (res) {
        return res.status(200).json({
          success: true,
          message: 'No reminders due',
          remindersProcessed: 0
        });
      }
      return;
    }
    
    const reminders = snapshot.val();
    const results = [];
    
    // Process each reminder
    for (const [reminderId, reminder] of Object.entries(reminders)) {
      if (reminder.status === 'scheduled') {
        try {
          // Send FCM notification
          const sent = await sendTaskReminderNotification(
            reminder.userId, 
            reminder.taskId,
            reminder.taskName,
            reminder.taskTime
          );
          
          if (sent) {
            // Mark as sent
            await remindersRef.child(reminderId).update({
              status: 'sent',
              sentAt: new Date().toISOString()
            });
            
            // Schedule next reminder
            await scheduleNextReminder(reminder.userId, {
              taskId: reminder.taskId,
              taskName: reminder.taskName,
              taskTime: reminder.taskTime,
              taskDays: reminder.taskDays
            });
            
            results.push({
              reminderId,
              userId: reminder.userId,
              taskName: reminder.taskName,
              success: true
            });
            
            console.log(`✅ Sent reminder for: ${reminder.taskName}`);
          }
        } catch (error) {
          console.error(`❌ Failed to send reminder ${reminderId}:`, error);
        }
      }
    }
    
    console.log(`📊 Sent ${results.length} reminders`);
    
    if (res) {
      return res.status(200).json({
        success: true,
        message: `Sent ${results.length} reminders`,
        remindersProcessed: results.length,
        results
      });
    }
    
  } catch (error) {
    console.error('❌ Error checking reminders:', error);
    if (res) {
      return res.status(500).json({
        success: false,
        message: 'Failed to check reminders',
        error: error.message
      });
    }
  }
}

// Schedule a task reminder
async function scheduleTaskReminder(userId, task) {
  try {
    console.log(`⏰ Scheduling reminder for: ${task.name}`);
    
    // Calculate next reminder time (5 minutes before task time)
    const reminderTime = calculateReminderTime(task.time, task.days);
    
    if (!reminderTime) {
      console.log('⚠️ Could not calculate reminder time');
      return false;
    }
    
    // Store in Firebase
    const remindersRef = db.ref('task_reminders');
    const newReminderRef = remindersRef.push();
    
    const reminderData = {
      id: newReminderRef.key,
      userId: userId,
      taskId: task.id,
      taskName: task.name,
      taskTime: task.time,
      taskDays: task.days,
      reminderTime: reminderTime.getTime(),
      reminderTimeFormatted: reminderTime.toISOString(),
      status: 'scheduled',
      createdAt: new Date().toISOString()
    };
    
    await newReminderRef.set(reminderData);
    
    console.log(`✅ Reminder scheduled for: ${reminderTime.toLocaleString()}`);
    return true;
    
  } catch (error) {
    console.error('❌ Error scheduling reminder:', error);
    return false;
  }
}

// Calculate reminder time (5 minutes before task)
function calculateReminderTime(taskTime, taskDays) {
  try {
    const now = new Date();
    
    // Parse time (e.g., "08:00 AM")
    const [timeStr, period] = taskTime.split(' ');
    const [hoursStr, minutesStr] = timeStr.split(':');
    let hours = parseInt(hoursStr);
    const minutes = parseInt(minutesStr || 0);
    
    // Convert to 24-hour
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    
    // Parse days
    const dayMap = {
      'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4,
      'Fri': 5, 'Sat': 6, 'Sun': 0
    };
    
    const isEveryday = taskDays === 'Everyday';
    const dayNumbers = isEveryday 
      ? [0, 1, 2, 3, 4, 5, 6]
      : taskDays.split(',').map(day => dayMap[day.trim()]);
    
    // Check next 7 days
    for (let i = 0; i < 7; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(checkDate.getDate() + i);
      const dayOfWeek = checkDate.getDay();
      
      if (dayNumbers.includes(dayOfWeek)) {
        // Set to task time
        const taskDateTime = new Date(checkDate);
        taskDateTime.setHours(hours, minutes, 0, 0);
        
        // Set reminder to 5 minutes before
        const reminderTime = new Date(taskDateTime);
        reminderTime.setMinutes(reminderTime.getMinutes() - 5);
        
        // If reminder is in the future
        if (reminderTime > now) {
          return reminderTime;
        }
      }
    }
    
    return null;
    
  } catch (error) {
    console.error('❌ Error calculating time:', error);
    return null;
  }
}

// Send FCM notification
async function sendTaskReminderNotification(userId, taskId, taskName, taskTime) {
  try {
    // Get user's FCM token
    const userTokensRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await userTokensRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData || !tokenData.fcmToken) {
      console.log(`❌ No FCM token for user: ${userId}`);
      return false;
    }
    
    const fcmToken = tokenData.fcmToken;
    
    // Create message
    const message = {
      token: fcmToken,
      notification: {
        title: `⏰ Task Reminder: ${taskName}`,
        body: `Time: ${taskTime}`
      },
      data: {
        type: 'task_reminder',
        taskId: taskId,
        taskName: taskName,
        taskTime: taskTime,
        userId: userId,
        click_action: 'TASK_ACTIVITY'
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'task_reminders',
          sound: 'default',
          color: '#4CAF50',
          icon: 'notification_icon'
        }
      }
    };
    
    // Send via FCM
    await admin.messaging().send(message);
    
    // Save to user notifications
    await saveNotification(userId, {
      title: `⏰ Task Reminder`,
      message: `${taskName} at ${taskTime}`,
      type: 'task',
      timestamp: new Date().toISOString()
    });
    
    return true;
    
  } catch (error) {
    console.error('❌ FCM Error:', error);
    return false;
  }
}

// Schedule next reminder after current one is sent
async function scheduleNextReminder(userId, taskData) {
  try {
    // Calculate next occurrence (next week)
    const nextTime = calculateReminderTime(taskData.taskTime, taskData.taskDays);
    
    if (!nextTime) return;
    
    // Add 7 days for next week
    nextTime.setDate(nextTime.getDate() + 7);
    
    // Create new reminder
    const remindersRef = db.ref('task_reminders');
    const newReminderRef = remindersRef.push();
    
    await newReminderRef.set({
      id: newReminderRef.key,
      userId: userId,
      taskId: taskData.taskId,
      taskName: taskData.taskName,
      taskTime: taskData.taskTime,
      taskDays: taskData.taskDays,
      reminderTime: nextTime.getTime(),
      reminderTimeFormatted: nextTime.toISOString(),
      status: 'scheduled',
      createdAt: new Date().toISOString()
    });
    
    console.log(`🔄 Next reminder scheduled for: ${nextTime.toLocaleString()}`);
    
  } catch (error) {
    console.error('❌ Error scheduling next reminder:', error);
  }
}

// Save notification to user's notification list
async function saveNotification(userId, notification) {
  try {
    const notificationsRef = db.ref(`notifications/${userId}`);
    const newNotifRef = notificationsRef.push();
    
    await newNotifRef.set({
      ...notification,
      id: newNotifRef.key,
      read: false
    });
    
    return true;
  } catch (error) {
    console.error('❌ Error saving notification:', error);
    return false;
  }
}

// ==================== TASK CRUD FUNCTIONS ====================

async function getTasks(userId, res) {
  try {
    const tasksRef = db.ref(`tasks/${userId}`);
    const snapshot = await tasksRef.once('value');
    
    const tasks = [];
    
    if (snapshot.exists()) {
      snapshot.forEach((childSnapshot) => {
        const task = childSnapshot.val();
        tasks.push({
          id: childSnapshot.key,
          ...task
        });
      });
    }

    return res.status(200).json({
      success: true,
      data: { tasks: tasks }
    });

  } catch (error) {
    console.error('❌ Get tasks error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function createTask(userId, taskData, res) {
  try {
    const { time, name, days, status } = taskData;

    if (!time || !name || !days || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const tasksRef = db.ref(`tasks/${userId}`);
    const newTaskRef = tasksRef.push();
    
    const task = {
      time: time,
      name: name,
      days: days,
      status: status,
      id: newTaskRef.key,
      createdAt: new Date().toISOString()
    };

    await newTaskRef.set(task);

    // Schedule FCM reminder
    await scheduleTaskReminder(userId, task);

    return res.status(201).json({
      success: true,
      data: { task: task }
    });

  } catch (error) {
    console.error('❌ Create task error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function updateTask(userId, taskId, taskData, res) {
  try {
    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const oldTask = snapshot.val();
    const updatedTask = {
      ...oldTask,
      ...taskData,
      updatedAt: new Date().toISOString()
    };

    await taskRef.set(updatedTask);

    // Delete old reminders and schedule new ones if time/days changed
    if (taskData.time || taskData.days) {
      await deleteTaskReminders(userId, taskId);
      await scheduleTaskReminder(userId, {
        ...updatedTask,
        id: taskId
      });
    }

    return res.status(200).json({
      success: true,
      data: { task: updatedTask }
    });

  } catch (error) {
    console.error('❌ Update task error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function deleteTask(userId, taskId, res) {
  try {
    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    await taskRef.remove();
    
    // Delete associated reminders
    await deleteTaskReminders(userId, taskId);

    return res.status(200).json({
      success: true,
      message: 'Task deleted'
    });

  } catch (error) {
    console.error('❌ Delete task error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function deleteAllTasks(userId, res) {
  try {
    const tasksRef = db.ref(`tasks/${userId}`);
    await tasksRef.remove();
    
    // Delete all user's reminders
    await deleteUserReminders(userId);

    return res.status(200).json({
      success: true,
      message: 'All tasks deleted'
    });

  } catch (error) {
    console.error('❌ Delete all error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function markTaskComplete(userId, taskId, res) {
  try {
    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const task = snapshot.val();
    const updatedTask = {
      ...task,
      status: 'Complete',
      completedAt: new Date().toISOString()
    };

    await taskRef.set(updatedTask);
    
    // Delete reminders for completed task
    await deleteTaskReminders(userId, taskId);

    return res.status(200).json({
      success: true,
      data: { task: updatedTask }
    });

  } catch (error) {
    console.error('❌ Complete task error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Helper: Delete reminders for a specific task
async function deleteTaskReminders(userId, taskId) {
  try {
    const remindersRef = db.ref('task_reminders');
    const snapshot = await remindersRef
      .orderByChild('userId')
      .equalTo(userId)
      .once('value');
    
    if (snapshot.exists()) {
      snapshot.forEach((childSnapshot) => {
        const reminder = childSnapshot.val();
        if (reminder.taskId === taskId) {
          childSnapshot.ref.remove();
        }
      });
    }
  } catch (error) {
    console.error('❌ Delete reminders error:', error);
  }
}

// Helper: Delete all reminders for a user
async function deleteUserReminders(userId) {
  try {
    const remindersRef = db.ref('task_reminders');
    const snapshot = await remindersRef
      .orderByChild('userId')
      .equalTo(userId)
      .once('value');
    
    if (snapshot.exists()) {
      await snapshot.ref.remove();
    }
  } catch (error) {
    console.error('❌ Delete user reminders error:', error);
  }
}
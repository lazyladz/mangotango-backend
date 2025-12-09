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

const db = admin.database();

// Philippines timezone (UTC+8)
const PH_TIMEZONE_OFFSET = 8 * 60; // minutes
const PH_TIMEZONE = 'Asia/Manila';

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
    const { action, userId, taskData, taskId } = req.body;

    console.log('TASKS_API: Received request -', { action, userId, taskId });
    console.log('🕐 Current PH Time:', getPhilippinesTime().toLocaleString());

    if (!userId && action !== 'trigger_reminders') {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Check reminders on EVERY request
    await checkAndSendDueReminders();

    // Special endpoint to trigger reminders manually
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
      
      case 'test_reminder':
        await testTaskReminder(userId, taskId, res);
        break;
      
      case 'force_check':
        // Force check reminders (for testing)
        const result = await checkAndSendDueReminders(true);
        return res.status(200).json({
          success: true,
          message: 'Force check completed',
          result,
          phTime: getPhilippinesTime().toLocaleString()
        });
      
      case 'debug_time':
        // Debug endpoint to check time calculations
        return res.status(200).json({
          success: true,
          serverTime: new Date().toLocaleString(),
          phTime: getPhilippinesTime().toLocaleString(),
          timestamp: Date.now(),
          offset: PH_TIMEZONE_OFFSET
        });
      
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid action. Supported actions: read, create, update, delete, delete_all, complete, test_reminder, trigger_reminders, force_check, debug_time'
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

// ==================== TIME HELPER FUNCTIONS ====================

// Get current Philippines time
function getPhilippinesTime() {
  const now = new Date();
  const phTime = new Date(now.getTime() + (PH_TIMEZONE_OFFSET * 60000));
  return phTime;
}

// Convert local time string (e.g., "7:03 PM") to Date object in PH time
function parsePhilippinesTime(timeStr) {
  try {
    // Example: "7:03 PM" or "07:03 PM"
    const [timePart, period] = timeStr.trim().split(' ');
    let [hours, minutes] = timePart.split(':').map(num => parseInt(num));
    
    // Handle AM/PM
    if (period === 'PM' && hours !== 12) {
      hours += 12;
    } else if (period === 'AM' && hours === 12) {
      hours = 0;
    }
    
    // Create date in Philippines timezone
    const now = getPhilippinesTime();
    const date = new Date(now);
    date.setHours(hours, minutes || 0, 0, 0);
    
    // If time has already passed today, set for tomorrow
    if (date <= now) {
      date.setDate(date.getDate() + 1);
    }
    
    return date;
  } catch (error) {
    console.error('Error parsing time:', error, 'timeStr:', timeStr);
    return null;
  }
}

// Format time for display
function formatPhilippinesTime(date) {
  return date.toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour12: true,
    hour: 'numeric',
    minute: '2-digit'
  });
}

// ==================== FCM TASK FUNCTIONS ====================

// Function to send FCM notification
async function sendTaskReminderFCM(userId, task) {
  try {
    console.log(`📱 Sending FCM for task: ${task.name} to user: ${userId}`);
    
    // Get user's FCM token
    const userTokensRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await userTokensRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData || !tokenData.fcmToken) {
      console.log(`❌ No FCM token for user: ${userId}`);
      return false;
    }
    
    const fcmToken = tokenData.fcmToken;
    
    // Prepare FCM message
    const message = {
      token: fcmToken,
      notification: {
        title: `⏰ Task Reminder: ${task.name}`,
        body: `Time: ${task.time}`
      },
      data: {
        type: 'task_reminder',
        taskId: task.id,
        taskName: task.name,
        taskTime: task.time,
        userId: userId,
        click_action: 'TASK_ACTIVITY'
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'task_reminders',
          sound: 'default',
          color: '#4CAF50'
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
    
    // Send via FCM
    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent successfully: ${response}`);
    
    // Save notification to database
    await saveTaskNotificationToDB(userId, task);
    
    return true;
    
  } catch (error) {
    console.error('❌ FCM Error:', error);
    
    // Remove invalid token
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      console.log(`🗑️ Removing invalid token for user: ${userId}`);
      await db.ref(`user_tokens/${userId}`).remove();
    }
    
    return false;
  }
}

// Send task completion FCM
async function sendTaskCompletionFCM(userId, task) {
  try {
    const userTokensRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await userTokensRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData?.fcmToken) return false;
    
    const message = {
      token: tokenData.fcmToken,
      notification: {
        title: '✅ Task Completed',
        body: `Great job on: ${task.name}`
      },
      data: {
        type: 'task_completed',
        taskId: task.id,
        taskName: task.name,
        userId: userId
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'task_reminders',
          sound: 'default',
          color: '#4CAF50'
        }
      }
    };
    
    await admin.messaging().send(message);
    console.log(`✅ Task completion FCM sent for: ${task.name}`);
    return true;
    
  } catch (error) {
    console.error('❌ Completion FCM error:', error);
    return false;
  }
}

// Save task notification to Firebase
async function saveTaskNotificationToDB(userId, task) {
  try {
    const notificationsRef = db.ref(`notifications/${userId}`);
    const newNotifRef = notificationsRef.push();
    
    await newNotifRef.set({
      id: newNotifRef.key,
      title: `⏰ Task Reminder: ${task.name}`,
      message: `Time: ${task.time}`,
      type: 'task_reminder',
      timestamp: new Date().toISOString(),
      read: false,
      taskId: task.id,
      taskName: task.name
    });
    
    console.log('✅ Notification saved to database');
    return true;
    
  } catch (error) {
    console.error('❌ Error saving notification:', error);
    return false;
  }
}

// ==================== DATABASE-BASED SCHEDULING ====================

// Schedule task reminder in DATABASE
async function scheduleTaskReminder(userId, task) {
  try {
    console.log(`⏰ Storing reminder in DB for: ${task.name} at ${task.time}`);
    
    // Calculate next reminder time (5 minutes before task time)
    const taskTime = parsePhilippinesTime(task.time);
    if (!taskTime) {
      console.log('⚠️ Could not parse task time');
      return false;
    }
    
    // Set reminder to 5 minutes before
    const reminderTime = new Date(taskTime);
    reminderTime.setMinutes(reminderTime.getMinutes() - 5);
    
    // Check if reminder is in the future
    const now = getPhilippinesTime();
    if (reminderTime <= now) {
      console.log('⚠️ Reminder time is in the past, skipping');
      return false;
    }
    
    // Store in pending_reminders
    const remindersRef = db.ref('pending_reminders');
    const newReminderRef = remindersRef.push();
    
    await newReminderRef.set({
      id: newReminderRef.key,
      userId: userId,
      taskId: task.id,
      taskName: task.name,
      taskTime: task.time,
      taskDays: task.days,
      reminderTime: reminderTime.toISOString(),
      actualTaskTime: taskTime.toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      phTimeFormatted: formatPhilippinesTime(reminderTime)
    });
    
    console.log(`✅ Reminder stored in DB for: ${formatPhilippinesTime(reminderTime)}`);
    console.log(`   (Task at: ${formatPhilippinesTime(taskTime)}, Reminder 5 mins before)`);
    return true;
    
  } catch (error) {
    console.error('❌ Error storing reminder in DB:', error);
    return false;
  }
}

// Check for due reminders (called on every request)
async function checkAndSendDueReminders(forceCheck = false) {
  try {
    const now = getPhilippinesTime();
    console.log('🔍 Checking for due reminders at PH time:', now.toLocaleString());
    
    // Only check every 30 seconds unless forced
    if (!forceCheck) {
      const lastCheckedRef = db.ref('system/last_reminder_check');
      const lastCheckedSnapshot = await lastCheckedRef.once('value');
      const lastChecked = lastCheckedSnapshot.val();
      
      if (lastChecked && (Date.now() - new Date(lastChecked).getTime()) < 30000) {
        return { checked: false, message: 'Checked recently' };
      }
      
      // Update last checked time
      await lastCheckedRef.set(new Date().toISOString());
    }
    
    // Get reminders that are due (within ±2 minutes of now)
    const remindersRef = db.ref('pending_reminders');
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60000).toISOString();
    const twoMinutesFromNow = new Date(now.getTime() + 2 * 60000).toISOString();
    
    const snapshot = await remindersRef
      .orderByChild('reminderTime')
      .startAt(twoMinutesAgo)
      .endAt(twoMinutesFromNow)
      .once('value');
    
    if (!snapshot.exists()) {
      console.log('📭 No due reminders found');
      return { sent: 0, total: 0 };
    }
    
    let sentCount = 0;
    let totalReminders = 0;
    const updates = {};
    
    // Process each due reminder
    snapshot.forEach((childSnapshot) => {
      totalReminders++;
      const reminder = childSnapshot.val();
      
      // If reminder is pending
      if (reminder.status === 'pending') {
        console.log(`⏰ Processing reminder for: ${reminder.taskName}`);
        console.log(`   Scheduled for: ${reminder.phTimeFormatted || reminder.reminderTime}`);
        
        // Mark as processing
        updates[`${childSnapshot.key}/status`] = 'processing';
        updates[`${childSnapshot.key}/lastProcessed`] = new Date().toISOString();
        
        // Send FCM
        sendTaskReminderFCM(reminder.userId, {
          id: reminder.taskId,
          name: reminder.taskName,
          time: reminder.taskTime,
          days: reminder.taskDays
        }).then(async (success) => {
          if (success) {
            // Update to sent
            await db.ref(`pending_reminders/${childSnapshot.key}`).update({
              status: 'sent',
              sentAt: new Date().toISOString(),
              sentAtPH: now.toISOString()
            });
            console.log(`✅ Reminder sent for: ${reminder.taskName}`);
            sentCount++;
            
            // If recurring, schedule next one
            if (reminder.taskDays !== 'Once') {
              await scheduleNextRecurringReminder(reminder);
            }
          } else {
            // Mark as failed
            await db.ref(`pending_reminders/${childSnapshot.key}`).update({
              status: 'failed',
              lastAttempt: new Date().toISOString()
            });
          }
        }).catch(error => {
          console.error(`❌ Error sending reminder: ${error.message}`);
        });
      }
    });
    
    // Update statuses
    if (Object.keys(updates).length > 0) {
      await remindersRef.update(updates);
    }
    
    console.log(`✅ Processed ${sentCount}/${totalReminders} reminders`);
    return { sent: sentCount, total: totalReminders, checked: true };
    
  } catch (error) {
    console.error('❌ Error checking reminders:', error);
    return { sent: 0, total: 0, error: error.message };
  }
}

// Schedule next occurrence for recurring tasks
async function scheduleNextRecurringReminder(reminder) {
  try {
    // For recurring tasks, we need to calculate the next occurrence
    // This is simplified - you might need more complex logic for specific days
    if (reminder.taskDays === 'Everyday') {
      // Next day at same time
      const nextReminderTime = new Date(reminder.actualTaskTime);
      nextReminderTime.setDate(nextReminderTime.getDate() + 1);
      nextReminderTime.setMinutes(nextReminderTime.getMinutes() - 5); // 5 minutes before
      
      const remindersRef = db.ref('pending_reminders');
      const newReminderRef = remindersRef.push();
      
      await newReminderRef.set({
        id: newReminderRef.key,
        userId: reminder.userId,
        taskId: reminder.taskId,
        taskName: reminder.taskName,
        taskTime: reminder.taskTime,
        taskDays: reminder.taskDays,
        reminderTime: nextReminderTime.toISOString(),
        actualTaskTime: new Date(reminder.actualTaskTime).setDate(new Date(reminder.actualTaskTime).getDate() + 1),
        status: 'pending',
        createdAt: new Date().toISOString(),
        phTimeFormatted: formatPhilippinesTime(nextReminderTime)
      });
      
      console.log(`📅 Next daily reminder scheduled for: ${formatPhilippinesTime(nextReminderTime)}`);
    }
    // Add more logic for other recurrence patterns (Mon,Wed,Fri etc.)
    
  } catch (error) {
    console.error('❌ Error scheduling next recurring reminder:', error);
  }
}

// Check and send reminders (for manual trigger)
async function checkAndSendReminders(res) {
  try {
    console.log('⏰ Manual reminder check triggered');
    
    const result = await checkAndSendDueReminders(true);
    
    if (res) {
      return res.status(200).json({
        success: true,
        message: 'Reminder check completed',
        result,
        phTime: getPhilippinesTime().toLocaleString(),
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('❌ Error checking reminders:', error);
    if (res) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

// Test function to send immediate FCM reminder
async function testTaskReminder(userId, taskId, res) {
  try {
    console.log(`🧪 Testing FCM reminder for user: ${userId}, task: ${taskId}`);
    
    // Get task details
    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');
    
    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }
    
    const task = snapshot.val();
    
    // Send FCM immediately
    const sent = await sendTaskReminderFCM(userId, {
      ...task,
      id: taskId
    });
    
    return res.status(200).json({
      success: sent,
      message: sent ? '✅ Test FCM sent successfully' : '❌ Failed to send FCM',
      task: task,
      timestamp: new Date().toISOString(),
      phTime: getPhilippinesTime().toLocaleString()
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// ==================== TASK CRUD FUNCTIONS ====================

// READ - Get all tasks for a user
async function getTasks(userId, res) {
  try {
    console.log('TASKS_API: Getting tasks for user:', userId);
    
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
      
      console.log('TASKS_API: Found', tasks.length, 'tasks for user:', userId);
    } else {
      console.log('TASKS_API: No tasks found for user:', userId);
    }

    return res.status(200).json({
      success: true,
      message: 'Tasks retrieved successfully',
      data: {
        tasks: tasks,
        totalTasks: tasks.length
      },
      phTime: getPhilippinesTime().toLocaleString()
    });

  } catch (error) {
    console.error('TASKS_API: Error getting tasks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve tasks',
      error: error.message
    });
  }
}

// CREATE - Create a new task with FCM scheduling
async function createTask(userId, taskData, res) {
  try {
    console.log('TASKS_API: Creating task for user:', userId);
    console.log('TASKS_API: Task data:', taskData);

    const { time, name, days, status } = taskData;

    // Validate required fields
    if (!time || !name || !days || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: time, name, days, status'
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phTime: getPhilippinesTime().toLocaleString()
    };

    await newTaskRef.set(task);

    console.log('TASKS_API: Task created successfully with ID:', newTaskRef.key);

    // ✅ STORE REMINDER IN DATABASE
    await scheduleTaskReminder(userId, task);

    return res.status(201).json({
      success: true,
      message: 'Task created successfully - FCM reminder scheduled',
      data: {
        task: task,
        taskId: newTaskRef.key
      },
      phTime: getPhilippinesTime().toLocaleString()
    });

  } catch (error) {
    console.error('TASKS_API: Error creating task:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create task',
      error: error.message
    });
  }
}

// UPDATE - Update an existing task
async function updateTask(userId, taskId, taskData, res) {
  try {
    console.log('TASKS_API: Updating task:', taskId, 'for user:', userId);
    console.log('TASKS_API: Update data:', taskData);

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

    console.log('TASKS_API: Task updated successfully:', taskId);

    // ✅ RESCHEDULE FCM REMINDERS if time or days changed
    if (taskData.time !== oldTask.time || taskData.days !== oldTask.days) {
      console.log('🔄 Time/days changed - rescheduling FCM reminders');
      
      // Delete old pending reminders for this task
      const remindersRef = db.ref('pending_reminders');
      const snapshot = await remindersRef
        .orderByChild('taskId')
        .equalTo(taskId)
        .once('value');
      
      if (snapshot.exists()) {
        const updates = {};
        snapshot.forEach(child => {
          updates[child.key] = null;
        });
        await remindersRef.update(updates);
        console.log(`🗑️ Deleted old reminders for task: ${taskId}`);
      }
      
      // Schedule new reminder
      await scheduleTaskReminder(userId, {
        ...updatedTask,
        id: taskId
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Task updated successfully',
      data: {
        task: updatedTask
      },
      phTime: getPhilippinesTime().toLocaleString()
    });

  } catch (error) {
    console.error('TASKS_API: Error updating task:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update task',
      error: error.message
    });
  }
}

// DELETE - Delete a specific task
async function deleteTask(userId, taskId, res) {
  try {
    console.log('TASKS_API: Deleting task:', taskId, 'for user:', userId);

    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    await taskRef.remove();

    console.log('TASKS_API: Task deleted successfully:', taskId);

    // Delete pending reminders for this task
    const remindersRef = db.ref('pending_reminders');
    const reminderSnapshot = await remindersRef
      .orderByChild('taskId')
      .equalTo(taskId)
      .once('value');
    
    if (reminderSnapshot.exists()) {
      const updates = {};
      reminderSnapshot.forEach(child => {
        updates[child.key] = null;
      });
      await remindersRef.update(updates);
      console.log(`🗑️ Deleted ${reminderSnapshot.numChildren()} pending reminders`);
    }

    return res.status(200).json({
      success: true,
      message: 'Task deleted successfully',
      data: {
        deletedTaskId: taskId
      },
      phTime: getPhilippinesTime().toLocaleString()
    });

  } catch (error) {
    console.error('TASKS_API: Error deleting task:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete task',
      error: error.message
    });
  }
}

// DELETE ALL - Delete all tasks for a user
async function deleteAllTasks(userId, res) {
  try {
    console.log('TASKS_API: Deleting all tasks for user:', userId);

    const tasksRef = db.ref(`tasks/${userId}`);
    const snapshot = await tasksRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'No tasks found to delete'
      });
    }

    const taskCount = snapshot.numChildren();
    await tasksRef.remove();

    console.log('TASKS_API: Deleted', taskCount, 'tasks for user:', userId);

    // Delete all pending reminders for this user
    const remindersRef = db.ref('pending_reminders');
    const reminderSnapshot = await remindersRef
      .orderByChild('userId')
      .equalTo(userId)
      .once('value');
    
    if (reminderSnapshot.exists()) {
      const updates = {};
      reminderSnapshot.forEach(child => {
        updates[child.key] = null;
      });
      await remindersRef.update(updates);
      console.log(`🗑️ Deleted ${reminderSnapshot.numChildren()} pending reminders`);
    }

    return res.status(200).json({
      success: true,
      message: `All ${taskCount} tasks deleted successfully`,
      data: {
        deletedCount: taskCount
      },
      phTime: getPhilippinesTime().toLocaleString()
    });

  } catch (error) {
    console.error('TASKS_API: Error deleting all tasks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete all tasks',
      error: error.message
    });
  }
}

// COMPLETE - Mark a task as complete
async function markTaskComplete(userId, taskId, res) {
  try {
    console.log('TASKS_API: Marking task as complete:', taskId, 'for user:', userId);

    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const currentTask = snapshot.val();
    const updatedTask = {
      ...currentTask,
      status: 'Complete',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await taskRef.set(updatedTask);

    console.log('TASKS_API: Task marked as complete:', taskId);

    // ✅ SEND COMPLETION FCM NOTIFICATION
    await sendTaskCompletionFCM(userId, currentTask);

    return res.status(200).json({
      success: true,
      message: 'Task marked as complete successfully',
      data: {
        task: updatedTask
      },
      phTime: getPhilippinesTime().toLocaleString()
    });

  } catch (error) {
    console.error('TASKS_API: Error marking task complete:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark task as complete',
      error: error.message
    });
  }
}
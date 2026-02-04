const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// DATABASE CONNECTION
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test database connection on startup
pool.connect()
  .then(() => console.log('✅ Database connected'))
  .catch(err => console.error('❌ Database connection error:', err));

// EMAIL HELPERS
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

async function sendEmailNotification(subject, htmlContent) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('Email not configured');
    return false;
  }
  try {
    const info = await emailTransporter.sendMail({
      from: `"Jerry AI - First Financial" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO || 'firstfinancialcanada@gmail.com',
      subject: subject,
      html: htmlContent
    });
    console.log('Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Email error:', error.message);
    return false;
  }
}

function formatPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+1 (${cleaned.slice(1,4)}) ${cleaned.slice(4,7)}-${cleaned.slice(7)}`;
  }
  return phone;
}

// DATABASE HELPER FUNCTIONS

// Get or create customer
async function getOrCreateCustomer(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query('SELECT * FROM customers WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      result = await client.query('INSERT INTO customers (phone) VALUES ($1) RETURNING *', [phone]);
      console.log('New customer created:', phone);
    }
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Get or create active conversation
async function getOrCreateConversation(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM conversations WHERE customerphone = $1 AND status = $2 ORDER BY startedat DESC LIMIT 1',
      [phone, 'active']
    );
    if (result.rows.length === 0) {
      result = await client.query('INSERT INTO conversations (customerphone) VALUES ($1) RETURNING *', [phone]);
      console.log('New conversation started:', phone);
    } else {
      await client.query('UPDATE conversations SET updatedat = CURRENT_TIMESTAMP WHERE id = $1', [result.rows[0].id]);
      console.log('Continuing conversation:', phone);
    }
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Update conversation data
async function updateConversation(conversationId, updates) {
  const client = await pool.connect();
  try {
    const fields = [];
    const values = [];
    let paramCount = 1;
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
    values.push(conversationId);
    await client.query(
      `UPDATE conversations SET ${fields.join(', ')}, updatedat = CURRENT_TIMESTAMP WHERE id = $${paramCount}`,
      values
    );
  } finally {
    client.release();
  }
}

// Update conversation timestamp
async function touchConversation(conversationId) {
  const client = await pool.connect();
  try {
    await client.query('UPDATE conversations SET updatedat = CURRENT_TIMESTAMP WHERE id = $1', [conversationId]);
  } finally {
    client.release();
  }
}

// Check if customer already has an active conversation
async function hasActiveConversation(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id FROM conversations WHERE customerphone = $1 AND status = $2 LIMIT 1',
      [phone, 'active']
    );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

// Delete conversation and its messages
async function deleteConversation(phone) {
  const client = await pool.connect();
  try {
    const conversation = await client.query(
      'SELECT id FROM conversations WHERE customerphone = $1 ORDER BY startedat DESC LIMIT 1',
      [phone]
    );
    if (conversation.rows.length > 0) {
      const conversationId = conversation.rows[0].id;
      await client.query('DELETE FROM messages WHERE conversationid = $1', [conversationId]);
      await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      console.log('Conversation deleted:', phone);
      return true;
    }
    return false;
  } finally {
    client.release();
  }
}

// Save message to database
async function saveMessage(conversationId, phone, role, content) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO messages (conversationid, customerphone, role, content) VALUES ($1, $2, $3, $4)',
      [conversationId, phone, role, content]
    );
  } finally {
    client.release();
  }
}

// Save appointment
async function saveAppointment(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO appointments (customerphone, customername, vehicletype, budget, budgetamount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('Appointment saved:', data.name);
  } finally {
    client.release();
  }
}

// Save callback
async function saveCallback(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO callbacks (customerphone, customername, vehicletype, budget, budgetamount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('Callback saved:', data.name);
  } finally {
    client.release();
  }
}

// Log analytics event
async function logAnalytics(eventType, phone, data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO analytics (eventtype, customerphone, data) VALUES ($1, $2, $3)',
      [eventType, phone, JSON.stringify(data)]
    );
  } finally {
    client.release();
  }
}
// JERRY AI RESPONSE LOGIC
async function getJerryResponse(phone, userMessage, conversation) {
  const message = userMessage.toLowerCase().trim();
  
  // Stage 1: Initial greeting and vehicle type
  if (!conversation.stage || conversation.stage === 'initial') {
    if (message.includes('truck') || message.includes('pickup')) {
      await updateConversation(conversation.id, { 
        stage: 'budget',
        vehicletype: 'Truck'
      });
      return "Awesome! Trucks are great. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)";
    }
    if (message.includes('car') || message.includes('sedan') || message.includes('suv')) {
      const type = message.includes('suv') ? 'SUV' : 'Car';
      await updateConversation(conversation.id, { 
        stage: 'budget',
        vehicletype: type
      });
      return `Perfect! ${type}s are popular. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    return "Hi! I'm Jerry, your vehicle specialist at First Financial. What type of vehicle are you looking for? (Truck, Car, SUV)";
  }
  
  // Stage 2: Budget
  if (conversation.stage === 'budget') {
    const budgetMatch = message.match(/\$?(\d+)k?/i);
    if (budgetMatch) {
      const amount = parseInt(budgetMatch[1]) * (message.includes('k') ? 1000 : 1);
      await updateConversation(conversation.id, { 
        stage: 'name',
        budget: `$${amount}`,
        budgetamount: amount
      });
      return "Great! I can help with that budget. What's your name?";
    }
    return "What's your budget range? (e.g., $15k, $25k, $40k, $60k+)";
  }
  
  // Stage 3: Name
  if (conversation.stage === 'name') {
    await updateConversation(conversation.id, { 
      stage: 'appointment',
      customername: userMessage.trim()
    });
    return `Nice to meet you, ${userMessage.trim()}! Would you like to:\n1. Schedule an appointment\n2. Request a callback\n\nReply with 1 or 2`;
  }
  
  // Stage 4: Appointment or callback
  if (conversation.stage === 'appointment') {
    if (message.includes('1') || message.includes('appointment')) {
      await updateConversation(conversation.id, { stage: 'datetime' });
      return "When would you like to come in? (e.g., 'Tomorrow at 2pm', 'Friday morning')";
    }
    if (message.includes('2') || message.includes('callback')) {
      await updateConversation(conversation.id, { stage: 'datetime' });
      return "When's a good time to call you? (e.g., 'Tomorrow at 2pm', 'Friday morning')";
    }
    return "Reply with 1 for appointment or 2 for callback";
  }
  
  // Stage 5: Date/time and completion
  if (conversation.stage === 'datetime') {
    const appointmentData = {
      phone: phone,
      name: conversation.customername,
      vehicleType: conversation.vehicletype,
      budget: conversation.budget,
      budgetAmount: conversation.budgetamount,
      datetime: userMessage.trim()
    };
    
    if (conversation.lastmessage && (conversation.lastmessage.includes('appointment') || conversation.lastmessage.includes('come in'))) {
      await saveAppointment(appointmentData);
      await updateConversation(conversation.id, { 
        stage: 'complete',
        status: 'converted'
      });
      return `Perfect! I've booked your appointment for ${userMessage.trim()}. We'll see you at First Financial Canada! If you need to change it, just text back. 🚗`;
    } else {
      await saveCallback(appointmentData);
      await updateConversation(conversation.id, { 
        stage: 'complete',
        status: 'converted'
      });
      return `Perfect! We'll call you at ${userMessage.trim()}. Talk soon! If anything changes, just text back. 📞`;
    }
  }
  
  // Fallback
  return "I didn't quite catch that. Can you rephrase?";
}

// ROUTES

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE - Database Edition',
    database: 'PostgreSQL Connected',
    endpoints: {
      startSms: '/api/start-sms',
      webhook: '/api/sms-webhook',
      dashboard: '/dashboard',
      apiDashboard: '/api/dashboard',
      conversations: '/api/conversations',
      conversation: '/api/conversation/:phone',
      deleteConversation: 'DELETE /api/conversation/:phone',
      manualReply: 'POST /api/manual-reply',
      testEmail: '/test-email',
      exportAppointments: '/api/export/appointments',
      exportCallbacks: '/api/export/callbacks',
      exportConversations: '/api/export/conversations',
      exportAnalytics: '/api/export/analytics'
    },
    timestamp: new Date()
  });
});

// ✅ FIXED WEBHOOK - This is the only change in your file
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From: phone, Body: message } = req.body;
    console.log('📨 Received from:', phone);
    console.log('📨 Message:', message);

    await getOrCreateCustomer(phone);
    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'user', message);

    // Email notification
    try {
      const emailSubject = `New Message from ${conversation.customername || formatPhone(phone)}`;
      const emailBody = `<div style="font-family:Arial;max-width:600px"><div style="background:linear-gradient(135deg,#1e3a5f 0%,#2c4e6f 100%);padding:20px;border-radius:10px 10px 0 0"><h1 style="color:white;margin:0">📱 New Customer Message</h1></div><div style="background:#f7fafc;padding:25px;border-radius:0 0 10px 10px"><table><tr><td style="padding:12px;font-weight:bold">Phone</td><td style="padding:12px">${formatPhone(phone)}</td></tr><tr><td style="padding:12px;font-weight:bold">Name</td><td style="padding:12px">${conversation.customername || 'Not provided'}</td></tr><tr><td style="padding:12px;font-weight:bold">Message</td><td style="padding:12px;font-weight:600">${message}</td></tr></table></div></div>`;
      await sendEmailNotification(emailSubject, emailBody);
    } catch (err) {
      console.error('Email error:', err);
    }

    await touchConversation(conversation.id);
    await logAnalytics('messagereceived', phone, { message });

    // Get AI response
    const aiResponse = await getJerryResponse(phone, message, conversation);
    await saveMessage(conversation.id, phone, 'assistant', aiResponse);

    // ✅ FIX: Actually send the SMS using Twilio client API
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const client = twilio(accountSid, authToken);

    await client.messages.create({
      body: aiResponse,
      from: fromNumber,
      to: phone
    });

    console.log('✅ Jerry replied and SMS sent:', aiResponse);

    // Store last message for context
    await updateConversation(conversation.id, { lastmessage: aiResponse });

    // Return empty TwiML (required by Twilio webhook)
    const twiml = new twilio.twiml.MessagingResponse();
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ Webhook error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    res.type('text/xml').send(twiml.toString());
  }
});

// Manual reply from dashboard
app.post('/api/manual-reply', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }

    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'assistant', message);
    await touchConversation(conversation.id);

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const client = twilio(accountSid, authToken);

    await client.messages.create({
      body: message,
      from: fromNumber,
      to: phone
    });

    console.log('Manual reply sent to:', phone);
    res.json({ success: true, message: 'Reply sent successfully' });
  } catch (error) {
    console.error('Manual reply error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start SMS campaign
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }

    const hasActive = await hasActiveConversation(phone);
    if (hasActive) {
      return res.status(400).json({ 
        error: 'Customer already has an active conversation',
        suggestion: 'Delete the existing conversation first or send a manual reply'
      });
    }

    await getOrCreateCustomer(phone);
    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'assistant', message);
    await logAnalytics('campaignstarted', phone, { message });

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const client = twilio(accountSid, authToken);

    await client.messages.create({
      body: message,
      from: fromNumber,
      to: phone
    });

    console.log('Campaign started for:', phone);
    res.json({ success: true, message: 'SMS sent successfully' });
  } catch (error) {
    console.error('Start SMS error:', error);
    res.status(500).json({ error: error.message });
  }
});
// Get all conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM conversations ORDER BY updatedat DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single conversation with messages
app.get('/api/conversation/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const conversation = await pool.query(
      'SELECT * FROM conversations WHERE customerphone = $1 ORDER BY startedat DESC LIMIT 1',
      [phone]
    );
    
    if (conversation.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await pool.query(
      'SELECT * FROM messages WHERE conversationid = $1 ORDER BY createdat ASC',
      [conversation.rows[0].id]
    );

    res.json({
      conversation: conversation.rows[0],
      messages: messages.rows
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete conversation
app.delete('/api/conversation/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const deleted = await deleteConversation(phone);
    
    if (deleted) {
      res.json({ success: true, message: 'Conversation deleted' });
    } else {
      res.status(404).json({ error: 'Conversation not found' });
    }
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats API
app.get('/api/dashboard', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT customerphone) as total_conversations,
        COUNT(*) FILTER (WHERE status = 'active') as active_conversations,
        COUNT(*) FILTER (WHERE status = 'converted') as conversions
      FROM conversations
    `);

    const appointments = await pool.query('SELECT COUNT(*) as count FROM appointments');
    const callbacks = await pool.query('SELECT COUNT(*) as count FROM callbacks');

    res.json({
      stats: stats.rows[0],
      appointments: parseInt(appointments.rows[0].count),
      callbacks: parseInt(callbacks.rows[0].count)
    });
  } catch (error) {
    console.error('Dashboard API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export appointments as CSV
app.get('/api/export/appointments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM appointments ORDER BY createdat DESC');
    const csv = [
      'Phone,Name,Vehicle Type,Budget,Budget Amount,Date/Time,Created At',
      ...result.rows.map(row => 
        `${row.customerphone},"${row.customername}","${row.vehicletype}","${row.budget}",${row.budgetamount},"${row.datetime}","${row.createdat}"`
      )
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="appointments.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send('Export failed');
  }
});

// Export callbacks as CSV
app.get('/api/export/callbacks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM callbacks ORDER BY createdat DESC');
    const csv = [
      'Phone,Name,Vehicle Type,Budget,Budget Amount,Date/Time,Created At',
      ...result.rows.map(row => 
        `${row.customerphone},"${row.customername}","${row.vehicletype}","${row.budget}",${row.budgetamount},"${row.datetime}","${row.createdat}"`
      )
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="callbacks.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send('Export failed');
  }
});

// Export conversations as CSV
app.get('/api/export/conversations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM conversations ORDER BY startedat DESC');
    const csv = [
      'Phone,Name,Vehicle Type,Budget,Stage,Status,Started At,Updated At',
      ...result.rows.map(row => 
        `${row.customerphone},"${row.customername || ''}","${row.vehicletype || ''}","${row.budget || ''}","${row.stage}","${row.status}","${row.startedat}","${row.updatedat}"`
      )
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversations.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send('Export failed');
  }
});

// Export analytics as CSV
app.get('/api/export/analytics', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM analytics ORDER BY createdat DESC');
    const csv = [
      'Event Type,Phone,Data,Created At',
      ...result.rows.map(row => 
        `"${row.eventtype}",${row.customerphone},"${JSON.stringify(row.data).replace(/"/g, '""')}","${row.createdat}"`
      )
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send('Export failed');
  }
});

// Test email endpoint
app.get('/test-email', async (req, res) => {
  const success = await sendEmailNotification(
    'Test Email from Jerry AI',
    '<h1>Test Email</h1><p>If you received this, email notifications are working!</p>'
  );
  res.json({ success, message: success ? 'Email sent!' : 'Email failed' });
});

// Interactive HTML Dashboard
app.get('/dashboard', async (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Jerry AI Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1e3a5f 0%, #2c4e6f 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { color: white; margin-bottom: 30px; font-size: 2.5rem; text-align: center; }
    
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
    }
    .stat-card h3 {
      color: #1e3a5f;
      font-size: 0.9rem;
      margin-bottom: 10px;
      text-transform: uppercase;
    }
    .stat-card .number {
      font-size: 2.5rem;
      font-weight: bold;
      color: #333;
    }
    
    .section {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    .section h2 {
      color: #333;
      margin-bottom: 20px;
      border-bottom: 2px solid #1e3a5f;
      padding-bottom: 10px;
      font-size: 1.5rem;
    }
    
    .launch-form { display: grid; gap: 15px; max-width: 600px; }
    .form-group label {
      display: block;
      font-weight: 600;
      margin-bottom: 8px;
      color: #333;
    }
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 1rem;
      font-family: inherit;
    }
    .form-group input:focus, .form-group textarea:focus {
      outline: none;
      border-color: #1e3a5f;
    }
    .form-group textarea {
      min-height: 120px;
      resize: vertical;
    }
    
    .btn-send {
      background: #1e3a5f;
      color: white;
      border: none;
      padding: 15px 30px;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
    }
    .btn-send:hover { background: #152d4a; }
    .btn-send:disabled { background: #ccc; cursor: not-allowed; }
    
    .message-result {
      padding: 15px;
      border-radius: 8px;
      margin-top: 15px;
      display: none;
    }
    .message-result.success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #34d399;
    }
    .message-result.error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #f87171;
    }
    
    .conversation-list {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    .conversation-item {
      padding: 20px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
    }
    .conversation-item:hover {
      border-color: #1e3a5f;
      background: #f0f4f8;
      transform: translateX(5px);
    }
    .conversation-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .conversation-info { flex: 1; }
    
    .btn-delete {
      background: #ef4444;
      color: white;
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-size: 1.2rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s;
      flex-shrink: 0;
      margin-left: 15px;
    }
    .btn-delete:hover {
      background: #dc2626;
      transform: scale(1.1);
    }
    
    .conversation-item .phone {
      font-weight: bold;
      font-size: 1.1rem;
      color: #333;
    }
    .conversation-item .name {
      color: #1e3a5f;
      font-size: 0.9rem;
      margin-left: 10px;
    }
    .conversation-item .info {
      color: #666;
      font-size: 0.85rem;
      margin-top: 8px;
    }
    
    .conversation-item .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      margin-left: 10px;
      font-weight: 600;
    }
    .badge-active { background: #4ade80; color: white; }
    .badge-converted { background: #1e3a5f; color: white; }
    .badge-stopped { background: #ef4444; color: white; }
    
    .messages-container {
      display: none;
      margin-top: 20px;
      padding: 20px;
      background: #f0f4f8;
      border-radius: 8px;
      border: 2px solid #1e3a5f;
    }
    .messages-title {
      font-weight: bold;
      color: #1e3a5f;
      margin-bottom: 15px;
      font-size: 1.1rem;
    }
    
    .message {
      padding: 15px;
      margin-bottom: 10px;
      border-radius: 8px;
      max-width: 80%;
    }
    .message.user {
      background: #d6e4f0;
      margin-left: auto;
      text-align: right;
    }
    .message.assistant {
      background: #fff;
      border: 1px solid #e0e0e0;
    }
    .message .role {
      font-weight: bold;
      font-size: 0.8rem;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .message.user .role { color: #1e3a5f; }
    .message.assistant .role { color: #764ba2; }
    .message .content {
      color: #333;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .message .time {
      font-size: 0.75rem;
      color: #666;
      margin-top: 5px;
    }
    
    .reply-form {
      margin-top: 20px;
      padding: 20px;
      background: white;
      border-radius: 8px;
      border: 2px solid #1e3a5f;
    }
    .reply-form h4 {
      color: #1e3a5f;
      margin-bottom: 15px;
      font-size: 1rem;
    }
    .reply-input-group {
      display: flex;
      gap: 10px;
    }
    .reply-input {
      flex: 1;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
    }
    .reply-input:focus {
      outline: none;
      border-color: #1e3a5f;
    }
    .btn-reply {
      background: #1e3a5f;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
      white-space: nowrap;
    }
    .btn-reply:hover { background: #152d4a; }
    .btn-reply:disabled { background: #ccc; cursor: not-allowed; }
    
    .reply-status {
      margin-top: 10px;
      padding: 10px;
      border-radius: 6px;
      font-size: 0.9rem;
      display: none;
    }
    .reply-status.success {
      background: #d1fae5;
      color: #065f46;
    }
    .reply-status.error {
      background: #fee2e2;
      color: #991b1b;
    }
    
    .loading {
      text-align: center;
      color: #666;
      padding: 40px;
    }
    .empty-state {
      text-align: center;
      color: #999;
      padding: 40px;
      font-style: italic;
    }
    
    @media (max-width: 768px) {
      h1 { font-size: 1.8rem; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .section { padding: 20px; }
      .reply-input-group { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚗 Jerry AI Dashboard</h1>
    
    <!-- Export Section -->
    <div style="max-width: 1200px; margin: 20px auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
      <h2 style="margin: 0 0 10px 0; color: #2d3748;">📊 Export Data to CSV</h2>
      <p style="color: #718096; margin-bottom: 25px;">Download data for Excel/Google Sheets</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
        <a href="/api/export/appointments" download style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(16,185,129,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">📅 Appointments</a>
        <a href="/api/export/callbacks" download style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(245,158,11,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">📞 Callbacks</a>
        <a href="/api/export/conversations" download style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(59,130,246,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">💬 Conversations</a>
        <a href="/api/export/analytics" download style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(139,92,246,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">📈 Analytics</a>
      </div>
    </div>
    
    <!-- Stats Section -->
    <div class="stats">
      <div class="stat-card">
        <h3>Total Conversations</h3>
        <div class="number" id="stat-total">-</div>
      </div>
      <div class="stat-card">
        <h3>Active Conversations</h3>
        <div class="number" id="stat-active">-</div>
      </div>
      <div class="stat-card">
        <h3>Conversions</h3>
        <div class="number" id="stat-conversions">-</div>
      </div>
      <div class="stat-card">
        <h3>Appointments</h3>
        <div class="number" id="stat-appointments">-</div>
      </div>
      <div class="stat-card">
        <h3>Callbacks</h3>
        <div class="number" id="stat-callbacks">-</div>
      </div>
    </div>
    
    <!-- Launch Campaign Section -->
    <div class="section">
      <h2>🚀 Launch SMS Campaign</h2>
      <form class="launch-form" id="launch-form">
        <div class="form-group">
          <label>Customer Phone Number</label>
          <input type="tel" id="phone" placeholder="+15873066133" required>
        </div>
        <div class="form-group">
          <label>Opening Message</label>
          <textarea id="message" placeholder="Hi! I'm Jerry from First Financial. I saw you were interested in a vehicle..." required></textarea>
        </div>
        <button type="submit" class="btn-send">Send SMS</button>
        <div class="message-result" id="result"></div>
      </form>
    </div>
    
    <!-- Active Conversations Section -->
    <div class="section">
      <h2>💬 Active Conversations</h2>
      <div class="conversation-list" id="conversations">
        <div class="loading">Loading conversations...</div>
      </div>
    </div>
  </div>

  <script>
    let conversations = [];
    
    // Load dashboard data
    async function loadDashboard() {
      try {
        const response = await fetch('/api/dashboard');
        const data = await response.json();
        
        document.getElementById('stat-total').textContent = data.stats.total_conversations || 0;
        document.getElementById('stat-active').textContent = data.stats.active_conversations || 0;
        document.getElementById('stat-conversions').textContent = data.stats.conversions || 0;
        document.getElementById('stat-appointments').textContent = data.appointments || 0;
        document.getElementById('stat-callbacks').textContent = data.callbacks || 0;
      } catch (error) {
        console.error('Error loading dashboard:', error);
      }
    }
    
    // Load conversations
    async function loadConversations() {
      try {
        const response = await fetch('/api/conversations');
        conversations = await response.json();
        renderConversations();
      } catch (error) {
        console.error('Error loading conversations:', error);
        document.getElementById('conversations').innerHTML = '<div class="empty-state">Failed to load conversations</div>';
      }
    }
    
    // Render conversations
    function renderConversations() {
      const container = document.getElementById('conversations');
      
      if (conversations.length === 0) {
        container.innerHTML = '<div class="empty-state">No conversations yet. Launch a campaign to get started!</div>';
        return;
      }
      
      container.innerHTML = conversations.map(conv => {
        const badgeClass = conv.status === 'active' ? 'badge-active' : conv.status === 'converted' ? 'badge-converted' : 'badge-stopped';
        return \`
          <div class="conversation-item" data-phone="\${conv.customerphone}">
            <div class="conversation-header">
              <div class="conversation-info" onclick="toggleMessages('\${conv.customerphone}')">
                <div>
                  <span class="phone">\${formatPhone(conv.customerphone)}</span>
                  \${conv.customername ? \`<span class="name">\${conv.customername}</span>\` : ''}
                  <span class="badge \${badgeClass}">\${conv.status}</span>
                </div>
                <div class="info">
                  Stage: \${conv.stage} | Vehicle: \${conv.vehicletype || 'Not set'} | Budget: \${conv.budget || 'Not set'}
                </div>
              </div>
              <button class="btn-delete" onclick="deleteConversation('\${conv.customerphone}', event)" title="Delete conversation">×</button>
            </div>
            <div class="messages-container" id="messages-\${conv.customerphone}"></div>
          </div>
        \`;
      }).join('');
    }
    
    // Format phone number
    function formatPhone(phone) {
      const cleaned = phone.replace(/\D/g, '');
      if (cleaned.length === 11 && cleaned.startsWith('1')) {
        return \`+1 (\${cleaned.slice(1,4)}) \${cleaned.slice(4,7)}-\${cleaned.slice(7)}\`;
      }
      return phone;
    }
    
    // Toggle messages
    async function toggleMessages(phone) {
      const container = document.getElementById(\`messages-\${phone}\`);
      
      if (container.style.display === 'block') {
        container.style.display = 'none';
        return;
      }
      
      container.innerHTML = '<div class="loading">Loading messages...</div>';
      container.style.display = 'block';
      
      try {
        const response = await fetch(\`/api/conversation/\${encodeURIComponent(phone)}\`);
        const data = await response.json();
        
        const messagesHTML = data.messages.map(msg => \`
          <div class="message \${msg.role}">
            <div class="role">\${msg.role === 'user' ? 'Customer' : 'Jerry AI'}</div>
            <div class="content">\${msg.content}</div>
            <div class="time">\${new Date(msg.createdat).toLocaleString()}</div>
          </div>
        \`).join('');
        
        container.innerHTML = \`
          <div class="messages-title">💬 Conversation Messages</div>
          \${messagesHTML}
          <div class="reply-form">
            <h4>Send Manual Reply</h4>
            <div class="reply-input-group">
              <input type="text" class="reply-input" id="reply-\${phone}" placeholder="Type your message...">
              <button class="btn-reply" onclick="sendReply('\${phone}')">Send</button>
            </div>
            <div class="reply-status" id="reply-status-\${phone}"></div>
          </div>
        \`;
      } catch (error) {
        console.error('Error loading messages:', error);
        container.innerHTML = '<div class="empty-state">Failed to load messages</div>';
      }
    }
    
    // Send manual reply
    async function sendReply(phone) {
      const input = document.getElementById(\`reply-\${phone}\`);
      const status = document.getElementById(\`reply-status-\${phone}\`);
      const message = input.value.trim();
      
      if (!message) {
        status.textContent = 'Please enter a message';
        status.className = 'reply-status error';
        status.style.display = 'block';
        return;
      }
      
      try {
        const response = await fetch('/api/manual-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message })
        });
        
        if (response.ok) {
          status.textContent = '✅ Reply sent successfully!';
          status.className = 'reply-status success';
          status.style.display = 'block';
          input.value = '';
          setTimeout(() => toggleMessages(phone), 1000);
        } else {
          const error = await response.json();
          status.textContent = \`❌ \${error.error}\`;
          status.className = 'reply-status error';
          status.style.display = 'block';
        }
      } catch (error) {
        status.textContent = '❌ Failed to send reply';
        status.className = 'reply-status error';
        status.style.display = 'block';
      }
    }
    
    // Delete conversation
    async function deleteConversation(phone, event) {
      event.stopPropagation();
      
      if (!confirm(\`Delete conversation with \${formatPhone(phone)}?\`)) {
        return;
      }
      
      try {
        const response = await fetch(\`/api/conversation/\${encodeURIComponent(phone)}\`, {
          method: 'DELETE'
        });
        
        if (response.ok) {
          await loadConversations();
          await loadDashboard();
        } else {
          alert('Failed to delete conversation');
        }
      } catch (error) {
        console.error('Error deleting conversation:', error);
        alert('Failed to delete conversation');
      }
    }
    
    // Launch campaign form handler
    document.getElementById('launch-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const phone = document.getElementById('phone').value;
      const message = document.getElementById('message').value;
      const result = document.getElementById('result');
      const btn = e.target.querySelector('.btn-send');
      
      btn.disabled = true;
      btn.textContent = 'Sending...';
      
      try {
        const response = await fetch('/api/start-sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          result.textContent = '✅ SMS sent successfully!';
          result.className = 'message-result success';
          result.style.display = 'block';
          document.getElementById('phone').value = '';
          document.getElementById('message').value = '';
          await loadConversations();
          await loadDashboard();
        } else {
          result.textContent = \`❌ \${data.error}\`;
          result.className = 'message-result error';
          result.style.display = 'block';
        }
      } catch (error) {
        result.textContent = '❌ Failed to send SMS';
        result.className = 'message-result error';
        result.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send SMS';
      }
    });
    
    // Initial load
    loadDashboard();
    loadConversations();
    
    // Auto-refresh every 10 seconds
    setInterval(() => {
      loadDashboard();
      loadConversations();
    }, 10000);
  </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(\`🚀 Jerry AI Backend running on http://\${HOST}:\${PORT}\`);
  console.log(\`📊 Dashboard: http://\${HOST}:\${PORT}/dashboard\`);
});

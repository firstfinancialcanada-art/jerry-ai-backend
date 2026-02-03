const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Store conversations (use database in production)
const conversations = {};

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE',
    twoway_sms: 'Ready',
    backend_url: `https://${req.get('host')}/api`
  });
});

// Start SMS conversation
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    conversations[phone] = {
      messages: [],
      started: new Date(),
      status: 'active',
      stage: 'greeting',
      data: {}
    };
    
    const initialMessage = message || "Hi! 👋 I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)";
    
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: initialMessage
    });
    
    conversations[phone].messages.push({ role: 'assistant', content: initialMessage });
    
    res.json({ success: true, message: 'SMS conversation started!' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Twilio Webhook - Incoming SMS
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;
    const customerPhone = From;
    const customerMessage = Body.trim();
    
    console.log('📱 SMS from:', customerPhone, '- Message:', customerMessage);
    
    // Initialize if doesn't exist
    if (!conversations[customerPhone]) {
      conversations[customerPhone] = {
        messages: [],
        started: new Date(),
        status: 'active',
        stage: 'greeting',
        data: {}
      };
    }
    
    conversations[customerPhone].messages.push({ role: 'user', content: customerMessage });
    
    // Get intelligent response
    const aiResponse = await getJerryResponse(customerPhone, customerMessage);
    
    // Send via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);
    
    conversations[customerPhone].messages.push({ role: 'assistant', content: aiResponse });
    
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('❌ Webhook error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm having trouble right now. Please call us at (403) 555-0100!");
    res.type('text/xml').send(twiml.toString());
  }
});

// Intelligent Jerry AI Response
async function getJerryResponse(phone, message) {
  const conversation = conversations[phone];
  const lowerMsg = message.toLowerCase();
  
  // Check for STOP
  if (lowerMsg === 'stop') {
    conversation.status = 'stopped';
    return "You've been unsubscribed. Reply START to resume.";
  }
  
  // Stage 1: Vehicle Interest
  if (conversation.stage === 'greeting' || !conversation.data.vehicleType) {
    if (lowerMsg.includes('suv') || lowerMsg.includes('truck') || lowerMsg.includes('sedan') || 
        lowerMsg.includes('car') || lowerMsg.includes('vehicle') || lowerMsg.includes('yes') || 
        lowerMsg.includes('interested')) {
      
      // Extract vehicle type
      if (lowerMsg.includes('suv')) conversation.data.vehicleType = 'SUV';
      else if (lowerMsg.includes('truck')) conversation.data.vehicleType = 'Truck';
      else if (lowerMsg.includes('sedan')) conversation.data.vehicleType = 'Sedan';
      else conversation.data.vehicleType = 'Vehicle';
      
      conversation.stage = 'budget';
      return `Great choice! What's your budget range for a ${conversation.data.vehicleType}? (Under $30k, $30k-$50k, $50k+)`;
    }
    return "What type of vehicle interests you? We have SUVs, Trucks, Sedans, and more!";
  }
  
  // Stage 2: Budget
  if (conversation.stage === 'budget' && !conversation.data.budget) {
    if (lowerMsg.includes('30') || lowerMsg.includes('50') || lowerMsg.includes('k') || 
        lowerMsg.includes('$') || lowerMsg.includes('thousand')) {
      
      if (lowerMsg.includes('30')) conversation.data.budget = 'Under $30k';
      else if (lowerMsg.includes('50')) conversation.data.budget = '$30k-$50k';
      else conversation.data.budget = '$50k+';
      
      conversation.stage = 'appointment';
      return `Perfect! I have some great ${conversation.data.vehicleType}s in that range. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!`;
    }
    return "What's your budget? (e.g., Under $30k, $30k-$50k, or $50k+)";
  }
  
  // Stage 3: Appointment/Callback
  if (conversation.stage === 'appointment') {
    if (lowerMsg.includes('1') || lowerMsg.includes('test') || lowerMsg.includes('drive') || lowerMsg.includes('appointment')) {
      conversation.data.intent = 'test_drive';
      conversation.stage = 'name';
      return "Awesome! What's your name?";
    }
    
    if (lowerMsg.includes('2') || lowerMsg.includes('call') || lowerMsg.includes('phone')) {
      conversation.data.intent = 'callback';
      conversation.stage = 'name';
      return "Great! What's your name?";
    }
    
    return "Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!";
  }
  
  // Stage 4: Get Name
  if (conversation.stage === 'name' && !conversation.data.name) {
    conversation.data.name = message;
    conversation.stage = 'datetime';
    
    if (conversation.data.intent === 'test_drive') {
      return `Nice to meet you, ${message}! When works best for your test drive? (e.g., Tomorrow afternoon, This Saturday, Next week)`;
    } else {
      return `Nice to meet you, ${message}! When's the best time to call you? (e.g., Tomorrow morning, This afternoon, Evening)`;
    }
  }
  
  // Stage 5: Date/Time
  if (conversation.stage === 'datetime' && !conversation.data.datetime) {
    conversation.data.datetime = message;
    conversation.stage = 'confirmed';
    
    if (conversation.data.intent === 'test_drive') {
      return `✅ Perfect ${conversation.data.name}! I've booked your test drive for ${message}. We'll text you the day before with our address. Excited to see you! Reply STOP to opt out.`;
    } else {
      return `✅ Got it ${conversation.data.name}! We'll call you ${message}. Looking forward to helping you find your perfect ${conversation.data.vehicleType}! Reply STOP to opt out.`;
    }
  }
  
  // Default helpful response
  return "Thanks for your message! To help you better, let me know:\n• What vehicle type interests you?\n• Your budget range?\n• If you'd like a test drive or callback?";
}

// Regular chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-small-chat',
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await response.json();
    res.json({ success: true, message: data.choices[0].message.content });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend with 2-Way SMS on port ${PORT}`);
});

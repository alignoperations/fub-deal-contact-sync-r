require('dotenv').config(); 
const express = require('express'); 
const cors = require('cors'); 
const helmet = require('helmet'); 
const morgan = require('morgan'); 
const compression = require('compression'); 
const rateLimit = require('express-rate-limit'); 
const { FollowUpBossAutomation } = require('./src/automation'); 
 
const app = express(); 
 
app.use(helmet()); 
app.use(cors()); 
app.use(compression()); 
app.use(morgan('combined')); 
app.use(express.json()); 
 
const automation = new FollowUpBossAutomation({ 
  followUpBossApiKey: process.env.FOLLOWUPBOSS_API_KEY, 
  slackBotToken: process.env.SLACK_BOT_TOKEN, 
  asanaAccessToken: process.env.ASANA_ACCESS_TOKEN 
}); 
 
app.get('/', (req, res) => { 
  res.json({ status: 'running', service: 'FUB Deal Contact Sync' }); 
}); 
 
app.get('/health', (req, res) => { 
  res.json({ status: 'healthy' }); 
}); 
 
app.post('/webhook/followupboss/deal-updated', automation.handleWebhook.bind(automation)); 
 
const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => console.log(`Server running on port ${PORT}`)); 

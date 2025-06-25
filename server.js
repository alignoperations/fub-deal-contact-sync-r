cat > server.js << 'EOF'
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
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP'
});
app.use('/webhook', limiter);

app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const automation = new FollowUpBossAutomation({
  followUpBossApiKey: process.env.FOLLOWUPBOSS_API_KEY,
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  asanaAccessToken: process.env.ASANA_ACCESS_TOKEN
});

app.get('/', (req, res) => {
  res.json({
    service: 'Follow Up Boss Automation',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook/followupboss/deal-updated', 
  automation.handleWebhook.bind(automation)
);

if (process.env.NODE_ENV !== 'production') {
  app.post('/test/webhook', (req, res) => {
    console.log('Test webhook received:', req.body);
    res.json({ message: 'Test webhook received', data: req.body });
  });
}

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Follow Up Boss automation server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Webhook URL: /webhook/followupboss/deal-updated`);
});

module.exports = app;
EOF
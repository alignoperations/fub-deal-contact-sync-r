const axios = require('axios');

class FollowUpBossAutomation {
  constructor(config) {
    this.config = config;
  }

  async handleWebhook(req, res) {
    try {
      console.log('Webhook received:', req.body);
      res.json({ message: 'Webhook processed successfully' });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = { FollowUpBossAutomation };
const axios = require('axios'); 
 
class FollowUpBossAutomation { 
  constructor(config) { 
    this.config = { 
      followUpBoss: { 
        apiKey: config.followUpBossApiKey, 
        baseUrl: 'https://api.followupboss.com/v1' 
      }, 
      slack: { 
        botToken: config.slackBotToken 
      }, 
      asana: { 
        accessToken: config.asanaAccessToken 
      } 
    }; 
 
    this.stageLookupTable = { 
      'Agency': 'Agency', 
      'Offers Submitted': 'Submitting offers', 
      'Submitting Applications': 'Application Submitted', 
      'Active Off-Market': 'Active Off Market Listing', 
      'Send Referral Agreement': 'Referral Out Open', 
      'Referral Under Contract': 'Referral Out Under Contract', 
      'Referral Closed': 'Referral Out Closed' 
    }; 
  } 
 
  async handleWebhook(req, res) { 
    try { 
      const dealData = req.body; 
      console.log('=== FULL WEBHOOK DATA ===');
      console.log(JSON.stringify(dealData, null, 2));
      console.log('=== END WEBHOOK DATA ===');
      console.log('Deal ID:', dealData.id);
      console.log('Stage:', dealData.stage);
      console.log('Pipeline:', dealData.pipeline); 
      res.json({ message: 'Webhook received', id: dealData.id }); 
    } catch (error) { 
      console.error('Error:', error); 
      res.status(500).json({ error: error.message }); 
    } 
  } 
} 
 
module.exports = { FollowUpBossAutomation }; 

echo const axios = require('axios'); > src\automation.js
echo. >> src\automation.js
echo class FollowUpBossAutomation { >> src\automation.js
echo   constructor(config) { >> src\automation.js
echo     this.config = config; >> src\automation.js
echo   } >> src\automation.js
echo. >> src\automation.js
echo   async handleWebhook(req, res) { >> src\automation.js
echo     try { >> src\automation.js
echo       console.log('Webhook received:', req.body); >> src\automation.js
echo       res.json({ message: 'Webhook processed successfully' }); >> src\automation.js
echo     } catch (error) { >> src\automation.js
echo       console.error('Error:', error); >> src\automation.js
echo       res.status(500).json({ error: error.message }); >> src\automation.js
echo     } >> src\automation.js
echo   } >> src\automation.js
echo } >> src\automation.js
echo. >> src\automation.js
echo module.exports = { FollowUpBossAutomation }; >> src\automation.js
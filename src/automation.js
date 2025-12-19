const axios = require('axios');

class FollowUpBossAutomation {
    constructor(config) {
        // Validate required configuration
        this.validateConfig(config);

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
            },
            enableAsanaNoContactTasks: config.enableAsanaNoContactTasks !== undefined ? config.enableAsanaNoContactTasks : false,  // Set to false to disable Asana task creation
            timeouts: {
                api: config.apiTimeout || 15000,  // Configurable API timeout (default 15s)
                slack: config.slackTimeout || 10000  // Configurable Slack timeout (default 10s)
            }
        };
        
        this.stageLookupTable = {
            'Offers Submitted': 'Submitting offers',
            'Send Referral Agreement': 'Referral Out Open',
            'Referral Under Contract': 'Referral Out Under Contract',
            'Referral Closed': 'Referral Out Closed'
        };

        // Special one-way mappings: Deal -> Contact (but Contact should NOT update Deal back)
        // These require adding the "TriggeredDealContactStageUpdates" tag
        this.specialOneWayMappings = {
            'Expired': 'Nurture',
            'Active Off-Market': 'Active listing',
            'Active Office Exclusive': 'Active listing',
            'Submitting Applications': 'Submitting offers',
            'Application Accepted': 'Under Contract',
            'Application Rejected': 'Submitting offers',
            'Attorney Review': 'Submitting offers',
            'Offer Rejected': 'Submitting offers',
            'Pre-Listing': 'Listing Agreement',
            'Working with Another Agent': 'Nurture',
            'Cancelled': 'Nurture',
            'Fall Through': 'Met with Customer',
            'Temporarily Off Market': 'Listing Agreement'
        };

        // Deal stages that should also get the !AgentReview tag
        this.agentReviewStages = [
            'Cancelled',
            'Fall Through',
            'Expired',
            'Working with Another Agent'
        ];

        this.processedDeals = new Set();
        
        // Cleanup processedDeals every 30 minutes to prevent memory leaks
        this.cleanupInterval = setInterval(() => {
            const size = this.processedDeals.size;
            if (size > 1000) {
                console.log(`WARNING: processedDeals Set has ${size} entries, clearing to prevent memory issues`);
                this.processedDeals.clear();
            }
        }, 30 * 60 * 1000);
    }

    validateConfig(config) {
        const required = ['followUpBossApiKey', 'slackBotToken', 'asanaAccessToken'];
        const missing = [];

        for (const key of required) {
            if (!config[key]) {
                missing.push(key);
            }
        }

        if (missing.length > 0) {
            throw new Error(`Missing required configuration: ${missing.join(', ')}`);
        }
    }

    // Cleanup method to be called on shutdown
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            console.log('Cleanup interval cleared');
        }
    }

    async getStageIdByName(stageName) {
        if (!stageName) {
            console.error('getStageIdByName called with empty stageName');
            return null;
        }

        try {
            const url = this.config.followUpBoss.baseUrl + '/stages';
            
            const response = await axios.get(url, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                params: {
                    limit: 100
                },
                timeout: this.config.timeouts.api
            });
            
            const stages = response.data.stages;
            
            if (!Array.isArray(stages)) {
                console.error('Expected stages to be an array, got:', typeof stages);
                return null;
            }
            
            const stage = stages.find(s => s.name && s.name.toLowerCase() === stageName.toLowerCase());
            
            if (stage) {
                console.log('Found stage ID:', stage.id, 'for name:', stageName);
                return stage.id;
            } else {
                console.log('Stage not found:', stageName);
                return null;
            }
        } catch (error) {
            console.error('Error fetching stages:', {
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                stageName
            });
            return null;
        }
    }

    async handleWebhook(req, res) {
        try {
            const webhookData = req.body;
            console.log('=== WEBHOOK RECEIVED ===');
            console.log('Event:', webhookData.event);
            console.log('Resource IDs:', webhookData.resourceIds);
            
            if (webhookData.event === 'dealsUpdated' && webhookData.resourceIds && webhookData.resourceIds.length > 0) {
                const dealId = webhookData.resourceIds[0];
                console.log('Processing deal ID:', dealId);
                
                let dealData;
                try {
                    dealData = await this.fetchDealDetails(dealId);
                    console.log('Deal stage:', dealData.stageName);
                    console.log('Deal pipeline:', dealData.pipelineName);
                } catch (fetchError) {
                    console.error('Failed to fetch deal details:', {
                        dealId,
                        message: fetchError.message,
                        status: fetchError.response?.status
                    });
                    return res.status(500).json({ 
                        error: 'Failed to fetch deal details',
                        dealId,
                        message: fetchError.message
                    });
                }

                const firstPeopleID = this.extractFirstPeopleID(dealData);
                console.log('People ID:', firstPeopleID);
                
                if (this.shouldFilterOut(dealData.stageName)) {
                    console.log('Filtered out - stage contains 202 or is Agency Pending');
                    return res.status(200).json({ message: 'Filtered out' });
                }

                const pathDecision = this.determineProcessingPath(dealData, firstPeopleID);
                console.log('Path decision:', pathDecision);
                
                try {
                    if (pathDecision === 'PATH_A') {
                        await this.processPathA(dealData, firstPeopleID);
                    } else if (pathDecision === 'PATH_B') {
                        await this.processPathB(dealData, firstPeopleID);
                    }
                } catch (processingError) {
                    console.error('Error during path processing:', {
                        path: pathDecision,
                        dealId,
                        message: processingError.message,
                        stack: processingError.stack?.substring(0, 500)
                    });
                    return res.status(500).json({ 
                        error: 'Path processing failed',
                        path: pathDecision,
                        dealId,
                        message: processingError.message
                    });
                }

                res.status(200).json({ 
                    message: 'Processing completed',
                    path: pathDecision,
                    dealId: dealId
                });
            } else {
                res.json({ message: 'Webhook received but not processed' });
            }
        } catch (error) {
            console.error('Webhook error:', {
                message: error.message,
                stack: error.stack?.substring(0, 500),
                body: req.body
            });
            res.status(500).json({ 
                error: error.message,
                type: 'Unhandled webhook error'
            });
        }
    }

    async fetchDealDetails(dealId) {
        if (!dealId) {
            throw new Error('fetchDealDetails called with empty dealId');
        }

        const url = this.config.followUpBoss.baseUrl + '/deals/' + dealId;
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                timeout: this.config.timeouts.api
            });
            
            console.log('=== FULL DEAL DATA ===');
            console.log(JSON.stringify(response.data, null, 2));
            console.log('=== END DEAL DATA ===');
            
            const dealData = response.data;
            console.log('Deal stage field:', dealData.stage);
            console.log('Deal stageId field:', dealData.stageId);
            console.log('Deal status field:', dealData.status);
            
            return dealData;
        } catch (error) {
            console.error('Failed to fetch deal details:', {
                dealId,
                url,
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText
            });
            throw new Error(`Failed to fetch deal ${dealId}: ${error.message}`);
        }
    }

    extractFirstPeopleID(dealData) {
        if (dealData.people && Array.isArray(dealData.people) && dealData.people.length > 0) {
            return dealData.people[0].id || dealData.people[0];
        }
        if (dealData.contacts && Array.isArray(dealData.contacts) && dealData.contacts.length > 0) {
            return dealData.contacts[0].id || dealData.contacts[0];
        }
        return null;
    }

    shouldFilterOut(stage) {
        return (stage && stage.includes('202')) || (stage === 'Agency Pending');
    }

    determineProcessingPath(dealData, firstPeopleID) {
        const hasOutputItem = firstPeopleID !== null;
        
        if (hasOutputItem) {
            const pipeline = dealData.pipelineName || '';
            const excludedPipelines = ['Investments Acquisition', 'Agent Recruiting', 'Commercial'];
            
            const shouldExclude = excludedPipelines.some(excluded => pipeline.includes(excluded));
            
            if (!shouldExclude) {
                return 'PATH_A';
            }
        } else {
            return 'PATH_B';
        }
        
        return 'SKIP';
    }

    async processPathA(dealData, firstPeopleID) {
        console.log('Processing Path A - Update stage');
        
        this.currentDealData = dealData;
        
        if (!this.passesPathAFilters(dealData)) {
            console.log('Path A: Failed filters');
            return;
        }

        const transformedStage = this.transformStage(dealData.stageName, dealData.pipelineName);
console.log('Stage transformation:', dealData.stageName, 'in', dealData.pipelineName, 'pipeline ->', transformedStage);
        
        // If this is a special one-way mapping, add the loop prevention tag BEFORE updating the stage
        if (this.isSpecialOneWayMapping(dealData.stageName)) {
            console.log('Special one-way mapping detected - adding TriggeredDealContactStageUpdates tag');
            await this.addLoopPreventionTag(firstPeopleID);
            
            // Also add !AgentReview tag if this stage requires it
            if (this.needsAgentReviewTag(dealData.stageName)) {
                console.log('Agent review required for stage:', dealData.stageName, '- adding !AgentReview tag');
                await this.addAgentReviewTag(firstPeopleID);
            }
        }
        
        await this.updateFollowUpBossStage(firstPeopleID, transformedStage);
        console.log('Path A: Updated person', firstPeopleID, 'to stage:', transformedStage);
    }

    passesPathAFilters(dealData) {
        const stage = dealData.stageName || '';
        const pipeline = dealData.pipelineName || '';
        
        const condition1 = stage !== '2022 Closed' && pipeline !== 'Agent Recruiting';
        const condition2 = pipeline === 'Investments Acquisition' && stage === 'Start Transaction';
        const condition3 = pipeline === 'Investments Acquisition' && stage === 'Attorney Review';
        const condition4 = pipeline === 'Investments Acquisition' && stage === 'Under Contract';
        const condition5 = pipeline === 'Investments Acquisition' && stage === 'Fall Through';
        
        return condition1 || condition2 || condition3 || condition4 || condition5;
    }

    transformStage(originalStage, pipelineName) {
    // Pipeline-specific transformations (check these FIRST)
    if (originalStage === 'Attorney Review') {
        const pipeline = (pipelineName || '').toLowerCase();
        if (pipeline.includes('listing') || pipeline.includes('seller') || pipeline.includes('landlord')) {
            console.log('Attorney Review in Listing/Seller/Landlord pipeline -> Active Listing');
            return 'Active Listing';
        }
        // For other pipelines (Buyer, Tenant), use the default mapping
        console.log('Attorney Review in Buyer/Tenant pipeline -> Submitting offers');
        return 'Submitting offers';
    }
    
    // Check for special one-way mappings
    if (this.specialOneWayMappings[originalStage]) {
        return this.specialOneWayMappings[originalStage];
    }
    
    // Check if stage contains "Closed" (case-insensitive)
    if (originalStage && originalStage.toLowerCase().includes('closed')) {
        return 'Closed';
    }
    
    // Fall back to regular mappings
    return this.stageLookupTable[originalStage] || originalStage;
}

    isSpecialOneWayMapping(originalStage) {
        // Check explicit mappings first
        if (this.specialOneWayMappings.hasOwnProperty(originalStage)) {
            return true;
        }
        // Check if stage contains "Closed"
        if (originalStage && originalStage.toLowerCase().includes('closed')) {
            return true;
        }
        return false;
    }

    needsAgentReviewTag(originalStage) {
        return this.agentReviewStages.includes(originalStage);
    }

    needsAgentReviewTag(originalStage) {
        return this.agentReviewStages.includes(originalStage);
    }

    async updateFollowUpBossStage(peopleId, stageName) {
        if (!stageName || stageName === 'undefined') {
            console.log('Skipping update - invalid stage name:', stageName);
            const error = new Error('Invalid stage name provided');
            error.details = `Stage name was: ${stageName}`;
            await this.sendStageUpdateFailureNotification(peopleId, stageName, error);
            return;
        }

        try {
            const stageId = await this.getStageIdByName(stageName);
            
            if (!stageId) {
                console.log('Could not find stage ID for:', stageName);
                const error = new Error('Unable to find stage in FollowUpBoss');
                error.details = `Stage "${stageName}" not found in available stages`;
                await this.sendStageUpdateFailureNotification(peopleId, stageName, error);
                return;
            }

            const url = this.config.followUpBoss.baseUrl + '/people/' + peopleId;
            
            console.log('Updating person', peopleId, 'to stage ID:', stageId, 'name:', stageName);
            
            const response = await axios.put(url, {
                stage: stageId
            }, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json',
                    'X-System': 'ManifestNetwork',
                    'X-System-Key': '2041dc7b20d2909C097bccd3e65f44e'
                },
                timeout: 10000
            });
            
            console.log('Follow Up Boss stage update successful:', response.status);

            // Add pipeline tag to the contact
            await this.addPipelineTagToContact(peopleId);
            
            return response.data;
        } catch (error) {
            console.error('Failed to update Follow Up Boss stage:', error.message);
            
            let detailedError = error;
            if (error.response) {
                detailedError.details = `HTTP ${error.response.status}: ${error.response.statusText}. Response: ${JSON.stringify(error.response.data)}`;
            } else if (error.code === 'ENOTFOUND') {
                detailedError.details = 'Network error - unable to reach FollowUpBoss API';
            } else if (error.code === 'ECONNABORTED') {
                detailedError.details = 'Request timeout - FollowUpBoss API took too long to respond';
            } else {
                detailedError.details = `Network/API error: ${error.message}`;
            }
            
            await this.sendStageUpdateFailureNotification(peopleId, stageName, detailedError);
            
            return null;
        }
    }

    async processPathB(dealData, firstPeopleID) {
        console.log('Processing Path B - Notifications');
        
        const now = new Date();
        const currentMinute = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate() + '-' + now.getHours() + '-' + now.getMinutes();
        const dealKey = `${dealData.id}-${currentMinute}`;
        
        if (this.processedDeals.has(dealKey)) {
            console.log('Duplicate detected for deal', dealData.id, 'in current minute - skipping');
            return;
        }
        
        this.processedDeals.add(dealKey);
        
        if (this.processedDeals.size > 100) {
            const entries = Array.from(this.processedDeals);
            entries.slice(0, 50).forEach(entry => this.processedDeals.delete(entry));
        }
        
        const userId = this.extractFirstUserID(dealData);
        const agentInfo = await this.getAssignedAgentInfo(userId);
        const slackUser = await this.findSlackAgent(agentInfo.email);
        
        await this.sendSlackReminder(slackUser, dealData, agentInfo);
        
        // Only create Asana task if enabled
        if (this.config.enableAsanaNoContactTasks) {
            console.log('Asana task creation is ENABLED - creating task');
            await this.createAsanaTask(dealData, agentInfo);
        } else {
            console.log('Asana task creation is DISABLED - skipping task creation');
        }
        
        console.log('Path B: Sent notifications for deal', dealData.id);
    }

    extractFirstUserID(dealData) {
        if (dealData.assignedTo && Array.isArray(dealData.assignedTo) && dealData.assignedTo.length > 0) {
            return dealData.assignedTo[0].id || dealData.assignedTo[0];
        }
        if (dealData.users && Array.isArray(dealData.users) && dealData.users.length > 0) {
            return dealData.users[0].id || dealData.users[0];
        }
        return 77;
    }

    async getAssignedAgentInfo(userId) {
        const url = this.config.followUpBoss.baseUrl + '/users/' + userId;
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            
            return response.data;
        } catch (error) {
            return { name: 'Unknown Agent', email: 'unknown@example.com', firstName: 'Agent' };
        }
    }

    async findSlackAgent(email) {
        try {
            const response = await axios.get('https://slack.com/api/users.lookupByEmail', {
                headers: {
                    'Authorization': 'Bearer ' + this.config.slack.botToken
                },
                params: { email: email },
                timeout: 10000
            });
            
            if (response.data.ok) {
                return response.data.user;
            }
        } catch (error) {
            console.log('Slack lookup failed:', error.message);
        }
        
        return { id: 'U06MCEMTO6G' };
    }

    async sendSlackReminder(slackUser, dealData, agentInfo) {
        const message = this.buildSlackMessage(dealData, agentInfo);
        
        const response = await axios.post('https://slack.com/api/chat.postMessage', {
            channel: slackUser.id,
            text: message
        }, {
            headers: {
                'Authorization': 'Bearer ' + this.config.slack.botToken,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        if (!response.data.ok) {
            throw new Error('Slack API error: ' + response.data.error);
        }

        console.log('Slack DM sent successfully');
    }

    buildSlackMessage(dealData, agentInfo) {
        const agentName = agentInfo.firstName || 'Agent';
        const dealName = dealData.name || 'deal';
        
        return 'Hi ' + agentName + ',\n\nThanks so much for updating the deal card! We noticed that you haven\'t yet linked a contact to the ' + dealName + ' deal card. Please do so ASAP, as that is a mandatory step in maintaining our metrics, and ensures we can provide the best possible service to you and your clients as the deal progresses. In the future, if you create your deals and appointments from the contact\'s page in FUB, they\'ll get linked automatically!';
    }

    async createAsanaTask(dealData, agentInfo) {
        const taskName = 'No Contact Attached - ' + (dealData.name || 'Deal');
        const taskBody = 'Deal Title: ' + (dealData.name || 'Unknown') + '\nAssigned Agent: ' + (agentInfo.name || 'Unknown') + '\nPipeline: ' + (dealData.pipelineName || 'Unknown') + '\nCurrent Stage: ' + (dealData.stageName || 'Unknown') + '\n\nMake sure this is updated and fixed within 24 hours.';

        const assigneeGid = '1209646560314034';
        
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowFormatted = tomorrow.toISOString().split('T')[0];

        const payload = {
            data: {
                name: taskName,
                notes: taskBody,
                projects: ['1209646560314018'],
                assignee: assigneeGid,
                due_on: tomorrowFormatted
            }
        };
        
        try {
            const response = await axios.post('https://app.asana.com/api/1.0/tasks', payload, {
                headers: {
                    'Authorization': 'Bearer ' + this.config.asana.accessToken,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            console.log('Asana task created:', response.data.data.gid);
        } catch (error) {
            console.error('Asana API Error:', error.response?.status, error.response?.data);
            throw error;
        }
    }

    async addPipelineTagToContact(peopleId) {
        try {
            // Get the pipeline name from current deal data
            const pipelineName = this.currentDealData?.pipelineName;
            
            if (!pipelineName) {
                console.log('No pipeline name available for tagging');
                return;
            }

            // Map "Investments Acquisition" to "Investor", otherwise use pipeline name
            const tagName = pipelineName === 'Investments Acquisition' ? 'Investor' : pipelineName;

            console.log('Adding pipeline tag:', tagName, 'to contact:', peopleId, '(from pipeline:', pipelineName + ')');

            // First, get or create the tag
            const tagId = await this.getOrCreateTag(tagName);
            
            if (!tagId) {
                console.log('Could not get or create tag for pipeline:', tagName);
                return;
            }

            // Add the tag to the contact
            const url = this.config.followUpBoss.baseUrl + '/people/' + peopleId + '/tags';
            
            const response = await axios.post(url, {
                tag: tagId
            }, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            console.log('Pipeline tag added successfully:', response.status);
        } catch (error) {
            console.error('Failed to add pipeline tag:', error.message);
            // Don't throw error to avoid breaking the main workflow
        }
    }

    async getOrCreateTag(tagName) {
        try {
            // First, try to find existing tag
            const searchUrl = this.config.followUpBoss.baseUrl + '/tags';
            
            const searchResponse = await axios.get(searchUrl, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                params: {
                    limit: 100
                },
                timeout: 10000
            });

            // Look for existing tag (case-insensitive)
            const existingTag = searchResponse.data.find(tag => 
                tag.name.toLowerCase() === tagName.toLowerCase()
            );

            if (existingTag) {
                console.log('Found existing tag:', existingTag.id, 'for name:', tagName);
                return existingTag.id;
            }

            // Create new tag if it doesn't exist
            console.log('Creating new tag:', tagName);
            const createUrl = this.config.followUpBoss.baseUrl + '/tags';
            
            const createResponse = await axios.post(createUrl, {
                name: tagName
            }, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            console.log('Created new tag:', createResponse.data.id, 'for name:', tagName);
            return createResponse.data.id;

        } catch (error) {
            console.error('Error getting or creating tag:', error.message);
            return null;
        }
    }

    async addLoopPreventionTag(peopleId) {
    try {
        const tagName = 'TriggeredDealContactStageUpdates';
        console.log('Adding loop prevention tag:', tagName, 'to contact:', peopleId);

        // Add tag directly by name using PUT with mergeTags=true
        const url = this.config.followUpBoss.baseUrl + '/people/' + peopleId + '?mergeTags=true';
        
        const response = await axios.put(url, {
            tags: [tagName]  // ← Using tag name directly
        }, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                'Content-Type': 'application/json'
            },
            timeout: this.config.timeouts.api
        });

        console.log('Loop prevention tag added successfully:', response.status);
    } catch (error) {
        console.error('Failed to add loop prevention tag:', error.message);
        // Don't throw error to avoid breaking the main workflow
    }
}

    async addAgentReviewTag(peopleId) {
    try {
        const tagName = '!AgentReview';
        console.log('Adding agent review tag:', tagName, 'to contact:', peopleId);

        // Add tag directly by name using PUT with mergeTags=true
        const url = this.config.followUpBoss.baseUrl + '/people/' + peopleId + '?mergeTags=true';
        
        const response = await axios.put(url, {
            tags: [tagName]
        }, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                'Content-Type': 'application/json'
            },
            timeout: this.config.timeouts.api
        });

        console.log('Agent review tag added successfully:', response.status);
    } catch (error) {
        console.error('Failed to add agent review tag:', error.message);
    }
}

    async sendStageUpdateFailureNotification(peopleId, stageName, error) {
        try {
            const errorDetails = error?.details || error?.response?.data?.errorMessage || 'No additional details available';
            
            // Skip notification for Zillow-related stage errors that we don't care about
            if (errorDetails && (
                errorDetails.includes('Provided stage is not a valid Zillow Sync Stage') ||
                errorDetails.includes('Zillow Flex') ||
                errorDetails.includes('Zillow')
            )) {
                console.log('Skipping Zillow-related stage error notification - this is expected');
                return;
            }
            
            const channelId = 'C093UR5GGF2';
            
            const dealName = this.currentDealData?.name || 'Unknown Deal';
            const pipelineName = this.currentDealData?.pipelineName || 'Unknown Pipeline';
            
            const failureMessage = `AIDA failed to update the deal stage for the following...
Deal Name: ${dealName}
Pipeline: ${pipelineName}
New Stage: ${stageName}
FUB Contact Link: https://align.followupboss.com/2/people/view/${peopleId}

Error: ${error.message || 'Unknown error'}
Details: ${errorDetails}`;

            await axios.post('https://slack.com/api/chat.postMessage', {
                channel: channelId,
                text: failureMessage
            }, {
                headers: {
                    'Authorization': 'Bearer ' + this.config.slack.botToken,
                    'Content-Type': 'application/json'
                },
                timeout: this.config.timeouts.slack
            });

            console.log('Stage update failure notification sent to channel C093UR5GGF2');
        } catch (notificationError) {
            console.error('Failed to send stage update failure notification:', {
                message: notificationError.message,
                peopleId,
                stageName,
                originalError: error.message
            });
        }
    }
}

module.exports = { FollowUpBossAutomation };

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
            'A (< 30) + Agency': 'A (< 30)',
            'Offers Submitted': 'Submitting offers',
            'Submitting Applications': 'Application Submitted',
            'Active Off-Market': 'Active Off Market Listing',
            'Send Referral Agreement': 'Referral Out Open',
            'Referral Under Contract': 'Referral Out Under Contract',
            'Referral Closed': 'Referral Out Closed'
        };
    }

    async getStageIdByName(stageName) {
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
                timeout: 10000
            });
            
            console.log('Full stages API response:', JSON.stringify(response.data, null, 2));
            
            // The API returns stages nested in a 'stages' property
            const stages = response.data.stages;
            
            if (!Array.isArray(stages)) {
                console.error('Expected stages to be an array, got:', typeof stages);
                console.error('Response keys:', Object.keys(response.data));
                return null;
            }
            
            console.log('Extracted stages array length:', stages.length);
            console.log('Available stage names:', stages.map(s => s.name || s.title || 'unnamed'));
            
            // Find stage by name (case-insensitive)
            const stage = stages.find(s => s.name.toLowerCase() === stageName.toLowerCase());
            
            if (stage) {
                console.log('Found stage ID:', stage.id, 'for name:', stageName);
                return stage.id;
            } else {
                console.log('Stage not found:', stageName);
                console.log('Available stages:', stages.map(s => `"${s.name}"`).join(', '));
                return null;
            }
        } catch (error) {
            console.error('Error fetching stages:', error.message);
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
                
                const dealData = await this.fetchDealDetails(dealId);
                console.log('Deal stage:', dealData.stageName);
                console.log('Deal pipeline:', dealData.pipelineName);

                const firstPeopleID = this.extractFirstPeopleID(dealData);
                console.log('People ID:', firstPeopleID);
                
                if (this.shouldFilterOut(dealData.stageName)) {
                    console.log('Filtered out - stage contains 202');
                    return res.status(200).json({ message: 'Filtered out' });
                }

                const pathDecision = this.determineProcessingPath(dealData, firstPeopleID);
                console.log('Path decision:', pathDecision);
                
                if (pathDecision === 'PATH_A') {
                    await this.processPathA(dealData, firstPeopleID);
                } else if (pathDecision === 'PATH_B') {
                    await this.processPathB(dealData, firstPeopleID);
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
            console.error('Webhook error:', error);
            res.status(500).json({ error: error.message });
        }
    }

    async fetchDealDetails(dealId) {
        const url = this.config.followUpBoss.baseUrl + '/deals/' + dealId;
        
        const response = await axios.get(url, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(this.config.followUpBoss.apiKey + ':').toString('base64'),
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        
        console.log('=== FULL DEAL DATA ===');
        console.log(JSON.stringify(response.data, null, 2));
        console.log('=== END DEAL DATA ===');
        
        // The stage might be in a different field, let's check
        const dealData = response.data;
        console.log('Deal stage field:', dealData.stage);
        console.log('Deal stageId field:', dealData.stageId);
        console.log('Deal status field:', dealData.status);
        
        return dealData;
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
        return stage && stage.includes('202');
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
        
        if (!this.passesPathAFilters(dealData)) {
            console.log('Path A: Failed filters');
            return;
        }

        const transformedStage = this.transformStage(dealData.stageName);
        console.log('Stage transformation:', dealData.stageName, '->', transformedStage);
        
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

    transformStage(originalStage) {
        return this.stageLookupTable[originalStage] || originalStage;
    }

    async updateFollowUpBossStage(peopleId, stageName) {
        if (!stageName || stageName === 'undefined') {
            console.log('Skipping update - invalid stage name:', stageName);
            return;
        }

        // Get the stage ID from the stage name
        const stageId = await this.getStageIdByName(stageName);
        
        if (!stageId) {
            console.log('Could not find stage ID for:', stageName);
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
        
        console.log('Follow Up Boss update successful:', response.status);
        return response.data;
    }

    async processPathB(dealData, firstPeopleID) {
        console.log('Processing Path B - Notifications');
        
        const userId = this.extractFirstUserID(dealData);
        const agentInfo = await this.getAssignedAgentInfo(userId);
        const slackUser = await this.findSlackAgent(agentInfo.email);
        
        await this.sendSlackReminder(slackUser, dealData, agentInfo);
        await this.createAsanaTask(dealData, agentInfo);
        
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
        
        console.log('=== SLACK DEBUG INFO ===');
        console.log('Slack User ID:', slackUser.id);
        console.log('Message:', message);
        console.log('=== END SLACK DEBUG ===');
        
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
        
        return 'Hi <@' + agentName + '>,\n\nThanks so much for updating the deal card! We noticed that you haven\'t yet linked a contact to the ' + dealName + ' deal card. Please do so ASAP, as that is a mandatory step in maintaining our metrics, and ensures we can provide the best possible service to you and your clients as the deal progresses. In the future, if you create your deals and appointments from the contact\'s page in FUB, they\'ll get linked automatically!';
    }

    async createAsanaTask(dealData, agentInfo) {
        const taskName = 'No Contact Attached - ' + (dealData.name || 'Deal');
        const taskBody = 'Deal Title: ' + (dealData.name || 'Unknown') + '\nAssigned Agent: ' + (agentInfo.name || 'Unknown') + '\nPipeline: ' + (dealData.pipelineName || 'Unknown') + '\nStage: ' + (dealData.stageName || 'Unknown') + '\n\nMake sure this is updated and fixed within 24 hours.';

        // Fixed assignee GID - no longer looking up by email
        const assigneeGid = '1209646560314034';
        
        console.log('=== ASANA DEBUG INFO ===');
        console.log('Task Name:', taskName);
        console.log('Task Body:', taskBody);
        console.log('Assignee GID:', assigneeGid);
        console.log('Project ID:', '1209646560314018');
        console.log('=== END ASANA DEBUG ===');
        
        // Calculate tomorrow's date in YYYY-MM-DD format
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowFormatted = tomorrow.toISOString().split('T')[0];

        const payload = {
            data: {
                name: taskName,
                notes: taskBody,
                projects: ['1209646560314018'],  // Updated with correct project ID
                assignee: assigneeGid,
                due_on: tomorrowFormatted  // Set due date to tomorrow
            }
        };
        
        console.log('Asana API payload:', JSON.stringify(payload, null, 2));
        
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
            console.error('Asana API Error Details:');
            console.error('Status:', error.response?.status);
            console.error('Status Text:', error.response?.statusText);
            console.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
            console.error('Headers:', JSON.stringify(error.response?.headers, null, 2));
            throw error;
        }
    }

    async getAsanaUserByEmail(email) {
        try {
            const response = await axios.get('https://app.asana.com/api/1.0/users', {
                headers: {
                    'Authorization': 'Bearer ' + this.config.asana.accessToken
                },
                params: { opt_fields: 'gid,email' },
                timeout: 10000
            });

            const user = response.data.data.find(u => u.email === email);
            return user ? user.gid : null;
        } catch (error) {
            console.error('Error finding Asana user:', error.message);
            return null;
        }
    }
}

module.exports = { FollowUpBossAutomation };
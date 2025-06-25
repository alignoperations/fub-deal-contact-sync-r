cat > src/automation.js << 'EOF'
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

        this.validateConfig();
    }

    validateConfig() {
        const required = [
            'followUpBoss.apiKey',
            'slack.botToken',
            'asana.accessToken'
        ];

        for (const path of required) {
            const value = path.split('.').reduce((obj, key) => obj?.[key], this.config);
            if (!value) {
                throw new Error(`Missing required configuration: ${path}`);
            }
        }
    }

    async handleWebhook(req, res) {
        try {
            const dealData = req.body;
            console.log('📥 Received deal stage update:', JSON.stringify(dealData, null, 2));

            const firstPeopleID = this.extractFirstPeopleID(dealData);
            console.log('👤 Extracted peopleID:', firstPeopleID);
            
            if (this.shouldFilterOut(dealData.stage)) {
                console.log('🚫 Filtered out - stage contains "202"');
                return res.status(200).json({ message: 'Filtered out - stage contains 202' });
            }

            const pathDecision = this.determineProcessingPath(dealData, firstPeopleID);
            console.log('🔀 Path decision:', pathDecision);
            
            if (pathDecision === 'PATH_A') {
                await this.processPathA(dealData, firstPeopleID);
            } else if (pathDecision === 'PATH_B') {
                await this.processPathB(dealData, firstPeopleID);
            } else {
                console.log('⏭️ Skipping - no path conditions met');
                return res.status(200).json({ message: 'No processing needed' });
            }

            res.status(200).json({ 
                message: 'Processing completed successfully',
                path: pathDecision,
                dealId: dealData.id
            });
        } catch (error) {
            console.error('❌ Webhook processing error:', error);
            res.status(500).json({ 
                error: 'Processing failed',
                message: error.message
            });
        }
    }

    extractFirstPeopleID(dealData) {
        if (dealData.people && Array.isArray(dealData.people) && dealData.people.length > 0) {
            return dealData.people[0].id || dealData.people[0];
        }
        if (dealData.contacts && Array.isArray(dealData.contacts) && dealData.contacts.length > 0) {
            return dealData.contacts[0].id || dealData.contacts[0];
        }
        if (dealData.lineItems && Array.isArray(dealData.lineItems) && dealData.lineItems.length > 0) {
            return dealData.lineItems[0].peopleId || dealData.lineItems[0].id;
        }
        return null;
    }

    shouldFilterOut(stage) {
        return stage && stage.includes('202');
    }

    determineProcessingPath(dealData, firstPeopleID) {
        const hasOutputItem = firstPeopleID !== null;
        
        if (hasOutputItem) {
            const pipeline = dealData.pipeline || '';
            const excludedPipelines = [
                'Investments Acquisition',
                'Agent Recruiting', 
                'Commercial'
            ];
            
            const shouldExclude = excludedPipelines.some(excluded => 
                pipeline.includes(excluded)
            );
            
            if (!shouldExclude) {
                return 'PATH_A';
            }
        } else {
            return 'PATH_B';
        }
        
        return 'SKIP';
    }

    async processPathA(dealData, firstPeopleID) {
        try {
            console.log('🔄 Processing Path A - Update Deal Stage');
            
            if (!this.passesPathAFilters(dealData)) {
                console.log('🚫 Path A: Failed additional filters');
                return;
            }

            const transformedStage = this.transformStage(dealData.stage);
            console.log(`🔄 Transforming stage: "${dealData.stage}" → "${transformedStage}"`);
            
            await this.updateFollowUpBossStage(firstPeopleID, transformedStage);
            
            console.log(`✅ Path A: Updated person ${firstPeopleID} to stage: ${transformedStage}`);
        } catch (error) {
            console.error('❌ Path A processing error:', error);
            throw error;
        }
    }

    passesPathAFilters(dealData) {
        const stage = dealData.stage || '';
        const pipeline = dealData.pipeline || '';
        
        const condition1 = stage !== '2022 Closed' && pipeline !== 'Agent Recruiting';
        const condition2 = pipeline === 'Investments Acquisition' && stage === 'Start Transaction';
        const condition3 = pipeline === 'Investments Acquisition' && stage === 'Attorney Review';
        const condition4 = pipeline === 'Investments Acquisition' && stage === 'Under Contract';
        const condition5 = pipeline === 'Investments Acquisition' && stage === 'Fall Through';
        
        const passes = condition1 || condition2 || condition3 || condition4 || condition5;
        console.log('🔍 Path A filter check:', { stage, pipeline, passes });
        return passes;
    }

    transformStage(originalStage) {
        return this.stageLookupTable[originalStage] || originalStage;
    }

    async updateFollowUpBossStage(peopleId, newStage) {
        const url = `${this.config.followUpBoss.baseUrl}/people/${peopleId}`;
        
        try {
            const response = await axios.put(url, {
                stage: newStage
            }, {
                headers: {
                    'Authorization': `Bearer ${this.config.followUpBoss.apiKey}`,
                    'Content-Type': 'application/json',
                    'X-System': 'ManifestNetwork',
                    'X-System-Key': '2041dc7b20d2909C097bccd3e65f44e'
                },
                timeout: 10000
            });
            
            console.log('✅ Follow Up Boss update successful:', response.status);
            return response.data;
        } catch (error) {
            console.error('❌ Follow Up Boss API error:', error.response?.data || error.message);
            throw error;
        }
    }

    async processPathB(dealData, firstPeopleID) {
        try {
            console.log('📢 Processing Path B - Slack Notifications');
            
            const userId = this.extractFirstUserID(dealData);
            console.log('👤 Extracted userID:', userId);
            
            const agentInfo = await this.getAssignedAgentInfo(userId);
            console.log('👤 Agent info:', agentInfo.name || agentInfo.email);
            
            const slackUser = await this.findSlackAgent(agentInfo.email);
            console.log('💬 Slack user found:', slackUser.id);
            
            await this.sendSlackReminder(slackUser, dealData, agentInfo);
            
            await this.createAsanaTask(dealData, agentInfo);
            
            console.log(`✅ Path B: Sent Slack notification and created Asana task for unlinked contact - Deal ${dealData.id}`);
        } catch (error) {
            console.error('❌ Path B processing error:', error);
            throw error;
        }
    }

    extractFirstUserID(dealData) {
        if (dealData.assignedTo && Array.isArray(dealData.assignedTo) && dealData.assignedTo.length > 0) {
            return dealData.assignedTo[0].id || dealData.assignedTo[0];
        }
        if (dealData.users && Array.isArray(dealData.users) && dealData.users.length > 0) {
            return dealData.users[0].id || dealData.users[0];
        }
        if (dealData.lineItems && Array.isArray(dealData.lineItems) && dealData.lineItems.length > 0) {
            return dealData.lineItems[0].userId || dealData.lineItems[0].assignedTo;
        }
        return 77;
    }

    async getAssignedAgentInfo(userId) {
        const url = `${this.config.followUpBoss.baseUrl}/users/${userId}`;
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.config.followUpBoss.apiKey}`,
                    'Content-Type': 'application/json',
                    'X-System': 'ManifestNetwork'
                },
                timeout: 10000
            });
            
            return response.data;
        } catch (error) {
            console.error('❌ Follow Up Boss user API error:', error.response?.data || error.message);
            return { name: 'Unknown Agent', email: 'unknown@example.com', firstName: 'Agent' };
        }
    }

    async findSlackAgent(email) {
        try {
            const response = await axios.get('https://slack.com/api/users.lookupByEmail', {
                headers: {
                    'Authorization': `Bearer ${this.config.slack.botToken}`
                },
                params: {
                    email: email
                },
                timeout: 10000
            });
            
            if (response.data.ok) {
                return response.data.user;
            } else {
                console.log('⚠️ Slack user not found, using default');
                return { id: 'U06MCEMTO6G' };
            }
        } catch (error) {
            console.error('❌ Slack API error:', error.message);
            return { id: 'U06MCEMTO6G' };
        }
    }

    async sendSlackReminder(slackUser, dealData, agentInfo) {
        const message = this.buildSlackMessage(dealData, agentInfo);
        
        try {
            await this.sendSlackDM(slackUser.id, message);
            console.log('✅ Slack DM sent successfully');
        } catch (error) {
            console.error('❌ Slack DM error:', error.message);
            throw error;
        }
    }

    async sendSlackDM(userId, message) {
        const response = await axios.post('https://slack.com/api/chat.postMessage', {
            channel: userId,
            text: message,
            as_user: false
        }, {
            headers: {
                'Authorization': `Bearer ${this.config.slack.botToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        if (!response.data.ok) {
            throw new Error(`Slack API error: ${response.data.error}`);
        }

        return response.data;
    }

    buildSlackMessage(dealData, agentInfo) {
        return `Hi <@${agentInfo.firstName || 'Agent'}>,

Thanks so much for updating the deal card! We noticed that you haven't yet linked a contact to the ${dealData.name || 'deal'} deal card. Please do so ASAP, as that is a mandatory step in maintaining our metrics, and ensures we can provide the best possible service to you and your clients as the deal progresses. In the future, if you create your deals and appointments from the contact's page in FUB, they'll get linked automatically!`;
    }

    async createAsanaTask(dealData, agentInfo) {
        const taskName = `🔴 No Contact Attached - ${dealData.name || 'Deal'}`;
        const taskBody = `Deal Title: ${dealData.name || 'Unknown'}
Assigned Agent: ${agentInfo.name || 'Unknown'}
Pipeline: ${dealData.pipeline || 'Unknown'}
Stage: ${dealData.stage || 'Unknown'}

Make sure this is updated and fixed within 24 hours.`;

        try {
            const assigneeGid = await this.getAsanaUserByEmail('cadesanya@alignteam.com');
            
            const asanaPayload = {
                data: {
                    name: taskName,
                    notes: taskBody,
                    projects: ['1209656267348045'],
                    assignee: assigneeGid
                }
            };

            const response = await axios.post('https://app.asana.com/api/1.0/tasks', asanaPayload, {
                headers: {
                    'Authorization': `Bearer ${this.config.asana.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            console.log('✅ Asana task created:', response.data.data.gid);
            return response.data;
        } catch (error) {
            console.error('❌ Asana API error:', error.response?.data || error.message);
            throw error;
        }
    }

    async getAsanaUserByEmail(email) {
        try {
            const response = await axios.get('https://app.asana.com/api/1.0/users', {
                headers: {
                    'Authorization': `Bearer ${this.config.asana.accessToken}`
                },
                params: {
                    opt_fields: 'gid,email'
                },
                timeout: 10000
            });

            const user = response.data.data.find(u => u.email === email);
            console.log('👤 Asana user found:', user?.gid || 'not found');
            return user ? user.gid : null;
        } catch (error) {
            console.error('❌ Error finding Asana user:', error.message);
            return null;
        }
    }
}

module.exports = { FollowUpBossAutomation };
EOF
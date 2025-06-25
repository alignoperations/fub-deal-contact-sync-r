// Stage lookup table from Zapier configuration
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

// Main webhook handler
async handleWebhook(req, res) {
    try {
        const webhookData = req.body;
        console.log('=== WEBHOOK RECEIVED ===');
        console.log('Event:', webhookData.event);
        console.log('Resource IDs:', webhookData.resourceIds);
        console.log('URI:', webhookData.uri);
        
        // Extract deal ID and fetch deal details
        if (webhookData.event === 'dealsUpdated' && webhookData.resourceIds && webhookData.resourceIds.length > 0) {
            const dealId = webhookData.resourceIds[0];
            console.log('Fetching deal details for ID:', dealId);
            
            // Fetch deal details from Follow Up Boss API
            const dealData = await this.fetchDealDetails(dealId);
            console.log('Deal data received:', JSON.stringify(dealData, null, 2));

            // Step 1: Extract first peopleID from line items
            const firstPeopleID = this.extractFirstPeopleID(dealData);
            console.log('Extracted peopleID:', firstPeopleID);
            
            // Step 2: Filter - skip if stage contains "202"
            if (this.shouldFilterOut(dealData.stage)) {
                console.log('Filtered out - stage contains "202"');
                return res.status(200).json({ message: 'Filtered out - stage contains 202' });
            }

            // Step 3: Split into paths based on conditions
            const pathDecision = this.determineProcessingPath(dealData, firstPeopleID);
            console.log('Path decision:', pathDecision);
            
            if (pathDecision === 'PATH_A') {
                await this.processPathA(dealData, firstPeopleID);
            } else if (pathDecision === 'PATH_B') {
                await this.processPathB(dealData, firstPeopleID);
            } else {
                console.log('Skipping - no path conditions met');
                return res.status(200).json({ message: 'No processing needed' });
            }

            res.status(200).json({ 
                message: 'Processing completed successfully',
                path: pathDecision,
                dealId: dealData.id
            });
        } else {
            console.log('Webhook not for deals or no resource IDs');
            res.json({ message: 'Webhook received but not processed' });
        }
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ 
            error: 'Processing failed',
            message: error.message
        });
    }
}

// Fetch deal details from Follow Up Boss API
async fetchDealDetails(dealId) {
    const url = this.config.followUpBoss.baseUrl + '/deals/' + dealId;
    
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': 'Bearer ' + this.config.followUpBoss.apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        
        return response.data;
    } catch (error) {
        console.error('Error fetching deal details:', error.message);
        throw error;
    }
}

// Step 1: Extract First PeopleID from Line Items
extractFirstPeopleID(dealData) {
    // Extract first peopleID from the deal's line items/contacts
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

// Step 2: Filter Logic
shouldFilterOut(stage) {
    return stage && stage.includes('202');
}

// Step 3: Path Decision Logic
determineProcessingPath(dealData, firstPeopleID) {
    // Path A conditions: Output Item 1 exists AND Pipeline filtering
    const hasOutputItem = firstPeopleID !== null;
    
    if (hasOutputItem) {
        const pipeline = dealData.pipeline || '';
        const excludedPipelines = [
            'Investments Acquisition',
            'Agent Recruiting', 
            'Commercial'
        ];
        
        // Check if pipeline should be excluded
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

// Path A: Update Deal Stage in Follow Up Boss
async processPathA(dealData, firstPeopleID) {
    try {
        console.log('Processing Path A - Update Deal Stage');
        
        // Step 4&5: Combined path conditions and filtering for Path A
        if (!this.passesPathAFilters(dealData)) {
            console.log('Path A: Failed additional filters');
            return;
        }

        // Step 6: Format stage using lookup table
        const transformedStage = this.transformStage(dealData.stage);
        console.log('Transforming stage: "' + dealData.stage + '" to "' + transformedStage + '"');
        
        // Step 7: PUT request to Follow Up Boss
        await this.updateFollowUpBossStage(firstPeopleID, transformedStage);
        
        console.log('Path A: Updated person ' + firstPeopleID + ' to stage: ' + transformedStage);
    } catch (error) {
        console.error('Path A processing error:', error);
        throw error;
    }
}

// Step 4&5: Combined Path A Filtering Logic
passesPathAFilters(dealData) {
    const stage = dealData.stage || '';
    const pipeline = dealData.pipeline || '';
    
    // Complex filter conditions from Zapier
    const condition1 = stage !== '2022 Closed' && pipeline !== 'Agent Recruiting';
    const condition2 = pipeline === 'Investments Acquisition' && stage === 'Start Transaction';
    const condition3 = pipeline === 'Investments Acquisition' && stage === 'Attorney Review';
    const condition4 = pipeline === 'Investments Acquisition' && stage === 'Under Contract';
    const condition5 = pipeline === 'Investments Acquisition' && stage === 'Fall Through';
    
    const passes = condition1 || condition2 || condition3 || condition4 || condition5;
    console.log('Path A filter check:', { stage, pipeline, passes });
    return passes;
}

// Step 6: Stage Transformation
transformStage(originalStage) {
    return this.stageLookupTable[originalStage] || originalStage;
}

// Step 7: Follow Up Boss API Update
async updateFollowUpBossStage(peopleId, newStage) {
    const url = this.config.followUpBoss.baseUrl + '/people/' + peopleId;
    
    try {
        const response = await axios.put(url, {
            stage: newStage
        }, {
            headers: {
                'Authorization': 'Bearer ' + this.config.followUpBoss.apiKey,
                'Content-Type': 'application/json',
                'X-System': 'ManifestNetwork',
                'X-System-Key': '2041dc7b20d2909C097bccd3e65f44e'
            },
            timeout: 10000
        });
        
        console.log('Follow Up Boss update successful:', response.status);
        return response.data;
    } catch (error) {
        console.error('Follow Up Boss API error:', error.response?.data || error.message);
        throw error;
    }
}

// Path B: Slack Notifications for Unlinked Contacts
async processPathB(dealData, firstPeopleID) {
    try {
        console.log('Processing Path B - Slack Notifications');
        
        // Step 9: Extract first userID from line items
        const userId = this.extractFirstUserID(dealData);
        console.log('Extracted userID:', userId);
        
        // Step 10: Get assigned agent info
        const agentInfo = await this.getAssignedAgentInfo(userId);
        console.log('Agent info:', agentInfo.name || agentInfo.email);
        
        // Step 11: Find agent in Slack
        const slackUser = await this.findSlackAgent(agentInfo.email);
        console.log('Slack user found:', slackUser.id);
        
        // Step 12: Send Slack reminder
        await this.sendSlackReminder(slackUser, dealData, agentInfo);
        
        // Step 13: Create Asana task
        await this.createAsanaTask(dealData, agentInfo);
        
        console.log('Path B: Sent Slack notification and created Asana task for unlinked contact - Deal ' + dealData.id);
    } catch (error) {
        console.error('Path B processing error:', error);
        throw error;
    }
}

// Step 9: Extract First UserID from Line Items
extractFirstUserID(dealData) {
    // Extract first userID from the deal's line items/assigned users
    if (dealData.assignedTo && Array.isArray(dealData.assignedTo) && dealData.assignedTo.length > 0) {
        return dealData.assignedTo[0].id || dealData.assignedTo[0];
    }
    if (dealData.users && Array.isArray(dealData.users) && dealData.users.length > 0) {
        return dealData.users[0].id || dealData.users[0];
    }
    if (dealData.lineItems && Array.isArray(dealData.lineItems) && dealData.lineItems.length > 0) {
        return dealData.lineItems[0].userId || dealData.lineItems[0].assignedTo;
    }
    return 77; // Default fallback from Zapier config
}

// Step 10: Get Assigned Agent Info
async getAssignedAgentInfo(userId) {
    const url = this.config.followUpBoss.baseUrl + '/users/' + userId;
    
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': 'Bearer ' + this.config.followUpBoss.apiKey,
                'Content-Type': 'application/json',
                'X-System': 'ManifestNetwork'
            },
            timeout: 10000
        });
        
        return response.data;
    } catch (error) {
        console.error('Follow Up Boss user API error:', error.response?.data || error.message);
        // Return fallback agent info
        return { name: 'Unknown Agent', email: 'unknown@example.com', firstName: 'Agent' };
    }
}

// Step 11: Find Slack Agent
async findSlackAgent(email) {
    try {
        const response = await axios.get('https://slack.com/api/users.lookupByEmail', {
            headers: {
                'Authorization': 'Bearer ' + this.config.slack.botToken
            },
            params: {
                email: email
            },
            timeout: 10000
        });
        
        if (response.data.ok) {
            return response.data.user;
        } else {
            console.log('Slack user not found, using default');
            // Return default user if no search results (as configured in Zapier)
            return { id: 'U06MCEMTO6G' }; // Default from Zapier config
        }
    } catch (error) {
        console.error('Slack API error:', error.message);
        return { id: 'U06MCEMTO6G' }; // Default fallback
    }
}

// Step 12: Send Slack Reminder (DM Only)
async sendSlackReminder(slackUser, dealData, agentInfo) {
    const message = this.buildSlackMessage(dealData, agentInfo);
    
    try {
        // Send DM using Slack Web API
        await this.sendSlackDM(slackUser.id, message);
        console.log('Slack DM sent successfully');
    } catch (error) {
        console.error('Slack DM error:', error.message);
        throw error; // No fallback, just fail
    }
}

// Send DM using Slack Web API
async sendSlackDM(userId, message) {
    const response = await axios.post('https://slack.com/api/chat.postMessage', {
        channel: userId, // User ID for DM
        text: message,
        as_user: false
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

    return response.data;
}

buildSlackMessage(dealData, agentInfo) {
    const agentName = agentInfo.firstName || 'Agent';
    const dealName = dealData.name || 'deal';
    
    return 'Hi <@' + agentName + '>,\n\n' +
           'Thanks so much for updating the deal card! We noticed that you haven\'t yet linked a contact to the ' + dealName + ' deal card. ' +
           'Please do so ASAP, as that is a mandatory step in maintaining our metrics, and ensures we can provide the best possible service to you and your clients as the deal progresses. ' +
           'In the future, if you create your deals and appointments from the contact\'s page in FUB, they\'ll get linked automatically!';
}

// Step 13: Create Asana Task
async createAsanaTask(dealData, agentInfo) {
    const taskName = '🔴 No Contact Attached - ' + (dealData.name || 'Deal');
    const taskBody = 'Deal Title: ' + (dealData.name || 'Unknown') + '\n' +
                     'Assigned Agent: ' + (agentInfo.name || 'Unknown') + '\n' +
                     'Pipeline: ' + (dealData.pipeline || 'Unknown') + '\n' +
                     'Stage: ' + (dealData.stage || 'Unknown') + '\n\n' +
                     'Make sure this is updated and fixed within 24 hours.';

    try {
        // First get the assignee user ID
        const assigneeGid = await this.getAsanaUserByEmail('cadesanya@alignteam.com');
        
        const asanaPayload = {
            data: {
                name: taskName,
                notes: taskBody,
                projects: ['1209656267348045'], // Board ID
                assignee: assigneeGid
            }
        };

        const response = await axios.post('https://app.asana.com/api/1.0/tasks', asanaPayload, {
            headers: {
                'Authorization': 'Bearer ' + this.config.asana.accessToken,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        console.log('Asana task created:', response.data.data.gid);
        return response.data;
    } catch (error) {
        console.error('Asana API error:', error.response?.data || error.message);
        throw error;
    }
}

// Helper: Get Asana user by email
async getAsanaUserByEmail(email) {
    try {
        const response = await axios.get('https://app.asana.com/api/1.0/users', {
            headers: {
                'Authorization': 'Bearer ' + this.config.asana.accessToken
            },
            params: {
                opt_fields: 'gid,email'
            },
            timeout: 10000
        });

        const user = response.data.data.find(u => u.email === email);
        console.log('Asana user found:', user?.gid || 'not found');
        return user ? user.gid : null;
    } catch (error) {
        console.error('Error finding Asana user:', error.message);
        return null;
    }
}
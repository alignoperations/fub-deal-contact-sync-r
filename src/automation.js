async createAsanaTask(dealData, agentInfo) {
    const taskName = 'No Contact Attached - ' + (dealData.name || 'Deal');
    const taskBody = 'Deal Title: ' + (dealData.name || 'Unknown') + '\nAssigned Agent: ' + (agentInfo.name || 'Unknown') + '\nPipeline: ' + (dealData.pipelineName || 'Unknown') + '\nStage: ' + (dealData.stageName || 'Unknown') + '\n\nMake sure this is updated and fixed within 24 hours.';

    // Fixed assignee GID - no longer looking up by email
    const assigneeGid = '1209646560314034';
    
    console.log('=== ASANA DEBUG INFO ===');
    console.log('Task Name:', taskName);
    console.log('Task Body:', taskBody);
    console.log('Assignee GID:', assigneeGid);
    console.log('Project ID:', '1209656267348045');
    console.log('=== END ASANA DEBUG ===');
    
    const payload = {
        data: {
            name: taskName,
            notes: taskBody,
            projects: ['1209656267348045'],
            assignee: assigneeGid,
            workspace: '1160563790353820'  // Added required workspace parameter
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
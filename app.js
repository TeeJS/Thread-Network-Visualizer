// --- CONFIGURATION ---
// If empty, it attempts to use the current page's origin (good for "Host It There" method)
let API_BASE = ""; 

// --- VISUALIZATION SETUP ---
const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
const container = document.getElementById('mynetwork');
const data = { nodes: nodes, edges: edges };
const options = {
    nodes: {
        shape: 'hexagon',
        size: 25,
        font: { size: 14, face: 'monospace', background: 'transparent' },
        borderWidth: 2,
        shadow: true
    },
    edges: {
        width: 2,
        smooth: false,
        font: { align: 'top', size: 10, background: 'transparent', strokeWidth: 0 }
    },
    physics: {
        stabilization: false,
        barnesHut: { 
            gravitationalConstant: -5000, 
            springConstant: 0.05, 
            springLength: 200,
            damping: 0.09
        }
    }
};
const network = new vis.Network(container, data, options);

// --- STATE ---
const visitedNodes = new Set();
const nodeQueue = [];
let isScanning = false;
let currentLeaderId = null;

// Manual Name Mapping: { "ext_address_hex": "Friendly Name" }
let deviceNames = {
    "b2c9a2836317bc63": "Border Router",
    // Add your devices here, e.g.:
    // "f4ce36...": "Living Room Light"
};

// Try to load external names file if valid
fetch('device_names.json')
    .then(r => r.json())
    .then(data => { deviceNames = { ...deviceNames, ...data }; })
    .catch(e => console.log("No external device_names.json found, using defaults."));

// --- CLICK INTERACTION ---
network.on("click", function (params) {
    if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodes.get(nodeId);
        const detailHtml = `
            <strong>RLOC16:</strong> ${node.id}<br>
            <strong>Extended Address:</strong> <br>${node.title || 'Unknown'}<br>
            <strong>Role:</strong> ${node.group}<br>
            <strong>Raw Info:</strong> <pre style="font-size:10px">${JSON.stringify(node.rawData, null, 2)}</pre>
        `;
        document.getElementById('details-panel').innerHTML = detailHtml;
    }
});

// --- LOGGING ---
function log(msg) {
    const win = document.getElementById('log-window');
    const time = new Date().toLocaleTimeString().split(' ')[0];
    win.innerHTML += `<div class="log-entry"><span class="log-time">[${time}]</span> ${msg}</div>`;
    win.scrollTop = win.scrollHeight;
}

// --- UPDATED DISCOVERY ENGINE ---
async function startDiscovery() {
    // Set API URL from input if provided
    const inputUrl = document.getElementById('apiUrl').value;
    if (inputUrl) {
        API_BASE = inputUrl.replace(/\/$/, ""); 
    } else if (!API_BASE) {
        // Default to the known OTBR address if input is empty and no base set
        API_BASE = "http://192.168.1.50:8081";
        log(`No URL provided. Using default: ${API_BASE}`);
    }

    if (isScanning) return;
    isScanning = true;
    document.getElementById('btnStart').disabled = true;
    
    nodes.clear();
    edges.clear();
    visitedNodes.clear();
    nodeQueue.length = 0;

    log("Starting discovery...");

    try {
        // Step 1: Get Local Node (Border Router)
        const selfResp = await fetch(`${API_BASE}/node`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!selfResp.ok) throw new Error(`HTTP Error: ${selfResp.status}`);
        
        const selfData = await selfResp.json();
        
        // --- FIX IS HERE: Handle Flat vs Wrapped JSON ---
        // If 'result' exists, use it. Otherwise, use the root object.
        const rootData = selfData.result ? selfData.result : selfData; 
        
        // Capture Leader ID from local node data
        if (rootData.leaderData) {
            currentLeaderId = rootData.leaderData.leaderRouterId;
            log(`Network Leader Router ID: ${currentLeaderId}`);
        }

        const startRloc = rootData.rloc16;
        // FIX: If rootData.extAddress is missing in /node (sometimes it is), try to fetch /api/diagnostics/ for self first
        // But usually /node has it. If not, use 'undefined' which triggers fallback logic.
        const startExt = rootData.extAddress; 

        if (!startRloc) {
                throw new Error("Could not find RLOC16 in API response. Check console.");
        }
        
        log(`Border Router found at ${startRloc} (${startExt || 'Unknown Ext'})`);
        
        // Add BR to map
        addNodeToGraph(startRloc, { ...rootData, extAddress: startExt }, "Border Router");
        
        // Start Crawl with Object containing both RLOC and ExtAddress
        // ExtAddress is preferred for API destination
        nodeQueue.push({ rloc: startRloc, ext: startExt });
        processQueue();

    } catch (e) {
        console.error(e); // Log full error to browser console
        log(`Error: ${e.message}`);
        isScanning = false;
        document.getElementById('btnStart').disabled = false;
    }
}

async function processQueue() {
    if (nodeQueue.length === 0) {
        log("Discovery complete.");
        isScanning = false;
        document.getElementById('btnStart').disabled = false;
        return;
    }

    const currentNode = nodeQueue.shift();
    const currentRloc = currentNode.rloc;
    const currentExt = currentNode.ext;
    
    // Use Extended Address for unique visitation check if available, otherwise RLOC
    const visitKey = currentExt || currentRloc;

    if (visitedNodes.has(visitKey)) {
        processQueue();
        return;
    }
    visitedNodes.add(visitKey);

    log(`Probing node ${currentRloc} (${currentExt || '?'})...`);

    try {
        // Step 2: Create Async Task via /api/actions
        // New JSON:API format: Docs example uses "data" array.
        // Try using ExtAddress as destination, fallback to RLOC
        const payload = {
            data: [{
                type: "getNetworkDiagnosticTask",
                attributes: {
                    destination: currentExt || currentRloc,
                    types: ["routerNeighbors", "childTable", "rloc16", "extAddress"],
                    timeout: 5
                }
            }]
        };
        
        console.log("Sending Payload:", JSON.stringify(payload));
        log(`Probing ${currentRloc} (Ext: ${currentExt}) with destination: ${currentExt || currentRloc}`);

        const taskResp = await fetch(`${API_BASE}/api/actions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/vnd.api+json',
                'Accept': 'application/vnd.api+json'
            },
            body: JSON.stringify(payload)
        });

        if (!taskResp.ok) {
            const errorText = await taskResp.text();
            console.error("API Error Payload:", errorText); 
            throw new Error(`Task creation failed (${taskResp.status}): ${errorText}`);
        }
        
        const taskJson = await taskResp.json();
        
        // Extract Action ID (not the Result ID yet)
        let actionId;
        if (taskJson.data && Array.isArray(taskJson.data)) {
                actionId = taskJson.data[0].id;
        } else if (taskJson.data) {
                actionId = taskJson.data.id;
        }
        
        if (!actionId) throw new Error("Could not parse Action ID from response");

        // Step 3: Poll the Action until 'completed'
        const resultId = await pollAction(actionId);
        
        if (resultId) {
            // Step 4: Fetch the final Diagnostic Report
            const reportResp = await fetch(`${API_BASE}/api/diagnostics/${resultId}`, {
                headers: { 'Accept': 'application/vnd.api+json' }
            });
            const reportJson = await reportResp.json();
            
            // Extract attributes from report
            // result data usually looks like { data: [ { attributes: ... } ] } or { data: { attributes: ... } }
            const reportData = Array.isArray(reportJson.data) ? reportJson.data[0] : reportJson.data;
            updateGraph(reportData.attributes);
            log(`Scanned ${currentRloc}`);
        } else {
            log(`Failed to get data for ${currentRloc}`);
        }

    } catch (e) {
        log(`Error probing ${currentRloc}: ${e.message}`);
    }

    // Throttle requests slightly
    setTimeout(processQueue, 300);
}

async function pollAction(actionId) {
    let attempts = 0;
    const maxAttempts = 15;

    while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000)); // Wait 1 sec
        
        const statusResp = await fetch(`${API_BASE}/api/actions/${actionId}`, {
            headers: { 'Accept': 'application/vnd.api+json' }
        });
        const statusJson = await statusResp.json();
        
        const actionData = Array.isArray(statusJson.data) ? statusJson.data[0] : statusJson.data;
        const status = actionData.attributes.status;
        
        // Debug Log Status
        // console.log(`Polling ${actionId}: ${status}`, actionData);

        if (status === 'completed') {
            if (actionData.relationships && actionData.relationships.result && actionData.relationships.result.data) {
                return actionData.relationships.result.data.id;
            }
            return null;
        }
        if (status === 'failed' || status === 'stopped') {
            return null;
        }
        attempts++;
    }
    return null; // Timeout
}

function addNodeToGraph(rloc, data, role) {
    if (!rloc) return;
    const rawData = data || {};
    const ext = rawData.extAddress;
    
    let label = rloc;
    if (ext && deviceNames[ext]) {
            label = `${deviceNames[ext]}\n(${rloc})`;
    }

    if (!nodes.get(rloc)) {
        // Determine default color based on role
        let color = role === 'Border Router' ? '#ff9900' : '#97C2FC'; // Default Blue

        // Check if this node is the Leader
        if (currentLeaderId !== null) {
            // RLOC16 is 0xRR00. Router ID is top 6 bits.
            const rId = parseInt(rloc, 16) >> 10;
            if (rId === currentLeaderId) {
                color = '#800080'; // Purple for Leader
                role = `Leader (Router ${rId})`;
            }
        }

        nodes.add({
            id: rloc,
            label: label,
            title: `Ext: ${ext || '??'}\nRLOC: ${rloc}\nRole: ${role}`,
            group: role,
            color: color,
            rawData: rawData
        });
    } else {
        // Update existing node if we now have more info (e.g. valid Ext Address)
        const node = nodes.get(rloc);
        
        // Check for Leader status update if not set
        if (currentLeaderId !== null && node.group && !node.group.startsWith('Leader')) {
                const rId = parseInt(rloc, 16) >> 10;
                if (rId === currentLeaderId) {
                    nodes.update({
                        id: rloc,
                        group: `Leader (Router ${rId})`,
                        color: '#800080',
                        title: (node.title || '').replace(/Role: .*/, `Role: Leader (Router ${rId})`)
                    });
                }
        }
        
        const currentRawData = node.rawData || {};
        // If we didn't have extAddress before but do now, update
        if (!currentRawData.extAddress && rawData.extAddress) {
                const newExt = rawData.extAddress;
                let newLabel = rloc;
                if (newExt && deviceNames[newExt]) {
                newLabel = `${deviceNames[newExt]}\n(${rloc})`;
                }
                nodes.update({
                id: rloc,
                label: newLabel,
                title: `Ext: ${newExt}\nRLOC: ${rloc}`,
                rawData: { ...currentRawData, extAddress: newExt }
                });
        }
    }
}

function exportData() {
    const data = {
        nodes: nodes.get(),
        edges: edges.get()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thread-topo-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
}

function updateGraph(data) {
    const rloc = data.rloc16;
    
    addNodeToGraph(rloc, data, 'Router');

    // Process Neighbors
    if (data.routerNeighbors) {
        data.routerNeighbors.forEach(n => {
            const neighborRloc = n.rloc16;
            const neighborExt = n.extAddress;
            // FIX: Use linkQualityIn if available, else derive from linkMargin
            let lqi = n.linkQualityIn;
            if (lqi === undefined && n.linkMargin !== undefined) {
                const lm = n.linkMargin;
                if (lm > 20) lqi = 3;
                else if (lm > 10) lqi = 2;
                else if (lm > 2) lqi = 1;
                else lqi = 0;
            }
            
            // Ensure neighbor node exists (placeholder) so edge can connect
            if (!nodes.get(neighborRloc)) {
                // Use helper to ensure naming and coloring logic is applied immediately
                // even before we probe the node fully.
                addNodeToGraph(neighborRloc, { extAddress: neighborExt }, 'Router');
            }

            // Create Edge ID (sorted to prevent duplicates A->B vs B->A)
            const edgeId = [rloc, neighborRloc].sort().join('-');
            
            if (!edges.get(edgeId)) {
                let color = '#dc3545'; // Default Red
                
                // --- PHYSICS MODEL: Linear Length & Stiffness based on Signal ---
                // Signal Source: Link Margin (preferred) or RSSI
                // Link Margin Range: ~0 (bad) to ~80 (perfect).
                // RSSI Range: -90 (bad) to -20 (perfect).
                
                let signalVal = 0; // Baseline
                if (n.linkMargin !== undefined) {
                    signalVal = n.linkMargin; // Higher is better
                } else if (n.averageRssi !== undefined) {
                    // Map RSSI (-90 to -20) to approx Link Margin (5 to 75)
                    signalVal = Math.max(0, n.averageRssi + 95); 
                } else {
                    // Fallback to LQI buckets if no raw data
                    signalVal = lqi * 20; 
                }

                // Calculate Length: Signal decaying with square of distance 
                // LinkMargin 60 -> Dist ~180
                // LinkMargin 10 -> Dist ~450
                const K = 2000000;
                let length = Math.sqrt(K / Math.max(1, signalVal));
                length = Math.min(800, Math.max(150, length));

                // Color still based on standard LQI for recognizability
                if(lqi === 3) color = '#28a745'; 
                else if(lqi === 2) color = '#ffc107'; 
                
                // Main Visible Edge
                edges.add({
                    id: edgeId,
                    from: rloc,
                    to: neighborRloc,
                    label: `LQI:${lqi}\n(${signalVal}dB)`,
                    color: { color: color, highlight: color },
                    width: lqi === 3 ? 3 : 1,
                    length: length
                });
            }

            // Optimization: We check visitedNodes using ExtAddress if possible
            const visitKey = neighborExt || neighborRloc;
            if (!visitedNodes.has(visitKey)) {
                // Check if already in queue
                const alreadyQueued = nodeQueue.some(item => (item.ext && item.ext === neighborExt) || item.rloc === neighborRloc);
                if (!alreadyQueued) {
                        nodeQueue.push({ rloc: neighborRloc, ext: neighborExt });
                }
            }
        });
    }
    
    // Process Children (End Devices)
    // Note: Children are often sleepy end devices (SEDs) and we don't crawl them directly
    // because they don't have neighbors to share. We just display them attached to parent.
    if (data.childTable) {
        data.childTable.forEach((child, index) => {
            // Calculate Child RLOC16: Parent RLOC + Child ID
            // Note: This is an approximation. Child ID is usually the last bits.
            // But for display, we might just use a unique ID.
            const childId = `${rloc}_child_${child.childId}`;
            
            // Add Child Node
            if (!nodes.get(childId)) {
                // Try to guess ExtAddress or matching name if we have a way (we don't easily)
                // Unless we looked up the child table elsewhere. 
                // Usually Diagnostics 'childTable' only gives: { childId, timeout, mode, linkQuality }
                // It does NOT give Extended Address. That is why they are missing ExtAddr.
                
                const isSleepy = child.mode && !child.mode.rxOnWhenIdle;
                const label = `Child ${child.childId}\n${isSleepy ? '(Sleepy)' : ''}`;
                
                nodes.add({
                    id: childId,
                    label: label,
                    title: `Child ID: ${child.childId}\nTimeout: ${child.timeout}\nSleepy: ${isSleepy}`,
                    group: 'EndDevice',
                    shape: isSleepy ? 'dot' : 'diamond', 
                    size: 10,
                    color: '#6c757d', 
                    rawData: child
                });
                
                // Add Edge to Parent
                edges.add({
                    from: rloc,
                    to: childId,
                    dashes: true, // Dashed line for child-parent
                    length: 50,
                    color: { color: '#aaa' }
                });
            }
        });
    }
}
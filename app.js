// --- CONFIGURATION ---
// If empty, it attempts to use the current page's origin (good for "Host It There" method)
let API_BASE = "http://192.168.1.25:8081"; 

// --- VISUALIZATION SETUP ---
const ROUTER_NODE_SIZE = 15;
const END_DEVICE_NODE_SIZE = 15;

const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
const container = document.getElementById('mynetwork');
const data = { nodes: nodes, edges: edges };
const options = {
    nodes: {
        shape: 'hexagon',
        size: ROUTER_NODE_SIZE,
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
            gravitationalConstant: -10000, 
            springConstant: 0.04, 
            springLength: 100,
            damping: 0.09
        }
    }
};
const network = new vis.Network(container, data, options);

// --- EVENT LISTENERS ---
document.getElementById('btnStart').addEventListener('click', startDiscovery);
document.getElementById('btnExport').addEventListener('click', exportData);
// Import Logic
const modal = document.getElementById('importModal');
document.getElementById('btnImport').addEventListener('click', () => modal.style.display = 'flex');
document.getElementById('btnCancelImport').addEventListener('click', () => modal.style.display = 'none');
document.getElementById('btnParseImport').addEventListener('click', parseCliInput);

// Add listener for Link Filter
document.getElementById('linkFilter').addEventListener('change', updateLinkVisibility);

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
        
        let ip6Html = '';
        if (node.rawData && node.rawData.ip6 && Array.isArray(node.rawData.ip6)) {
            ip6Html = '<strong>IPv6 Addresses:</strong><br><div style="font-size:10px; margin-left:10px;">' + 
                      node.rawData.ip6.join('<br>') + '</div><br>';
        }

        const extAddr = (node.rawData && node.rawData.extAddress) ? node.rawData.extAddress : (node.title ? node.title.split('\n')[0] : 'Unknown');

        const detailHtml = `
            <strong>RLOC16:</strong> ${node.id}<br>
            <strong>Extended Address:</strong> <br>${extAddr}<br>
            ${ip6Html}
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

// --- UPDATED DISCOVERY ENGINE (uses /node + /diagnostics directly) ---
async function startDiscovery() {
    const inputUrl = (document.getElementById('apiUrl').value || '').trim();
    API_BASE = inputUrl ? inputUrl.replace(/\/$/, "") : "http://192.168.1.25:8081";

    if (isScanning) return;
    isScanning = true;
    document.getElementById('btnStart').disabled = true;

    nodes.clear();
    edges.clear();
    visitedNodes.clear();
    nodeQueue.length = 0;

    log("Starting discovery...");

    // Fetch Matter Server Thread-device metadata up front. We do NOT apply names
    // here - we cache the list and structurally match it to the OTBR crawl
    // result after discovery completes (see applyMatterNames below).
    //
    // Why structural match instead of direct field lookup: the Matter Thread
    // Network Diagnostics cluster (id 53) does not expose a node's own RLOC16
    // or ExtAddress. Attr 0/53/3 is PanId. Ext addresses in NeighborTable
    // entries are uint64 and lose precision through JSON.parse in JS. The
    // only reliable signal each Matter Thread device exposes about itself is
    // its RoutingRole (0/53/1) and its NeighborTable (0/53/7), which lists
    // the RLOC16s of its peers - for a sleepy end device this is its parent.
    let matterThreadDevices = [];
    const haUrl = (document.getElementById('haUrl').value || '').replace(/\/$/, '');
    const matterHost = haUrl ? haUrl.replace(/^https?:\/\//, '').split(':')[0] : '192.168.1.25';
    const matterWsUrl = `ws://${matterHost}:5580/ws`;
    try {
        const matterNodes = await fetchMatterNodes(matterWsUrl);
        matterThreadDevices = matterNodes
            .filter(n => {
                const a = n.attributes || {};
                const rr = a['0/53/1'];
                return rr !== undefined && rr !== null && typeof rr !== 'object';
            })
            .map(n => {
                const a = n.attributes || {};
                const name = a['0/40/5'] || a['0/40/3'] || `Matter Node ${n.node_id}`;
                const role = a['0/53/1']; // 2=SED, 3=ED, 4=REED, 5=Router, 6=Leader
                // First neighbor entry's RLOC16 (index "2" per Matter spec); for
                // an end device this is its attachment/parent router's RLOC16.
                const neighbors = Array.isArray(a['0/53/7']) ? a['0/53/7'] : [];
                const parentRloc16 = neighbors.length && neighbors[0]['2'] !== undefined
                    ? Number(neighbors[0]['2']) : null;
                return { node_id: n.node_id, name, role, parentRloc16 };
            });
        if (matterThreadDevices.length) {
            log(`Matter Server has ${matterThreadDevices.length} Thread device(s); will match to mesh after crawl.`);
        }
    } catch (e) {
        // Matter Server is optional - continue silently
    }

    try {
        // Step 1: Get local node info
        const selfResp = await fetch(`${API_BASE}/node`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!selfResp.ok) throw new Error(`HTTP Error: ${selfResp.status}`);

        const selfData = await selfResp.json();
        const rootData = selfData.result ? selfData.result : selfData;

        const leaderData = rootData.leaderData || rootData.LeaderData;
        if (leaderData) {
            currentLeaderId = leaderData.leaderRouterId || leaderData.LeaderRouterId;
            log(`Network Leader Router ID: ${currentLeaderId}`);
        }

        // Handle both capitalizations
        const startRloc16 = rootData.rloc16 || rootData.Rloc16;
        const startRloc = startRloc16 !== undefined
            ? '0x' + startRloc16.toString(16).toUpperCase().padStart(4, '0')
            : null;
        const startExt = rootData.extAddress || rootData.ExtAddress;

        if (!startRloc) {
            throw new Error("Could not find Rloc16 in /node response.");
        }

        log(`Border Router found at ${startRloc} (${startExt || 'Unknown Ext'})`);

        // Step 2: Fetch all diagnostics at once from /diagnostics
        log("Fetching network diagnostics...");
        const diagResp = await fetch(`${API_BASE}/diagnostics`, {
            headers: { 'Accept': 'application/json' }
        });

        if (!diagResp.ok) throw new Error(`Diagnostics HTTP Error: ${diagResp.status}`);

        const diagData = await diagResp.json();
        const diagArray = Array.isArray(diagData) ? diagData : [diagData];

        log(`Received diagnostics for ${diagArray.length} node(s).`);

        // Add border router first
        addNodeToGraph(startRloc, { ...rootData, extAddress: startExt }, "Border Router");

        // Build a map of Rloc16 -> diagnostic entry for quick lookup
        const rlocMap = {};
        diagArray.forEach(entry => {
            const rloc = typeof entry.Rloc16 === 'number'
                ? '0x' + entry.Rloc16.toString(16).toUpperCase().padStart(4, '0')
                : entry.rloc16 || entry.Rloc16;
            if (rloc) rlocMap[rloc] = entry;
        });

        // Add all nodes and edges from diagnostics
        diagArray.forEach(entry => {
            const rloc = typeof entry.Rloc16 === 'number'
                ? '0x' + entry.Rloc16.toString(16).toUpperCase().padStart(4, '0')
                : entry.rloc16 || entry.Rloc16;
            const ext = entry.ExtAddress || entry.extAddress;
            const ip6 = entry.IP6AddressList || entry.ipv6AddressList || [];

            if (!rloc) return;

            const isBR = rloc === startRloc;
            const role = isBR ? 'Border Router' : 'Router';

            addNodeToGraph(rloc, { extAddress: ext, ip6: ip6 }, role);

            // Add edges from RouteData
            if (entry.Route && entry.Route.RouteData) {
                entry.Route.RouteData.forEach(route => {
                    const neighborRouterId = route.RouteId;
                    // Convert Router ID to RLOC16: routerId << 10
                    const neighborRloc = '0x' + (neighborRouterId << 10).toString(16).toUpperCase().padStart(4, '0');
                    const lqiIn = route.LinkQualityIn || 0;
                    const lqiOut = route.LinkQualityOut || 0;
                    const lqi = Math.max(lqiIn, lqiOut);

                    if (lqi === 0) return; // No link

                    const edgeId = [rloc, neighborRloc].sort().join('-');
                    if (!edges.get(edgeId)) {
                        let color = '#dc3545';
                        if (lqi === 3) color = '#28a745';
                        else if (lqi === 2) color = '#ffc107';

                        const length = lqi === 3 ? 375 : (lqi === 2 ? 750 : 1250);

                        edges.add({
                            id: edgeId,
                            from: rloc,
                            to: neighborRloc,
                            lqi: lqi,
                            label: `LQI:${lqi}`,
                            color: { color: color, highlight: color },
                            width: lqi === 3 ? 3 : 1,
                            length: length
                        });
                    }
                });
            }

            // Add children from ChildTable
            if (entry.ChildTable && Array.isArray(entry.ChildTable)) {
                entry.ChildTable.forEach((child, idx) => {
                    const childRloc16 = child.ChildId !== undefined
                        ? parseInt(rloc, 16) | child.ChildId
                        : null;
                    const childId = childRloc16
                        ? '0x' + childRloc16.toString(16).toUpperCase().padStart(4, '0')
                        : `${rloc}_child_${idx}`;

                    if (!nodes.get(childId)) {
                        const isSleepy = child.Mode && !child.Mode.RxOnWhenIdle;
                        const nameByRloc = deviceNames[childId] || deviceNames[childId.toLowerCase()] || null;
                        const childLabel = nameByRloc
                            ? `${nameByRloc}\n(${childId})`
                            : `Child\n${childId}`;
                        nodes.add({
                            id: childId,
                            label: childLabel,
                            group: 'EndDevice',
                            color: '#6c757d',
                            shape: isSleepy ? 'dot' : 'diamond',
                            size: END_DEVICE_NODE_SIZE,
                            rawData: child
                        });
                    }

                    const edgeId = [rloc, childId].sort().join('-');
                    if (!edges.get(edgeId)) {
                        edges.add({
                            id: edgeId,
                            from: rloc,
                            to: childId,
                            dashes: true,
                            color: '#aaa',
                            width: 1,
                            length: 125
                        });
                    }
                });
            }
        });

        if (matterThreadDevices.length) {
            applyMatterNames(matterThreadDevices);
        }

        log("Discovery complete.");

    } catch (e) {
        console.error(e);
        log(`Error: ${e.message}`);
    }

    isScanning = false;
    document.getElementById('btnStart').disabled = false;
}

// Structural cross-reference of Matter's Thread-device metadata against the
// OTBR mesh we just crawled. Strategy:
//   1. Matter's sole Leader (RoutingRole=6) -> OTBR's Leader (unique match).
//   2. Matter's end devices (RoutingRole=2/3) each report a parent RLOC16
//      (first neighbor). Group both sides by parent and match one-to-one;
//      when counts differ, label all OTBR children under that parent with
//      the joined candidate names so the user at least sees something.
// Names are written through deviceNames so existing lookup paths work, then
// existing node labels on the graph are updated in place.
function applyMatterNames(matterDevices) {
    const graphNodes = nodes.get();
    let matches = 0;

    const rolEnum = { SED: 2, ED: 3, REED: 4, ROUTER: 5, LEADER: 6 };

    // 1) Leader match
    const otbrLeader = graphNodes.find(n => (n.group || '').startsWith('Leader'));
    const matterLeader = matterDevices.find(m => m.role === rolEnum.LEADER);
    if (otbrLeader && matterLeader) {
        deviceNames[otbrLeader.id] = matterLeader.name;
        deviceNames[otbrLeader.id.toLowerCase()] = matterLeader.name;
        const ext = otbrLeader.rawData && otbrLeader.rawData.extAddress;
        if (ext) {
            deviceNames[ext.toUpperCase()] = matterLeader.name;
            deviceNames[ext] = matterLeader.name;
        }
        matches++;
    }

    // 2) Non-leader routers: match by position in OTBR router list, excluding leader.
    //    Only attempt if counts match (otherwise too ambiguous).
    const otbrNonLeaderRouters = graphNodes.filter(n => {
        const g = n.group || '';
        return (g === 'Border Router' || g === 'Router') && !g.startsWith('Leader');
    });
    const matterRouters = matterDevices.filter(m => m.role === rolEnum.ROUTER);
    if (otbrNonLeaderRouters.length === matterRouters.length && otbrNonLeaderRouters.length > 0) {
        otbrNonLeaderRouters.forEach((n, i) => {
            const name = matterRouters[i].name;
            deviceNames[n.id] = name;
            const ext = n.rawData && n.rawData.extAddress;
            if (ext) deviceNames[ext.toUpperCase()] = name;
            matches++;
        });
    }

    // 3) Children: group by parent router RLOC16 and match within each group.
    const otbrChildrenByParent = {};
    edges.get().forEach(e => {
        if (e.dashes) {
            (otbrChildrenByParent[e.from] ||= []).push(e.to);
        }
    });
    const matterChildrenByParent = {};
    matterDevices
        .filter(m => (m.role === rolEnum.SED || m.role === rolEnum.ED) && m.parentRloc16 !== null)
        .forEach(m => {
            const parentKey = '0x' + m.parentRloc16.toString(16).toUpperCase().padStart(4, '0');
            (matterChildrenByParent[parentKey] ||= []).push(m);
        });

    Object.entries(otbrChildrenByParent).forEach(([parent, childIds]) => {
        const candidates = matterChildrenByParent[parent] || [];
        if (!candidates.length) return;
        if (candidates.length === childIds.length) {
            // Unambiguous 1:1 (still arbitrary ordering, but best we can do).
            childIds.forEach((id, i) => {
                deviceNames[id] = candidates[i].name;
                matches++;
            });
        } else {
            // Counts differ - fall back to joined candidate names on every child
            // under this parent, so user at least sees plausible names.
            const joined = [...new Set(candidates.map(c => c.name))].join(' / ');
            childIds.forEach(id => {
                deviceNames[id] = joined;
                matches++;
            });
        }
    });

    // Re-render labels. Priority: deviceNames match -> OTBR role for infra
    // (Border Router / Leader) -> existing label. This ensures *every* node
    // on the graph shows something human-readable, never raw hex.
    graphNodes.forEach(n => {
        const id = n.id;
        const ext = (n.rawData && n.rawData.extAddress) ? n.rawData.extAddress.toUpperCase() : null;
        const group = n.group || '';
        let name = deviceNames[id] || deviceNames[(id || '').toLowerCase()] ||
                   (ext ? deviceNames[ext] : null);
        if (!name) {
            if (group === 'Border Router') name = 'Border Router';
            else if (group.startsWith('Leader')) name = group; // "Leader (Router 4)"
        }
        if (name) {
            nodes.update({ id, label: `${name}\n(${id})` });
        }
    });

    if (matches) log(`Applied ${matches} Matter name(s) via structural match.`);
}

async function processQueue() {
    log("Discovery complete.");
    isScanning = false;
    document.getElementById('btnStart').disabled = false;
}

async function pollAction(actionId) {
    return null;
}

// --- MATTER SERVER WEBSOCKET ---
async function fetchMatterNodes(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.message_id === 'get_nodes' && msg.result) {
                ws.close();
                resolve(msg.result);
            }
        };

        ws.onopen = () => {
            ws.send(JSON.stringify({ message_id: 'get_nodes', command: 'get_nodes' }));
        };

        ws.onerror = () => reject(new Error('Matter Server WebSocket connection failed'));

        setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) {
                ws.close();
                reject(new Error('Matter Server timed out after 15s'));
            }
        }, 15000);
    });
}

// Match a Thread node's IPv6 addresses against HA Matter device connections
function matchHADeviceByIPv6(ip6List) {
    return null; // Now handled via Matter Server RLOC16 matching
}

function addNodeToGraph(rloc, data, role, startPos = null) {
    if (!rloc) return;
    const rawData = data || {};
    const ext = rawData.extAddress;
    
    let label = rloc;
    // Try matching by RLOC16 (from Matter Server)
    // Match by RLOC16 (exact match, case insensitive on hex digits only)
    const rlocLower = rloc ? rloc.toLowerCase() : '';
    const extUpper = ext ? ext.toUpperCase() : '';
    const nameByRloc = deviceNames[rloc] || deviceNames[rlocLower] ||
        deviceNames[rloc.replace('0x','0x').toUpperCase()] || null;
    const nameByExt = extUpper ? (deviceNames[extUpper] || deviceNames[ext] || null) : null;
    if (nameByRloc) {
        label = `${nameByRloc}\n(${rloc})`;
    } else if (nameByExt) {
        label = `${nameByExt}\n(${rloc})`;
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
        
        // Use supplied role color if specific role string matched
        if (role.includes('Leader')) color = '#800080';

        let title = `Ext: ${ext || '??'}\nRLOC: ${rloc}\nRole: ${role}`;
        if (rawData.ip6) title += `\nIPv6: ${rawData.ip6.join('\n      ')}`;

        const nodeOpts = {
            id: rloc,
            label: label,
            title: title,
            group: role,
            color: color,
            rawData: rawData
        };

        if (startPos) {
            nodeOpts.x = startPos.x;
            nodeOpts.y = startPos.y;
        }

        nodes.add(nodeOpts);
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
        let needsUpdate = false;
        let updates = { id: rloc };

        if (!currentRawData.extAddress && rawData.extAddress) {
            const newExt = rawData.extAddress;
            let newLabel = rloc;
            if (newExt && deviceNames[newExt]) {
               newLabel = `${deviceNames[newExt]}\n(${rloc})`;
            }
            updates.label = newLabel;
            updates.title = (node.title || '').replace('Ext: ??', `Ext: ${newExt}`); // Simple replace
            updates.rawData = { ...currentRawData, extAddress: newExt };
            needsUpdate = true;
        }
        
        // Update IPv6 if provided
        if (rawData.ip6 && (!currentRawData.ip6 || currentRawData.ip6.length === 0)) {
             updates.rawData = updates.rawData || { ...currentRawData };
             updates.rawData.ip6 = rawData.ip6;
             updates.title = (updates.title || node.title) + `\nIPv6: ${rawData.ip6.join('\n      ')}`;
             needsUpdate = true;
        }

        if (needsUpdate) nodes.update(updates);
    }
}

// --- CLI IMPORT PARSER ---
function parseCliInput() {
    const text = document.getElementById('cliInput').value;
    if (!text) return;

    // Reset Graph
    nodes.clear();
    edges.clear();
    visitedNodes.clear();
    nodeQueue.length = 0;
    currentLeaderId = null;

    // Helper to add edges
    const pendingEdges = []; // {fromId, toId, lqi} - using Router IDs, resolve later

    // 1. Split into blocks by "id:"
    // Blocks look like: "id:01 rloc16:0x0400 ..."
    // We split by newline, then look for lines starting with "id:" or indented sections
    const lines = text.split('\n');
    let currentNode = null;
    
    // Quick Router ID to RLOC mapping for second pass
    const idToRloc = {}; 

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('id:')) {
            // Start of a node
            // Format: id:01 rloc16:0x0400 ext-addr:b2c9a2836317bc63 ver:5 - me - br
            const parts = line.split(/\s+/);
            const idPart = parts.find(p => p.startsWith('id:'));
            const rlocPart = parts.find(p => p.startsWith('rloc16:'));
            const extPart = parts.find(p => p.startsWith('ext-addr:'));
            const isLeader = line.toLowerCase().includes('leader');
            const isBr = line.toLowerCase().includes('br');

            if (rlocPart) {
                const rloc = rlocPart.split(':')[1];
                const id = idPart ? parseInt(idPart.split(':')[1], 10) : null;
                const ext = extPart ? extPart.split(':')[1] : null;

                currentNode = {
                    rloc: rloc,
                    ext: ext,
                    id: id,
                    role: isLeader ? `Leader (Router ${id})` : (isBr ? 'Border Router' : 'Router'),
                    ip6: [],
                    neighbors: [], // {id, lqi}
                    children: []
                };
                
                if (id !== null) {
                    idToRloc[id] = rloc;
                    if (isLeader) currentLeaderId = id;
                }
                
                // Add to graph immediately
                addNodeToGraph(rloc, { extAddress: ext }, currentNode.role);
            }
        } else if (currentNode && line.includes('-links:{')) {
            // Neighbor Links
            // Format: 3-links:{ 14 17 ... }
            // "3-links" means LQI 3
            const linkMatch = line.match(/(\d)-links:\{\s*([\d\s]+)\s*\}/);
            if (linkMatch) {
                const lqi = parseInt(linkMatch[1]);
                const neighborIds = linkMatch[2].trim().split(/\s+/).map(s => parseInt(s, 10));
                neighborIds.forEach(nId => {
                    currentNode.neighbors.push({ id: nId, lqi: lqi });
                });
            }
        } else if (currentNode && line.startsWith('rloc16:') && line.includes('lq:')) {
            // Child line (indented usually, but we trimmed)
            // Format: rloc16:0x4409 lq:3, mode:-
            const rlocMatch = line.match(/rloc16:(0x[0-9a-fA-F]+)/);
            const lqiMatch = line.match(/lq:(\d)/);
            if (rlocMatch) {
                currentNode.children.push({
                    rloc: rlocMatch[1],
                    lqi: lqiMatch ? parseInt(lqiMatch[1]) : 0
                });
            }
        } else if (currentNode && line.includes(':') && line.length > 20 && !line.includes('ip6-addrs')) {
            // Likely an IP address (heuristic)
            if (line.includes('fd') || line.includes('fe80')) {
                currentNode.ip6.push(line);
            }
        }
        
        // Update stored node data with gathered arrays
        if (currentNode) {
             // We update the node in the dataset with the IP list continuously or at end of block
             // Doing it here inefficiently but safely
             nodes.update({
                 id: currentNode.rloc,
                 rawData: { extAddress: currentNode.ext, ip6: currentNode.ip6 } 
             });
             
             // Queue edges
             if (currentNode.neighbors.length > 0) {
                 currentNode.neighbors.forEach(n => {
                     // Check if already queued? No, just store for post-processing
                     // We need to resolve IDs to RLOCs
                     pendingEdges.push({ from: currentNode.rloc, toId: n.id, lqi: n.lqi });
                 });
                 currentNode.neighbors = []; // Clear to avoid re-adding
             }
             
             if (currentNode.children.length > 0) {
                 currentNode.children.forEach(c => {
                     // Add child node
                     const childRloc = c.rloc;
                     if(!nodes.get(childRloc)) {
                        nodes.add({
                            id: childRloc,
                            label: 'Child\n' + childRloc,
                            group: 'EndDevice',
                            color: '#6c757d',
                            shape: 'dot',
                            size: END_DEVICE_NODE_SIZE
                        });
                     }
                     
                     // Add edge immediately
                     const edgeId = [currentNode.rloc, childRloc].sort().join('-');
                     if (!edges.get(edgeId)) {
                        edges.add({
                            id: edgeId,
                            from: currentNode.rloc,
                            to: childRloc,
                            lqi: c.lqi,
                            dashes: true,
                            color: '#aaa',
                            width: 1,
                            length: 125 // Scaled 2.5x (was 50)
                        });
                     }
                 });
                 currentNode.children = [];
             }
        }
    });
    
    // Pass 2: Create Edges from Pending
    // We only add edges where we know the destination RLOC
    const processedEdgeIds = new Set();
    
    pendingEdges.forEach(e => {
        const toRloc = idToRloc[e.toId];
        if (toRloc) {
            const edgeId = [e.from, toRloc].sort().join('-');
            if (!processedEdgeIds.has(edgeId)) {
                processedEdgeIds.add(edgeId);

                // Calculate color/width based on LQI
                let color = '#dc3545'; // 1
                if (e.lqi === 3) color = '#28a745';
                else if (e.lqi === 2) color = '#ffc107';
                
                // Simple Physics for Imported Data (no RSSI/LinkMargin available in this summary usually)
                // LQI 3 -> Short (375), LQI 1 -> Long (1250)
                // Scaled by 2.5x ("150% longer")
                const length = e.lqi === 3 ? 375 : (e.lqi === 2 ? 750 : 1250);

                edges.add({
                    id: edgeId,
                    from: e.from,
                    to: toRloc,
                    label: `LQI:${e.lqi}`,
                    lqi: e.lqi,
                    color: { color: color, highlight: color },
                    width: e.lqi === 3 ? 3 : 1,
                    length: length
                });
            }
        }
    });

    log("Imported topology from CLI output.");
    document.getElementById('importModal').style.display = 'none';
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

function updateLinkVisibility() {
    const minLqi = parseInt(document.getElementById('linkFilter').value);
    const updates = [];
    const allEdges = edges.get();
    
    allEdges.forEach(edge => {
        // Retrieve LQI. If undefined (e.g. child links), treat as high quality (99) to keep visible.
        const lqi = edge.lqi !== undefined ? edge.lqi : 99;
        
        const shouldHide = lqi < minLqi;
        
        // Update check: If visibility OR physics state is wrong, update it.
        // We disable physics for hidden edges so they don't pull nodes together invisibly.
        if (edge.hidden !== shouldHide || edge.physics === shouldHide) {
            updates.push({ 
                id: edge.id, 
                hidden: shouldHide,
                physics: !shouldHide // Physics ON if shown, OFF if hidden
            });
        }
    });

    if (updates.length > 0) {
        edges.update(updates);
    }
}

function updateGraph(data) {
    const rloc = data.rloc16;
    
    // Normalize IPv6 list for display
    if (data.ipv6Addresses) {
        data.ip6 = data.ipv6Addresses;
    } else if (data.ip6AddressList) {
        data.ip6 = data.ip6AddressList;
    }

    addNodeToGraph(rloc, data, 'Router');

    // Process Neighbors
    if (data.routerNeighbors) {
        // Pre-calculate positions for purely new nodes to distribute them in a circle
        const newNeighbors = data.routerNeighbors.filter(n => !nodes.get(n.rloc16));
        const parentPositions = network.getPositions([rloc]);
        const parentPos = parentPositions[rloc] || {x: 0, y: 0};
        const distributionRadius = 250; 

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
                // Calculate start position if this is a new node
                let startPos = null;
                const newIndex = newNeighbors.indexOf(n);
                if (newIndex !== -1) {
                    const angle = (newIndex / newNeighbors.length) * 2 * Math.PI;
                    startPos = {
                        x: parentPos.x + distributionRadius * Math.cos(angle),
                        y: parentPos.y + distributionRadius * Math.sin(angle)
                    };
                }

                // Use helper to ensure naming and coloring logic is applied immediately
                // even before we probe the node fully.
                addNodeToGraph(neighborRloc, { extAddress: neighborExt }, 'Router', startPos);
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
                // Scaled K for "150% longer" (2.5x base). 2000000 * 6.25 = 12500000
                const K = 12500000;
                let length = Math.sqrt(K / Math.max(1, signalVal));
                length = Math.min(2000, Math.max(375, length));

                // Color still based on standard LQI for recognizability
                if(lqi === 3) color = '#28a745'; 
                else if(lqi === 2) color = '#ffc107'; 
                
                // Main Visible Edge
                // Check current filter setting
                const minLqi = parseInt(document.getElementById('linkFilter').value) || 0;
                const isVisible = lqi >= minLqi;

                edges.add({
                    id: edgeId,
                    from: rloc,
                    to: neighborRloc,
                    lqi: lqi, // Store LQI for filtering
                    label: `LQI:${lqi}\n(${signalVal}dB)`,
                    color: { color: color, highlight: color },
                    width: lqi === 3 ? 3 : 1,
                    length: length,
                    hidden: !isVisible, 
                    physics: isVisible // Only participate in physics if visible
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
        // Pre-calculate positions for NEW children to distribute them in a separate circle
        const newChildren = data.childTable.filter(child => {
             const childId = `${rloc}_child_${child.childId}`;
             return !nodes.get(childId);
        });
        const parentPositions = network.getPositions([rloc]);
        const parentPos = parentPositions[rloc] || {x: 0, y: 0};
        const childRadius = 125; 

        data.childTable.forEach((child, index) => {
            // Calculate Child RLOC16: Parent RLOC + Child ID
            // Note: This is an approximation. Child ID is usually the last bits.
            // But for display, we might just use a unique ID.
            const childId = `${rloc}_child_${child.childId}`;
            
            // Add Child Node
            if (!nodes.get(childId)) {
                
                let startX = undefined;
                let startY = undefined;
                const newIndex = newChildren.indexOf(child);
                if (newIndex !== -1) {
                     // Interleave or offset angle to avoid direct overlap with router neighbors
                     const angle = (newIndex / newChildren.length) * 2 * Math.PI + (Math.PI / 3); 
                     startX = parentPos.x + childRadius * Math.cos(angle);
                     startY = parentPos.y + childRadius * Math.sin(angle);
                }

                // Try to guess ExtAddress or matching name if we have a way (we don't easily)
                // Unless we looked up the child table elsewhere. 
                // Usually Diagnostics 'childTable' only gives: { childId, timeout, mode, linkQuality }
                // It does NOT give Extended Address. That is why they are missing ExtAddr.
                
                const isSleepy = child.mode && !child.mode.rxOnWhenIdle;
                const label = `Child ${child.childId}\n${isSleepy ? '(Sleepy)' : ''}`;
                
                const nodeOpts = {
                    id: childId,
                    label: label,
                    title: `Child ID: ${child.childId}\nTimeout: ${child.timeout}\nSleepy: ${isSleepy}`,
                    group: 'EndDevice',
                    shape: isSleepy ? 'dot' : 'diamond', 
                    size: END_DEVICE_NODE_SIZE,
                    color: '#6c757d', 
                    rawData: child
                };

                if (startX !== undefined) {
                    nodeOpts.x = startX;
                    nodeOpts.y = startY;
                }
                
                nodes.add(nodeOpts);
                
                // Add Edge to Parent
                edges.add({
                    from: rloc,
                    to: childId,
                    dashes: true, // Dashed line for child-parent
                    length: 125, // Scaled 2.5x
                    color: { color: '#aaa' }
                });
            }
        });
    }
}
# Thread Mesh Visualizer

A web-based tool to visualize OpenThread network topology in real-time. It communicates with an OpenThread Border Router (OTBR) to crawl the network, map connections between routers and end devices, and display link quality using a physics-based graph layout.

![Thread Mesh Visualization](https://openthread.io/static/images/ot-logo-narrow.png)

## Features

*   **Iterative Crawl**: Starts from the Border Router and discovers neighbors hop-by-hop using the OTBR REST API (JSON:API).
*   **Physics Logic**: Link lengths are calculated using an Inverse Square Law based on signal strength (Link Margin or RSSI), providing a realistic spatial representation of the mesh.
*   **Link Filtering**: Toggle visibility of weak/medium links. Hidden links stop affecting the physics simulation, allowing the graph to relax.
*   **CLI Import**: Can parsing the output of `ot-ctl meshdiag topology` for instant visualization without using the REST API.
*   **Device Naming**: Map hex addresses to friendly names via a JSON configuration file.
*   **Detailed Inspection**: Click nodes to see RLOC16, ExtAddress, Role, IPv6 addresses, and raw diagnostic data.
*   **Export**: Save the current topology architecture to JSON.

## Prerequisites

1.  **OpenThread Border Router (OTBR)**: You need an active OTBR with the Web GUI/REST API enabled (usually on port 80 or 8081).
2.  **Network Access**: The machine running this visualizer must be able to reach the OTBR's IP address.

## Installation & Usage

You can run this as a static web page. No build process is required (Vanilla JS + CSS).

### Option 1: Run Locally (Python Server)

1.  Clone this repository.
2.  Start a simple HTTP server in the folder:
    ```bash
    python3 -m http.server 8000
    ```
3.  Open `http://localhost:8000` in your browser.
4.  Enter your OTBR URL (e.g., `http://192.168.1.50:8081`) and click **Start Crawl**.

> **CORS Warning**: If your OTBR is on a different domain/port than your viewer, you might hit CORS restrictions.
> *   **Workaround**: Host these files *on* the OTBR web server directly (see Option 2).
> *   **Or**: Use a browser extension to disable CORS for testing.

### Option 2: "Host It There" (Recommended)

To avoid CORS issues and CORS configuration:

1.  Copy `index.html`, `app.js`, `style.css`, and `device_names.json` to the OTBR web server directory (often `/usr/share/otbr-web/` or similar, depending on installation).
2.  Access the visualizer via the OTBR's IP address (e.g., `http://<OTBR_IP>/index.html`).
3.  Leave the URL field blank; it will default to the current origin.

### Option 3: Docker (Unraid / any Docker host)

This fork ships a **~1.5 MB** Docker image built on `busybox:musl` + busybox `httpd`. Multi-arch (`linux/amd64`, `linux/arm64`) images are published to GitHub Container Registry on every push to `main` and on every `v*.*.*` tag.

**Image:** `ghcr.io/teejs/thread-network-visualizer:latest`

#### Run with `docker run`

```bash
docker run -d \
  --name thread-network-visualizer \
  -p 8080:8080 \
  -v /path/to/appdata:/config \
  --restart unless-stopped \
  ghcr.io/teejs/thread-network-visualizer:latest
```

On first start the container seeds `/config/device_names.json` with a default. Edit that file to add your devices - the web server serves it live, so just refresh the browser to pick up changes.

#### Run on Unraid (tested on 7.2.4)

Unraid's **Add Container** form has no template-URL paste field - you either drop the template XML on the flash drive and pick it from the dropdown, or fill the form manually. Both paths end in the same running container.

**Option A - drop the template on the flash drive (gets you the prefilled dropdown + reusable for reinstalls):**

SSH into Unraid (or open the web terminal) and run:

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-thread-network-visualizer.xml \
  https://raw.githubusercontent.com/TeeJS/Thread-Network-Visualizer/main/unraid-template.xml
```

Then **Docker tab -> Add Container -> Template dropdown -> `my-thread-network-visualizer`**. All fields prefill. Click **Apply**.

**Option B - fill the form manually (no SSH needed):**

| Field | Value |
|---|---|
| Name | `Thread-Network-Visualizer` |
| Repository | `ghcr.io/teejs/thread-network-visualizer:latest` |
| Network Type | `Bridge` |

Then click **+ Add another Path, Port, Variable, Label or Device** twice:

*   Port: Name `WebUI`, Container `8080`, Host `8080`, Type `TCP`
*   Path: Name `Config`, Container `/config`, Host `/mnt/user/appdata/thread-network-visualizer`, Access `Read/Write`

Click **Apply**.

**After the container is running:**

*   The Docker tab's WebUI link opens the visualizer on `http://<unraid-ip>:8080`.
*   Edit `/mnt/user/appdata/thread-network-visualizer/device_names.json` to add friendly names. Refresh browser - no container restart needed.
*   **Updates:** Unraid's Docker tab checks GHCR for a new digest on the `:latest` tag. When you push/merge to `main`, Actions rebuilds `:latest` and Unraid shows "update ready" on the next check.

#### Making the GHCR package public (one-time, after first successful build)

GHCR packages default to **private**. After the first successful Actions run:

1.  Go to `https://github.com/users/TeeJS/packages/container/thread-network-visualizer/settings`.
2.  Scroll to **Danger Zone -> Change visibility -> Public**.
3.  Unraid can now pull without auth.

#### Building locally (optional)

```bash
docker build -t thread-network-visualizer .
docker run --rm -p 8080:8080 -v $(pwd)/appdata:/config thread-network-visualizer
```

## How to Use

### Method A: REST API Discovery
1.  Enter the URL of your Border Router (e.g., `http://10.0.0.1`).
2.  Click **"Start Crawl"**.
3.  The tool will:
    *   Find the Border Router.
    *   Find the Leader.
    *   Issue Diagnostic commands to every router iteratively.
    *   Draw the graph.

### Method B: CLI Drop-in (Offline/Manual)
If the REST API is unavailable or failing:
1.  SSH into your Border Router.
2.  Run the diagnostic command:
    ```bash
    sudo ot-ctl meshdiag topology children ip6-addrs
    ```
3.  Copy the entire output.
4.  In the Visualizer, click the **purple "Import CLI" button**.
5.  Paste the text and click **Visualize!**.

### Controls
*   **Link Filter**: Use the dropdown to hide weak links. This also disables their physics forces, which helps declutter dense meshes.
*   **Export JSON**: Downloads the current `vis.DataSet` content for backup.

## Configuration

### Friendly Names
Rename `device_names.json` (or create it) to map Extended MAC Addresses to readable names:

```json
{
    "b2c9a2836317bc63": "Border Router (Pi)",
    "f4ce368a0s......": "Living Room Sensor"
}
```

## Troubleshooting
*   **"Failed to get data"**: Check the browser console (F12). If you see CORS errors, see "Installation Option 2".
*   **Nodes bunching up**: Try filtering out weak links using the dropdown.

## Credits

Developed with the assistance of **Gemini 3 Pro**, an AI programming assistant.


# iOS Agent Bridge

Control a **real, physical iPhone** from any Model Context Protocol (MCP) client (Claude Code, Antigravity, Claude Desktop, Cursor). Not a simulator, not iPhone Mirroring — the actual device, driven through Apple's native UI-automation channel.

```
Read & reply to messages · launch apps · fill out forms · navigate any app · enter passcodes · tap, swipe, long-press, scroll
```

---

## Why This Works

iOS allows only one sanctioned way to inject hardware and touch events into a physical device: **XCTest / XCUITest**, running as an instrumentation bundle on the phone. [WebDriverAgent](https://github.com/appium/WebDriverAgent) is an open-source XCTest runner that exposes this capability over an HTTP server running directly on the device.

Unlike legacy setups relying on `iproxy` and `usbmuxd` (which broke in iOS 17), **iOS Agent Bridge** is engineered specifically for **iOS 17+**, dynamically detecting Apple's Xcode CoreDevice IPv6 tunnels and auto-recovering sessions when the device sleeps.

```
MCP Client (Claude, Antigravity, Cursor)
    │  stdio (JSON-RPC)
    ▼
iOS Agent Bridge (MCP Server)
    │  HTTP :8100 over CoreDevice IPv6 Tunnel
    ▼
WebDriverAgentRunner (XCTest) on iPhone
    │
    ▼
iOS · SpringBoard · Any Native App
```

---

## The Design Decision: Ref-Based Snapshots

Screen-scraping with raw screenshots forces language models to guess pixel coordinates on high-density Retina displays, leading to hallucinations and inaccurate taps.

Instead, iOS Agent Bridge converts the XCUITest accessibility tree into a **compact, token-efficient outline with stable references**:

| Metric | Raw XCUIElement Tree | `ui_snapshot` Outline |
| ------ | -------------------- | --------------------- |
| Size   | ~800 KB              | **~1.5 KB**           |
| Nodes  | 500+                 | **15–30 actionable**  |
| Tokens | ~180,000             | **~400**              |

```text
Screen Elements (5):
[e1] NavigationBar "Messages" @220,90
[e2] Button "Edit" @52,84
[e3] Cell "Babe❤️, Pinned" @74,185
[e4] TextField "iMessage" value="" @220,908
[e5] Button "Send" @410,908
```

The agent simply calls `ui_tap({ ref: "e5" })`. It never needs to guess coordinates. `ui_screenshot` remains available for visual verification and image-heavy UI.

---

## Prerequisites

- **macOS** with **Xcode 15+** and Command Line Tools (`xcode-select --install`)
- A physical **iPhone** running **iOS 17+** connected via USB
- An **Apple Developer account** (free or paid) for signing the test runner
- **Node.js 20+**

### On your iPhone:

1. Enable **Developer Mode**: **Settings → Privacy & Security → Developer Mode → On** (requires restart).
2. Tap **Trust This Computer** when prompted upon connecting via USB.

---

## Setup & Quick Start

```bash
# 1. Clone repository
git clone https://github.com/your-username/iOS-agent-bridge.git
cd iOS-agent-bridge

# 2. Install dependencies & compile
npm install
npm run build

# 3. Clone WebDriverAgent into vendor/
bash scripts/fetch-wda.sh

# 4. Build, sign, and launch WDA on your iPhone
bash scripts/wda-up.sh
```

> [!TIP]
> `scripts/wda-up.sh` auto-detects your Apple Developer Team ID and Xcode CoreDevice IPv6 address, automatically saving `WDA_BASE_URL` to your `.env` file.

### Environment Variables (`.env`)

Create or update `.env` in the project root:

```env
# Optional: Set device passcode for programmatic screen unlocking
IPHONE_MCP_PASSCODE=123456

# Auto-populated by scripts/wda-up.sh
WDA_BASE_URL=http://[fdfb:d67f:c9de::1]:8100
```

| Variable              | Default       | Description                                                                                                       |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `IPHONE_MCP_PASSCODE` | —             | Device passcode, typed on the on-screen keypad to unlock. Storing it in `.env` keeps it out of conversation logs. |
| `WDA_BASE_URL`        | Auto-detected | Where WebDriverAgent is reachable (CoreDevice IPv6 address or `http://127.0.0.1:8100`).                           |
| `IPHONE_MCP_TEAM_ID`  | Auto-detected | Apple Developer Team ID for code signing WebDriverAgent.                                                          |

---

## MCP Client Configuration

Add the server to your MCP client config (e.g. `claude_desktop_config.json`, `.gemini/antigravity/mcp_config.json`, or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "iphone": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/iOS-agent-bridge/dist/index.js"]
    }
  }
}
```

---

## Tool Suite

All mutating tools accept an optional `snapshot_after: true` parameter to immediately return an updated screen outline in the same turn.

### 📱 Observation

| Tool            | Description                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui_snapshot`   | **The primary tool**. Returns a compact outline of actionable elements with ref tags (`[e1]`, `[e2]`). Supports `query` filtering, `max_nodes`, and `include_offscreen`. |
| `ui_screenshot` | Captures a downscaled PNG image of the screen for visual inspection or non-standard canvas UIs.                                                                          |

### 👆 Action

| Tool            | Description                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ui_tap`        | Tap an element by ref (e.g. `ref: "e5"`).                                                                              |
| `ui_tap_point`  | Coordinate fallback: tap absolute `(x, y)` coordinates in screen points.                                               |
| `ui_long_press` | Press and hold an element by ref for a specified duration (default `1200ms`) to open context menus or edit mode.       |
| `ui_swipe`      | Directional swipe (`up`, `down`, `left`, `right`). Supports scoping to a container `ref` and repeating with `times`.   |
| `ui_type`       | Type text into the focused field, or pass `ref` to auto-focus before typing. Set `submit: true` to press Return/Enter. |

### ⚙️ Device

| Tool                  | Description                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `device_status`       | Health check: reports connectivity to WDA, screen lock state (`deviceLocked`), and foreground application (`activeApp`).                                     |
| `device_open_app`     | Launch an iOS app directly by bundle ID (e.g. `com.apple.MobileSMS`) or common name (`messages`, `safari`, `settings`, `notes`, `photos`, `camera`, `maps`). |
| `device_lock`         | Screen state control: `action: "lock"` (locks screen), `action: "status"` (checks lock state), or `action: "unlock"` (wakes phone and types passcode).       |
| `device_press_button` | Press hardware buttons (`home`, `volumeup`, `volumedown`).                                                                                                   |

---

## App Shortcuts for `device_open_app`

You can open apps by bundle ID or using built-in aliases:

| Alias              | Target Bundle ID              |
| ------------------ | ----------------------------- |
| `messages` / `sms` | `com.apple.MobileSMS`         |
| `safari`           | `com.apple.mobilesafari`      |
| `settings`         | `com.apple.Preferences`       |
| `notes`            | `com.apple.mobilenotes`       |
| `photos`           | `com.apple.mobileslideshow`   |
| `camera`           | `com.apple.camera`            |
| `maps`             | `com.apple.Maps`              |
| `mail`             | `com.apple.mobilemail`        |
| `calendar`         | `com.apple.mobilecal`         |
| `reminders`        | `com.apple.reminders`         |
| `music`            | `com.apple.Music`             |
| `phone`            | `com.apple.mobilephone`       |
| `clock`            | `com.apple.mobiletimer`       |
| `files`            | `com.apple.DocumentsApp`      |
| `weather`          | `com.apple.weather`           |
| `contacts`         | `com.apple.MobileAddressBook` |
| `calculator`       | `com.apple.calculator`        |
| `appstore`         | `com.apple.AppStore`          |

---

## Troubleshooting

- **Phone shows as "unavailable"**: If the device was disconnected or slept for an extended period, reconnect the USB cable and verify Xcode detects the device under **Xcode → Window → Devices and Simulators**.
- **Session 404 error**: iOS kills active XCTest sessions when the phone locks. iOS Agent Bridge automatically detects 404 session expiry and provisions a fresh session on the next call.
- **Passcode screen not unlocking**: Ensure `IPHONE_MCP_PASSCODE` matches your device passcode in `.env`.
- **WDA runner exits**: Re-run `bash scripts/wda-up.sh` to restart the runner. If certificates expired after 7 days (free developer account), run with `FORCE_BUILD=1 bash scripts/wda-up.sh`.

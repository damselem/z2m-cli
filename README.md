# z2m-cli

A command-line interface for [Zigbee2MQTT](https://www.zigbee2mqtt.io/) built with [Bun](https://bun.sh/).

## Features

- List and manage Zigbee devices
- View device states and send commands
- Network diagnostics with automatic issue detection
- Bridge management (restart, permit join, log level)
- Group management
- JSON output for scripting and automation
- Zero external dependencies (except picocolors for terminal colors)

## Installation

```bash
# Clone or copy the project
cd z2m-cli

# Install dependencies
bun install

# Optional: Link globally
bun link
```

## Usage

```bash
# Set your Zigbee2MQTT URL
export Z2M_URL="ws://localhost:8080"
# or
export Z2M_URL="wss://z2m.example.com/api"

# Run commands
bun run bin/z2m-cli.ts <command>

# Or if linked globally
z2m <command>
```

### Options

| Option | Description |
|--------|-------------|
| `-u, --url <url>` | Zigbee2MQTT WebSocket URL |
| `-j, --json` | Output raw JSON |
| `-h, --help` | Show help |

## Commands

### Connection

```bash
z2m test                    # Test connection to Zigbee2MQTT
```

### Devices

```bash
z2m devices                 # List all devices with LQI, battery, last seen
z2m device <name>           # Get device info and current state
z2m device:set <name> <json>  # Send command to device
z2m device:rename <old> <new> # Rename a device
z2m device:remove <name>    # Remove device from network
z2m devices:search <query>  # Search by name/model/vendor
z2m devices:routers         # List only router devices
```

### Groups

```bash
z2m groups                  # List all groups
z2m group <name-or-id>      # Get group details
```

### Bridge

```bash
z2m bridge:info             # Bridge version, channel, coordinator info
z2m bridge:state            # Bridge runtime state
z2m bridge:restart          # Restart the bridge
z2m bridge:permitjoin on    # Enable pairing mode
z2m bridge:permitjoin off   # Disable pairing mode
z2m bridge:permitjoin on 60 # Enable for 60 seconds
z2m bridge:loglevel debug   # Set log level
```

### Network

```bash
z2m network:map             # Get raw network map data
```

### Diagnostics

```bash
z2m diagnose                # Run full network diagnostics
```

## Examples

### List all devices
```bash
$ z2m devices

📡 Zigbee Devices

  Total: 53 (13 routers, 37 end devices)

  Routers:
    Living Room Light                   LQI: 207         just now
    Kitchen Plug                        LQI: 156         2m ago

  End Devices:
    Bedroom Thermostat                  LQI: 83          100%     just now
    Front Door Sensor                   LQI: 120         87%      5m ago
```

### Get device details
```bash
$ z2m device "Kitchen Thermostat"

📱 Kitchen Thermostat

  IEEE Address:  0x0cae5ffffeb0151b
  Type:          EndDevice
  Model:         TRVZB
  Vendor:        SONOFF
  Power Source:  Battery
  Interview:     completed
  Disabled:      no

  State:
    linkquality      83
    battery          49%
    temperature      23.4
    running_state    idle
```

### Control a device
```bash
# Turn on a light
z2m device:set "Living Room Light" '{"state":"ON"}'

# Set brightness
z2m device:set "Living Room Light" '{"state":"ON","brightness":128}'

# Set thermostat temperature
z2m device:set "Bedroom Thermostat" '{"occupied_heating_setpoint":21}'
```

### Run diagnostics
```bash
$ z2m diagnose

🔍 Zigbee Network Diagnostic Report

Summary:
  Devices:    53 (13 routers, 37 end devices)
  Issues:     2 critical, 8 warnings

Issues:

  CRITICAL:
    ● Garage Sensor: Critical signal quality (LQI: 12)
    ● Office Thermostat: Critical battery level (14%)

  WARNINGS:
    ● Hallway Light: Low signal quality (LQI: 36)
    ● Basement Motion: Low battery level (22%)

Low Signal Devices:
  12           Garage Sensor (EndDevice)
  36           Hallway Light (EndDevice)

Low Battery Devices:
  14%      Office Thermostat
  22%      Basement Motion
```

### JSON output for scripting
```bash
# Get all devices as JSON
z2m -j devices > devices.json

# Get diagnostic report as JSON
z2m -j diagnose | jq '.issues[] | select(.severity == "critical")'

# Extract low battery devices
z2m -j diagnose | jq '.devices | map(select(.battery < 25))'
```

## Diagnostic Thresholds

The `diagnose` command automatically flags issues based on these thresholds:

| Issue | Severity | Threshold |
|-------|----------|-----------|
| Interview incomplete | Critical | Device didn't complete Zigbee interview |
| LQI critical | Critical | < 30 |
| LQI low | Warning | < 50 |
| Battery critical | Critical | < 15% |
| Battery low | Warning | < 25% |
| Stale device | Warning | > 7 days (battery devices) |

## API Usage

The Z2MClient can be imported and used programmatically:

```typescript
import { Z2MClient } from 'z2m-cli';

const client = new Z2MClient({
  url: 'wss://z2m.example.com/api',
  timeout: 10000
});

// Get all devices
const devices = await client.getDevices();

// Get device state
const state = await client.getDeviceState('Kitchen Light');

// Send command
await client.setDeviceState('Kitchen Light', { state: 'ON' });

// Run diagnostics
const report = await client.diagnose();
console.log(report.summary);
console.log(report.issues);

// Collect all device states
const states = await client.collectDeviceStates(5000);
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `Z2M_URL` | Zigbee2MQTT WebSocket URL | `ws://localhost:8080` |

## URL Format

The WebSocket URL should point to your Zigbee2MQTT instance:

- Local: `ws://localhost:8080` or `ws://192.168.1.100:8080`
- Remote with TLS: `wss://z2m.example.com/api`
- With explicit path: `ws://localhost:8080/api`

The client automatically:
- Appends `/api` if missing
- Converts `http://` to `ws://` and `https://` to `wss://`

## Building

```bash
# Compile to standalone binary
bun run build

# Output: ./z2m-cli (native executable)
```

## License

MIT
